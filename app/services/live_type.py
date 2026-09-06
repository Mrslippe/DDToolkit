"""直播类型推断引擎（v0.9.x 内容管道 M1）。

用户决策（2026-09-07）：维持 9 类体系（与前端徽章/统计胶囊颜色体系一致），
推断在服务端（多信号可用：标题关键词 + danmakus 直播分区 + 纪念日锚点），
读取时计算不落库（延续「语义纯展示，不落库」定案）。

信号栈优先级：
1. 标题关键词（9 类规则，先命中先得；词序即优先级）
2. 直播分区（area_name > parent_area_name，danmakus 实测字段如
   「虚拟主播/虚拟Singer」「单机游戏/主机游戏」）
3. 纪念日锚点（生日 MM-DD / 出道日 / vtuber_events 当日 → 特殊）
4. 兜底 live（「直播」）

输出 (category, category_from)：category ∈ game/chat/watch/upload/song/
fitness/radio/collab/special/live；category_from ∈ title/area/date/fallback。
"""
from __future__ import annotations

import re
from datetime import datetime

# 分类 key（与前端 utils/liveType.ts 的 LIVE_TYPE_KEY 对齐）
GAME, CHAT, WATCH, UPLOAD, SONG = "game", "chat", "watch", "upload", "song"
FITNESS, RADIO, COLLAB, SPECIAL, LIVE = "fitness", "radio", "collab", "special", "live"

# 标题关键词规则（词序即优先级：特殊/歌回/观影这类特征词优先于游戏等大类）
TITLE_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"生日|周年|纪念|出道|庆典|庆生|新春|圣诞|跨年|新年|首播|毕业|告别|收官|终演|演唱会特辑", re.I), SPECIAL),
    (re.compile(r"歌回|唱歌|歌会|翻唱|音乐|演唱会|开嗓|练歌|歌单|唱见|卡拉OK|卡拉ok|歌杂|唱歌回", re.I), SONG),
    (re.compile(r"观影|看番|追番|补番|电影|番剧|剧场|影视|看片|一起看|假面骑士|奥特曼|特摄|追剧|看剧|综艺|动画", re.I), WATCH),
    (re.compile(r"联动|合作|嘉宾|连麦|合唱|客串|双人|三人|联动回", re.I), COLLAB),
    (re.compile(r"健身|锻炼|减肥|瘦身|瑜伽|运动|帕梅拉|拉伸|跳操", re.I), FITNESS),
    (re.compile(r"电台|asmr|ASMR|晚安|伴睡|陪聊|谈心|哄睡|助眠|朗读|轻音乐", re.I), RADIO),
    (re.compile(r"杂谈|闲聊|聊天|随聊|漫谈|杂谈回|棉花糖|茶话会|读评论|读信|来信|深夜聊", re.I), CHAT),
    (re.compile(r"游戏|电竞|开黑|游玩|steam|Steam|原神|崩坏|绝区|星穹|瓦罗兰特|lol|LOL|英雄联盟|minecraft|我的世界|黑神话|悟空|蛋仔|明日方舟|鸣潮|王者荣耀|王者|吃鸡|绝地求生|dota|DOTA|csgo|apex|APEX|博德之门|老头环|艾尔登法环|塞尔达|王国之泪|双人成行|双影奇境|猛兽派对|糖豆人|永劫无间|对马岛|刺客信条|赛博朋克|2077|大镖客|巫师|单机|周目|通关|开荒|副本|抽卡|新版本|实机|试玩", re.I), GAME),
    (re.compile(r"投稿|剪辑|新作|作品|pv|PV|预告|曝光|公开|新歌发布", re.I), UPLOAD),
]

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


def _by_title(title: str | None) -> tuple[str, str] | None:
    t = (title or "").strip()
    if not t:
        return None
    for re_rule, key in TITLE_RULES:
        if re_rule.search(t):
            return key, "title"
    return None


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


def infer_category(title: str | None, area_name: str | None = None,
                   parent_area_name: str | None = None,
                   start_at: datetime | None = None,
                   birthday: str | None = None, debut_date: str | None = None,
                   event_dates=()) -> tuple[str, str]:
    """推断场次类型。返回 (category, category_from)。"""
    hit = _by_title(title)
    if hit:
        return hit
    hit = _by_area(area_name, parent_area_name)
    if hit:
        return hit
    if _is_special_date(start_at, birthday, debut_date, event_dates):
        return SPECIAL, "date"
    return LIVE, "fallback"
