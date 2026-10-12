"""直播类型推断引擎 v2（v0.9.x 内容管道 M4+）。

用户决策（2026-09-07）：维持 9 类体系（与前端徽章/统计胶囊颜色体系一致），
推断在服务端（多信号可用：标题关键词 + danmakus 直播分区 + 纪念日锚点）。
⚠️ 2026-10-12（T3）：**「健身」换成「助眠」**（用户口径「沿用现有的 10 类，但健身删掉，
换成助眠」）；同批类型改成**写时定稿**（`app/services/live_settle.py`），
读取时 `series`/`learned` 两档已下线（它们要看全账号历史，与"只看这一场"冲突）。

v2 多信号带权评分（user 2026-09-07 需求：虚拟日常分区万金油，
单靠分区/首个关键词不可靠 → 标题多词评分 + 系列聚类 + 用户校正闭环）：

信号栈优先级（category_from 同义）：
1. override   用户校正（live_category_overrides，(account_id, live_id) 唯一）
2. series     系列聚类（同账号标题骨架相同的场次组，聚合投票 + 校正投票；
               作用：一场校正 → 整系列传播；标题残缺场次按系列归类）
               ⚠️ **2026-10-12 起不再用于落库与读取**（见 `live_settle` 模块头）
3. title      标题多词评分（词条带权：强特征 ≥2.5 单发即自信；
               并列同分按 TITLE_CATEGORY_PRIORITY 兜底）
4. learned    校正反哺词库（被校正标题的词条 → 该账号对应分类加权）
               ⚠️ 同上，2026-10-12 起不再用于落库与读取
5. area       直播分区（area_name > parent_area_name）
6. date       纪念日锚点（生日 MM-DD / 出道日 / vtuber_events 当日 → special）
7. fallback   live（「直播」）

输出 (category, category_from)：category ∈ game/chat/watch/upload/song/
sleep/radio/collab/special/live；category_from ∈ override/series/title/
learned/area/date/fallback。
"""
from __future__ import annotations

import re
from datetime import datetime

# 分类 key（与前端 utils/liveType.ts 的 LIVE_TYPE_KEY 对齐）
GAME, CHAT, WATCH, UPLOAD, SONG = "game", "chat", "watch", "upload", "song"
# ⚠️ `SLEEP`（助眠）**取代**了原来的 `FITNESS`（健身）—— 2026-10-12 T3，用户口径
# 「沿用现有的 10 类，但健身删掉，换成助眠」。判据：`tests/test_vtuber_api.py::
# test_frontend_type_keys_match_backend_taxonomy`（前后端两份表必须同集）。
# ⚠️ `THREED`（3D）是**新加的第 11 类** —— 2026-10-12，用户口径「加一个 3D 类型，
# 主要指 **3D 形式呈现**直播的场次」。它答的是"**用什么形式演**"，与"演什么"
# （歌回/游戏/杂谈）正交 ⇒ 优先级要显式定（见 `TITLE_CATEGORY_PRIORITY`）。
THREED = "3d"
SLEEP, RADIO, COLLAB, SPECIAL, LIVE = "sleep", "radio", "collab", "special", "live"

CATEGORY_KEYS = frozenset({GAME, CHAT, WATCH, UPLOAD, SONG,
                           THREED, SLEEP, RADIO, COLLAB, SPECIAL, LIVE})
# 用户可校正的分类（不含 live 兜底——校正「直播」无意义）
EDITABLE_CATEGORY_KEYS = CATEGORY_KEYS - {LIVE}

#: 展示顺序（T4，2026-10-12）：按类型统计的卡片/筛选项都按它排。
#: ⚠️ **必须与前端 `frontend/src/utils/liveType.ts::LIVE_TYPE_ORDER` 同序** ——
#: 两边各有一份（前端要能独立渲染骨架屏），顺序漂了会让"卡片上的柱子次序"
#: 与"筛选条里的胶囊次序"对不上，而那种错只有肉眼能发现。
#: 兜底 `live` **不在**这个序列里（永远排最后，见 `routers/vtuber.py::live_type_stats`）。
#: `3d` 排在**最后**（与 `TITLE_CATEGORY_PRIORITY` 里"形式让位于内容"相反）：
#: 它是"特别的形式"，混在内容类目中间会让"杂谈→游戏→3D→观影"这种排法读起来没有线索。
TYPE_DISPLAY_ORDER: tuple[str, ...] = (CHAT, GAME, WATCH, UPLOAD, SONG,
                                       SLEEP, RADIO, COLLAB, SPECIAL, THREED)

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
    # ⚠️ 2026-10-12 新加：**3D 形式**（用户口径「3D 形式呈现直播的场次」）。
    # 权重 4.0 是量出来的：真机 705 条含 `3d` 的标题里绝大多数**只有这一个信号**
    # （`【3D】红豆来咯`、`家用3d的健身鹮`），3.0 会被 `_confident`（要求领先 ≥1.0）
    # 判成不自信 ⇒ 全部落回分区/兜底，等于白加。
    # ⚠️ **刻意没有收的**：`mmd` / `模型`（单字太泛，会误伤「模型拼装」这类手工直播）、
    # `3d眩晕` 一类**不是 3D 直播**的用法（由 `_THREED_EXCLUDE` 显式排除）。
    THREED: {
        "3d": 4.0,
    },
    SONG: {
        "歌回": 3.0, "歌会": 3.0, "唱歌回": 3.0, "歌杂": 3.0, "歌单": 3.0, "翻唱": 3.0,
        "唱歌": 2.5, "开嗓": 2.5, "唱见": 2.5, "卡拉ok": 2.5, "演唱会": 2.5, "音乐": 1.5,
    },
    WATCH: {
        "观影": 3.0, "看番": 3.0, "追番": 3.0, "补番": 3.0, "电影": 3.0, "番剧": 3.0,
        "影视": 3.0, "看片": 3.0, "一起看": 3.0, "追剧": 3.0, "看剧": 3.0,
        "剧场": 2.5, "综艺": 2.5, "动画": 2.0, "假面骑士": 2.5, "奥特曼": 2.5, "特摄": 2.5,
        # ⚠️ 2026-10-12（用户修正边界）：「**或者视频、投稿等主要以观看视频为主体**的
        # 直播内容」⇒ 把"看别人的东西"这一族收进来。实测命中：
        # 看视频 19 · 一起看 106 · 二创 23 · 看投稿 3 · 切片 3。
        # ⚠️ `投稿回`/`看投稿` 与 `UPLOAD` 的 `投稿`（3.0）**必然平分**，靠
        # `TITLE_CATEGORY_PRIORITY` 里 WATCH 排在 UPLOAD 前面打破 —— 这是有意的：
        # 「看投稿」是**看**，`upload` 留给"放自己的新作/预告"。
        "看投稿": 3.0, "投稿回": 3.0, "看视频": 3.0, "二创": 2.5, "切片": 2.0,
    },
    COLLAB: {
        "联动回": 3.5, "联动": 3.0, "合作": 3.0, "嘉宾": 3.0, "连麦": 3.0, "合唱": 3.0,
        "客串": 3.0, "双人": 1.5, "三人": 1.5, "多人": 1.5,
    },
    # ⚠️ 2026-10-12（T3）：`FITNESS` 换成了 `SLEEP`（助眠）。**只收语义确定的词** ——
    # 真机 8,515 条有标题的场次里，明确指向助眠的词（助眠/哄睡/白噪音/ASMR/音声/伴睡/
    # 耳骚/冥想）**一次都没出现**，也就是说这几个词是"备着"的、今天命中 0 条。
    # ⚠️ 故意**不收**的几类（都量过，见 docs/plans/live-type-sleep-terms.md）：
    #   · 「工作音」28 条 → 实测那批是 `【工作音】学歌（1-5）` 这类**陪伴学歌**直播，
    #     加了它只会与 `song`（学歌回/歌回）抢票，并不会真的把它们判成助眠；
    #   · 「晚安」6 条 / 「早睡」7 条 / 「睡」75 条 → 多数是"聊到睡"的杂谈与下播告别
    #     （`聊一会会儿睡！`、`通宵没睡低气压碎碎念中……`），收了会把判对的场次改错。
    # 要收哪些词是**用户过目项**（T3 的开放问题），改这一处即可。
    SLEEP: {
        "助眠": 3.0, "哄睡": 3.0, "白噪音": 3.0, "asmr": 3.0, "音声": 2.5,
        "伴睡": 3.0, "耳骚": 3.0, "冥想": 2.5,
    },
    RADIO: {
        # ⚠️ 2026-10-12（T3）：`asmr`/`伴睡`/`哄睡`/`助眠` 四个词**搬去了 SLEEP** ——
        # 留在两边会让同一串标题同时命中两类、`_confident`（要求领先 1.0）判不出自信，
        # 于是「助眠」「哄睡」这种**最该判对**的标题反而落回中性。
        # 实测（分离前）：`score_title("助眠")` → `{sleep: 3.0, radio: 3.0}` ⇒ 兜底。
        # 留在电台的是**节目感**那一组：电台 / 陪聊 / 谈心 / 朗读 / 轻音乐。
        "电台": 3.0, "陪聊": 3.0, "谈心": 3.0, "朗读": 2.5, "轻音乐": 2.0,
        # `晚安` 留在电台：真机 6 条命中里，`晚安提问箱喵`（提问箱=杂谈）、
        # 下播告别那几条都不是助眠内容（见 docs/plans/live-type-sleep-terms.md）。
        "晚安": 3.0,
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

# 并列同分兜底顺序（v1 顺序 + 2026-10-12 新加的 3D）：
# 特殊 > **3D** > 歌回 > 观影 > 联动 > 助眠 > 电台 > 杂谈 > 游戏 > 投稿
#
# ⚠️ `3d` 的位置是**有意的、也是可争议的**（用户 2026-10-12 拍板"先看看效果"）：
# 它答的是"**用什么形式演**"，与其他类目（"演什么"）正交 ⇒ 必然要与它们抢票。
# 现在的取舍：
#   · **低于 `special`** —— 「3D 生日会」首先是**生日**（一年一次的事件），形式是次要信息；
#   · **高于 `song`/`game`/`watch`/`chat`** —— 「家用3d歌回」「3d杂谈」按**形式**归档
#     （用户的诉求是"能一眼看出哪些是 3D 场次"）。
# 真机交叠量（705 条含 3d 的标题）：special 52 · chat 17 · song 10 · game 6 · watch 4 · collab 2。
TITLE_CATEGORY_PRIORITY: tuple[str, ...] = (
    SPECIAL, THREED, SONG, WATCH, COLLAB, SLEEP, RADIO, CHAT, GAME, UPLOAD,
)

#: `3D` 词条的**显式排除**（子串里带这些的不算 3D 直播）。
#: 真机实测：`晕3d了谢会sc` 这种"游戏晕 3D"会被裸 `3d` 命中 ⇒ 判成 3D 直播是错的。
#: 另排除 `3ds`（掌机）与 `3d眩晕`。命中任一 ⇒ **整个 `3d` 词条不计票**。
_THREED_EXCLUDE = ("晕3d", "3d晕", "3ds", "3d眩晕", "3d晕")

# 校正投票权重：一场校正 > 单场强词（3.0）+；可改写系列聚合但弱于多数派
SERIES_OVERRIDE_VOTE = 4.0
# 学习词库单票：命中词条数加权（LEARNED_VOTE × 词条命中数），可撬动歧义标题
LEARNED_VOTE = 2.0
# 系列最小成员数（避免两篇同名残响误聚合）
MIN_SERIES_MEMBERS = 2

# 分区映射（子串命中；area_name 优先，其次 parent_area_name）
# 顺序：特异分区在前（虚拟Singer→歌回），游戏/杂谈类宽匹配在后
AREA_RULES: list[tuple[str, list[str]]] = [
    # ⚠️ 2026-10-12：`3D虚拟主播` 排**最前**（真机 24 条）—— 分区名里直接写着 3D，
    # 比"虚拟Singer/Gamer"这类内容分区更特异；同一条标题若同时挂 `虚拟Singer`，
    # 由标题评分决定（`3d歌回` → 3d 因为 TITLE_CATEGORY_PRIORITY 在 song 之前）。
    (THREED, ["3d虚拟"]),
    (SONG, ["虚拟singer", "虚拟歌", "唱歌", "音乐", "演唱会", "歌舞", "唱见", "乐器"]),
    (GAME, ["虚拟gamer", "主机游戏", "单机游戏", "网络游戏", "手机游戏", "手游", "网游", "游戏"]),
    (WATCH, ["剧场", "影视", "电影", "番剧", "放映"]),
    # ⚠️ 2026-10-12（T3）：这一行原来是 `(FITNESS, ["健身", "运动", "体育", "舞蹈"])`。
    # 健身类分区在真机上**不存在**（没有主播挂那种分区），而分区那一路的宽匹配
    # （"运动"这个词）会把「运动」类直播拉进一个已经删掉的类目 ⇒ 直接删掉整行，
    # 让它们落回 `CHAT` 的默认分区档（虚拟日常/日常/娱乐…）或中性兜底。
    # 助眠那一条**从 RADIO 挪过来**（原来 `助眠`/`asmr` 挂在电台下）：分区里出现这两个词
    # 时语义就是助眠，挂在电台下等于永远判错。
    (SLEEP, ["助眠", "asmr", "白噪音", "哄睡"]),
    (RADIO, ["电台", "朗读"]),
    (CHAT, ["聊天室", "知识", "虚拟日常", "日常", "生活", "娱乐", "情感", "杂谈",
            "talk", "资讯", "户外", "美食", "料理", "绘画", "画画", "手工", "才艺", "教育", "学习"]),
]

# 标题骨架清洗的规则与 `normalize_title` 本身都**下沉到 domain** 了（M1a，devlog/213）：
# 仓库层做场次合并时也要用同一个骨架，而 repositories 不许 import services（反向边）。
# 这里保留同名再导出只是**兼容**（同一个对象，不是副本）——新代码请从 `app.domain.text` 取。
from app.domain.text import normalize_title  # noqa: F401  （再导出；见上）


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
        # ⚠️ 3D 的**显式排除**（2026-10-12）：`晕3d了谢会sc` 这类被裸 `3d` 命中的标题
        # 不是 3D 直播（那是"游戏晕 3D"）⇒ 命中 `_THREED_EXCLUDE` 时整个词条不计票。
        if cat == THREED and any(x in t for x in _THREED_EXCLUDE):
            continue
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


def _pick(cands: list[str]) -> str:
    """并列候选里按 `TITLE_CATEGORY_PRIORITY` 定胜负（不在表里的退回第一个）。"""
    for c in TITLE_CATEGORY_PRIORITY:
        if c in cands:
            return c
    return cands[0]


def _argmax(scores: dict[str, float]) -> str | None:
    if not scores:
        return None
    best = max(scores.values())
    return _pick([c for c, w in scores.items() if w == best])


def _ranked_groups(scores: dict[str, float]) -> list[tuple[str, float]]:
    """把得分按**档**聚起来：`[(代表类目, 该档得分), …]`，从高到低。

    为什么不是逐类排序：并列的两类**有 `TITLE_CATEGORY_PRIORITY` 兜底** ⇒ 它们是
    "一档"，不是两个竞争项。⚠️ 这一条是 2026-10-12 施工时踩出来的：
    `_argmax` 会用优先级打破平分，而 `_confident` 原来按"逐类相邻差 ≥1.0"判 ——
    于是**有优先级也白搭**：`哇哈哈边看投稿边聊天`（watch 3.0 = upload 3.0，
    优先级明写 watch 在前）被判成"分歧太大"⇒ 落回中性兜底。
    """
    by_score: dict[float, list[str]] = {}
    for cat, w in scores.items():
        by_score.setdefault(w, []).append(cat)
    return [(_pick(cands), score)
            for score, cands in sorted(by_score.items(), reverse=True)]


def _confident(scores: dict[str, float]) -> bool:
    """自信判定：强词（≥2.5）单发即自信；**跨档**差距 < 1.0 才叫分歧。

    "跨档" = 并列同分的那些类目算一档（它们由 `TITLE_CATEGORY_PRIORITY` 定胜负，
    不是分歧）。见 `_ranked_groups` 的说明。
    """
    groups = _ranked_groups(scores)
    if not groups:
        return False
    _top, best = groups[0]
    if best < 2.5:
        return False
    if len(groups) == 1:
        return True
    return best - groups[1][1] >= 1.0


# ── 系列聚类 ─────────────────────────────────────────────────────
# （`normalize_title` 的定义已下沉到 `app/domain/text.py`，本文件顶部再导出）

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
