"""直播类型推断引擎 v2（v0.9.x 内容管道 M4+）。

用户决策（2026-09-07）：维持 9 类体系（与前端徽章/统计胶囊颜色体系一致），
推断在服务端（多信号可用：标题关键词 + danmakus 直播分区 + 纪念日锚点），
读取时计算不落库（延续「语义纯展示，不落库」定案）。

v2 多信号带权评分（user 2026-09-07 需求：虚拟日常分区万金油，
单靠分区/首个关键词不可靠 → 标题多词评分 + 系列聚类 + 用户校正闭环）：

信号栈优先级（category_from 同义）：
1. override   用户校正（live_category_overrides，(account_id, live_id) 唯一）
2. series     系列聚类（同账号标题骨架相同的场次组，聚合投票 + 校正投票；
               作用：一场校正 → 整系列传播；标题残缺场次按系列归类）
3. title      标题多词评分（词条带权：强特征 ≥2.5 单发即自信；
               并列同分按 TITLE_CATEGORY_PRIORITY 兜底）
4. learned    校正反哺词库（被校正标题的词条 → 该账号对应分类加权）
5. area       直播分区（area_name > parent_area_name）
6. date       纪念日锚点（生日 MM-DD / 出道日 / vtuber_events 当日 → special）
7. fallback   live（「直播」）

输出 (category, category_from)：category ∈ game/chat/watch/upload/song/
fitness/radio/collab/special/live；category_from ∈ override/series/title/
learned/area/date/fallback。
"""
from __future__ import annotations

import re
from datetime import datetime

# 分类 key（与前端 utils/liveType.ts 的 LIVE_TYPE_KEY 对齐）
GAME, CHAT, WATCH, UPLOAD, SONG = "game", "chat", "watch", "upload", "song"
FITNESS, RADIO, COLLAB, SPECIAL, LIVE = "fitness", "radio", "collab", "special", "live"

CATEGORY_KEYS = frozenset({GAME, CHAT, WATCH, UPLOAD, SONG,
                           FITNESS, RADIO, COLLAB, SPECIAL, LIVE})
# 用户可校正的分类（不含 live 兜底——校正「直播」无意义）
EDITABLE_CATEGORY_KEYS = CATEGORY_KEYS - {LIVE}

# 标题词条表：词 → 权重。
# 权重语义：强特征词（≥2.5）单发即自信（如 歌回/杂谈/联动/观影）；
# 泛词（1.5-2.0）只参与聚合，命中单个不自信（落到系列/分区/学习词库）。
# 特殊（5.0）刻意压过一切：纪念日/周年/首播等是覆盖性事件（旧规则同款语义）。
TITLE_TERMS: dict[str, dict[str, float]] = {
    SPECIAL: {
        "生日": 5.0, "周年": 5.0, "纪念": 5.0, "出道": 5.0, "庆典": 5.0, "庆生": 5.0,
        "新春": 5.0, "圣诞": 5.0, "跨年": 5.0, "新年": 5.0, "首播": 5.0, "毕业": 5.0,
        "告别": 5.0, "收官": 5.0, "终演": 5.0, "演唱会特辑": 5.0,
    },
    SONG: {
        "歌回": 3.0, "歌会": 3.0, "唱歌回": 3.0, "歌杂": 3.0, "歌单": 3.0, "翻唱": 3.0,
        "唱歌": 2.5, "开嗓": 2.5, "唱见": 2.5, "卡拉ok": 2.5, "演唱会": 2.5, "音乐": 1.5,
    },
    WATCH: {
        "观影": 3.0, "看番": 3.0, "追番": 3.0, "补番": 3.0, "电影": 3.0, "番剧": 3.0,
        "影视": 3.0, "看片": 3.0, "一起看": 3.0, "追剧": 3.0, "看剧": 3.0,
        "剧场": 2.5, "综艺": 2.5, "动画": 2.0, "假面骑士": 2.5, "奥特曼": 2.5, "特摄": 2.5,
    },
    COLLAB: {
        "联动回": 3.5, "联动": 3.0, "合作": 3.0, "嘉宾": 3.0, "连麦": 3.0, "合唱": 3.0,
        "客串": 3.0, "双人": 1.5, "三人": 1.5, "多人": 1.5,
    },
    FITNESS: {
        "健身": 3.0, "锻炼": 3.0, "减肥": 3.0, "瘦身": 3.0, "瑜伽": 3.0, "帕梅拉": 3.0,
        "拉伸": 3.0, "跳操": 3.0, "运动": 2.0, "舞蹈": 2.0,
    },
    RADIO: {
        "电台": 3.0, "asmr": 3.0, "晚安": 3.0, "伴睡": 3.0, "陪聊": 3.0, "谈心": 3.0,
        "哄睡": 3.0, "助眠": 3.0, "朗读": 2.5, "轻音乐": 2.0,
    },
    CHAT: {
        "杂谈": 3.0, "闲聊": 3.0, "随聊": 3.0, "漫谈": 3.0, "棉花糖": 3.0, "茶话会": 3.0,
        "读评论": 3.0, "读信": 3.0, "深夜聊": 3.0, "聊天": 2.0, "来信": 2.0,
    },
    GAME: {
        "游戏": 2.5, "电竞": 2.5, "开黑": 2.5, "通关": 2.5, "上分": 2.5, "开荒": 2.5,
        "试玩": 2.5, "抽卡": 2.5, "单机": 2.5, "周目": 2.5, "新版本": 2.0,
        "原神": 2.5, "崩坏": 2.5, "绝区": 2.5, "星穹": 2.5, "瓦罗兰特": 2.5, "lol": 2.5,
        "英雄联盟": 2.5, "minecraft": 2.5, "我的世界": 2.5, "黑神话": 2.5, "悟空": 2.0,
        "蛋仔": 2.5, "明日方舟": 2.5, "鸣潮": 2.5, "王者荣耀": 2.5, "王者": 2.0,
        "吃鸡": 2.5, "绝地求生": 2.5, "dota": 2.5, "csgo": 2.5, "apex": 2.5,
        "博德之门": 2.5, "老头环": 2.5, "艾尔登法环": 2.5, "塞尔达": 2.5, "王国之泪": 2.5,
        "双人成行": 2.5, "双影奇境": 2.5, "猛兽派对": 2.5, "糖豆人": 2.5, "永劫无间": 2.5,
        "对马岛": 2.5, "刺客信条": 2.5, "赛博朋克": 2.5, "大镖客": 2.5, "巫师": 2.0,
        "steam": 2.0, "游玩": 1.5, "副本": 2.0,
    },
    UPLOAD: {
        "投稿": 3.0, "剪辑": 3.0, "新作": 3.0, "作品": 2.5, "预告": 3.0, "曝光": 3.0,
        "公开": 2.5, "新歌发布": 3.0, "pv": 2.5,
    },
}

# 并列同分兜底顺序（与 v1 规则顺序一致：特殊 > 歌回 > 观影 > 联动 > 健身 > 电台 >
# 杂谈 > 游戏 > 投稿）
TITLE_CATEGORY_PRIORITY: tuple[str, ...] = (
    SPECIAL, SONG, WATCH, COLLAB, FITNESS, RADIO, CHAT, GAME, UPLOAD,
)

# 校正投票权重：一场校正 > 单场强词（3.0）+；可改写系列聚合但弱于多数派
SERIES_OVERRIDE_VOTE = 4.0
# 学习词库单票：命中词条数加权（LEARNED_VOTE × 词条命中数），可撬动歧义标题
LEARNED_VOTE = 2.0
# 系列最小成员数（避免两篇同名残响误聚合）
MIN_SERIES_MEMBERS = 2

# 分区映射（子串命中；area_name 优先，其次 parent_area_name）
# 顺序：特异分区在前（虚拟Singer→歌回），游戏/杂谈类宽匹配在后
AREA_RULES: list[tuple[str, list[str]]] = [
    (SONG, ["虚拟singer", "虚拟歌", "唱歌", "音乐", "演唱会", "歌舞", "唱见", "乐器"]),
    (GAME, ["虚拟gamer", "主机游戏", "单机游戏", "网络游戏", "手机游戏", "手游", "网游", "游戏"]),
    (WATCH, ["剧场", "影视", "电影", "番剧", "放映"]),
    (FITNESS, ["健身", "运动", "体育", "舞蹈"]),
    (RADIO, ["电台", "朗读", "助眠", "asmr"]),
    (CHAT, ["聊天室", "知识", "虚拟日常", "日常", "生活", "娱乐", "情感", "杂谈",
            "talk", "资讯", "户外", "美食", "料理", "绘画", "画画", "手工", "才艺", "教育", "学习"]),
]

# 标题骨架清洗：仅剥离日期/时间/序号词汇，保留主题词（【歌回】周一 → 歌回）
_SKELETON_STRIP_RE = re.compile(
    r"第\d+[期场回次弹]|"
    r"\d{4}年\d{1,2}月\d{1,2}(?:日|号)?|"
    r"\d{1,2}月\d{1,2}(?:日|号)?|"
    r"\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|"
    r"\d{1,2}:\d{2}|"
    r"\d{1,2}点(?:半)?|"
    r"周[一二三四五六日天]|星期[一二三四五六日天]|\d+"
)
# 骨架仅保留中日韩 + 字母数字
_SKELETON_KEEP_RE = re.compile(r"[\u4e00-\u9fffa-z0-9]")


# ── 标题多词评分 ─────────────────────────────────────────────────

def score_title(title: str | None) -> dict[str, float]:
    """标题 → 各分类得分（命中的非嵌套词条权重和；词长降序去嵌套）。

    同一分类内的嵌套命中只保留最长词条（联动回 3.5 计一次，不叠加联动 3.0），
    跨分类嵌套保留（演唱会特辑 special 5.0 vs 演唱会 song 2.5 → special）。
    """
    t = (title or "").lower()
    if not t:
        return {}
    out: dict[str, float] = {}
    for cat, terms in TITLE_TERMS.items():
        spans: list[tuple[int, int, float]] = []
        for term, w in terms.items():
            idx = 0
            while True:
                i = t.find(term, idx)
                if i < 0:
                    break
                spans.append((i, i + len(term), w))
                idx = i + len(term)
        if not spans:
            continue
        spans.sort(key=lambda s: (s[1] - s[0], -s[0]), reverse=True)
        kept: list[tuple[int, int, float]] = []
        for s in spans:
            if any(k[0] <= s[0] and s[1] <= k[1] for k in kept):
                continue
            kept.append(s)
        out[cat] = sum(w for _s, _e, w in kept)
    return out


def _argmax(scores: dict[str, float]) -> str | None:
    if not scores:
        return None
    best = max(scores.values())
    cands = [c for c, w in scores.items() if w == best]
    if len(cands) == 1:
        return cands[0]
    for c in TITLE_CATEGORY_PRIORITY:
        if c in cands:
            return c
    return cands[0]


def _confident(scores: dict[str, float]) -> bool:
    """自信判定：强词（≥2.5）单发即自信；多词并列分歧（margin < 1.0）不自信。"""
    if not scores:
        return False
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    best = ranked[0][1]
    if best < 2.5:
        return False
    if len(ranked) == 1:
        return True
    return best - ranked[1][1] >= 1.0


# ── 系列聚类 ─────────────────────────────────────────────────────

def normalize_title(title: str | None) -> str:
    """标题 → 系列骨架：剥离日期/时间/序号/标点/emoji，只留主题词。

    「【歌回】周一 XX:00 第12期」 → 「歌回」；「晚上好！」 → 「晚上好」。
    骨架过短（<2 字符）或无内容 → ""（不参与系列）。
    """
    t = (title or "").strip().lower()
    if not t:
        return ""
    t = _SKELETON_STRIP_RE.sub("", t)
    return "".join(_SKELETON_KEEP_RE.findall(t))


def plan_series(sessions, overrides=None) -> dict[str, str]:
    """系列聚类 → {骨架: 分类}。

    - 按 normalize_title 骨架分桶（同账号、全历史）；桶成员 ≥2 才成系列；
    - 聚合票 = 各成员标题评分之和 + 校正投票（SERIES_OVERRIDE_VOTE × N，
      一场校正 → 整系列传播，如「晚上好」×N 被校正一场即全系列改判）；
    - 聚合自信（同 _confident）才作为系列分类。
    - sessions：merged() 行（含 live_title/live_id）；overrides：{live_id: category}。
    """
    groups: dict[str, list[dict]] = {}
    for s in sessions:
        sk = normalize_title(s.get("live_title"))
        if len(sk) < 2:
            continue
        groups.setdefault(sk, []).append(s)
    out: dict[str, str] = {}
    for sk, members in groups.items():
        if len(members) < MIN_SERIES_MEMBERS:
            continue
        agg: dict[str, float] = {}
        for m in members:
            for c, w in score_title(m.get("live_title")).items():
                agg[c] = agg.get(c, 0.0) + w
            lid = m.get("live_id")
            if overrides and lid and lid in overrides:
                oc = overrides[lid]
                agg[oc] = agg.get(oc, 0.0) + SERIES_OVERRIDE_VOTE
        cat = _argmax(agg)
        if cat and _confident(agg):
            out[sk] = cat
    return out


# ── 校正反哺词库 ─────────────────────────────────────────────────

def build_learned(overrides, sessions) -> dict[str, dict[str, float]]:
    """校正 → 账号词库：{分类: {词: 权重}}。

    被校正场次的标题中命中的所有词条 → 校正分类（用户明确表达
    「这类词=这个分类」）；其他场次命中同词时经 learned 源生效。
    """
    title_by_live: dict[str, str | None] = {}
    for s in sessions:
        lid = s.get("live_id")
        if lid:
            title_by_live[lid] = s.get("live_title")
    learned: dict[str, dict[str, float]] = {}
    for lid, cat in (overrides or {}).items():
        title = title_by_live.get(lid)
        if not title:
            continue
        tl = title.lower()
        terms = {term for cmap in TITLE_TERMS.values() for term in cmap if term in tl}
        for term in terms:
            bucket = learned.setdefault(cat, {})
            bucket[term] = bucket.get(term, 0.0) + LEARNED_VOTE
    return learned


def _learned_hit(learned: dict[str, dict[str, float]] | None, title: str | None) -> str | None:
    if not learned or not title:
        return None
    t = title.lower()
    scores: dict[str, float] = {}
    for cat, terms in learned.items():
        for term, w in terms.items():
            if term in t:
                scores[cat] = scores.get(cat, 0.0) + w
    cat = _argmax(scores)
    if cat and _confident(scores):
        return cat
    return None


# ── 分区 / 纪念日（v1 保留） ─────────────────────────────────────

def _by_area(area_name: str | None, parent_area_name: str | None) -> tuple[str, str] | None:
    hay = f"{area_name or ''} {parent_area_name or ''}".lower()
    hay = re.sub(r"\s+", " ", hay).strip()
    if not hay:
        return None
    for key, words in AREA_RULES:
        for w in words:
            if w.lower() in hay:
                return key, "area"
    return None


def _is_special_date(start_at: datetime | None, birthday: str | None,
                     debut_date: str | None, event_dates) -> bool:
    """纪念日锚点：生日 MM-DD / 出道日 YYYY-MM-DD（仅年份则无锚）/ 手动事件当日。"""
    if start_at is None:
        return False
    md = start_at.strftime("%m-%d")
    if birthday and birthday.strip()[:5] == md:
        return True
    if debut_date and len(debut_date.strip()) == 10 and debut_date.strip()[5:] == md:
        return True
    d = start_at.strftime("%Y-%m-%d")
    return d in set(event_dates or ())


# ── 推断入口 ─────────────────────────────────────────────────────

def infer_category(title: str | None, area_name: str | None = None,
                   parent_area_name: str | None = None,
                   start_at: datetime | None = None,
                   birthday: str | None = None, debut_date: str | None = None,
                   event_dates=(),
                   *,
                   live_id: str | None = None,
                   overrides: dict[str, str] | None = None,
                   series_categories: dict[str, str] | None = None,
                   learned: dict[str, dict[str, float]] | None = None) -> tuple[str, str]:
    """推断场次类型。返回 (category, category_from)。

    信号栈：override > series > title > learned > area > date > fallback。
    live_id/overrides/series_categories/learned 为 v2 新增（可选，缺省回退 v1 行为）。
    """
    if overrides and live_id and live_id in overrides:
        return overrides[live_id], "override"
    sk = normalize_title(title)
    if series_categories and len(sk) >= 2 and sk in series_categories:
        return series_categories[sk], "series"
    scores = score_title(title)
    cat = _argmax(scores)
    if cat and _confident(scores):
        return cat, "title"
    hit = _learned_hit(learned, title)
    if hit:
        return hit, "learned"
    hit = _by_area(area_name, parent_area_name)
    if hit:
        return hit
    if _is_special_date(start_at, birthday, debut_date, event_dates):
        return SPECIAL, "date"
    return LIVE, "fallback"
