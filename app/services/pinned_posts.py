"""置顶动态的纯判定逻辑（R35，devlog/139）。

放在独立模块的理由：这里是**零 IO 的判定**（时间窗口、字段取舍），可以直接单测；
`services/scheduler.py` 的置顶分支只负责取数、按需调详情、交回字典落库。

用户口径（2026-09-17）：「有些 v 会将动态置顶来展示周表或舰礼相关的内容，所以将
抓取到的置顶动态同样置顶，并且每日的动态轮询都覆盖它，保证修改及时被捕捉到」。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from app.services.post_text import extract_post_text

# feed 级字段：列表页响应自带，置顶帖每轮都能免费刷新（标题/摘要/封面/互动数改动
# 在一个轮询周期内落地，零额外请求）
FEED_FIELDS = ("title", "summary", "cover_url", "stats_json")

# 详情级字段：必须额外请求详情接口才拿得到（opus 全文 / 完整图片 / 专栏 delta）。
# 节流窗口内不重复请求，见 detail_refresh_due()
DETAIL_FIELDS = ("title", "summary", "cover_url", "body_json", "stats_json",
                 "permalink", "raw_json", "published_at")

# 值得为「刷新正文」花钱拉详情的类型：text/image = 动态详情接口，article = 专栏全文。
# 其余类型（video/video_dynamic/repost/live…）置顶帖只走 feed 级刷新：
# 投稿详情更贵、且 arc/search 才是它的权威来源，不该被动态流覆盖。
DETAIL_REFRESH_TYPES = ("text", "image", "article")


def detail_refresh_due(last: datetime | None, now: datetime, hours: float) -> bool:
    """置顶帖的详情刷新是否到期（hours 为最小间隔小时数）。

    hours < 0  → 永不主动拉详情，只靠 feed 级字段刷新（最省请求）
    hours == 0 → 每轮都拉（最及时，请求量与风控风险最高）
    hours > 0  → 距上次刷新满 hours 才拉（默认 6 小时）

    last 为空（从未刷过，含「本轮刚被标为置顶」）一律视为到期：新置顶帖第一轮
    就补一次详情，不必等窗口走完。
    """
    if hours < 0:
        return False
    if last is None:
        return True
    return now - last >= timedelta(hours=hours)


def _blank_stats(value: object) -> bool:
    """`{}`（列表页偶发的空统计）视为"没带来新信息"，不许覆盖库里已有的数值。"""
    if not isinstance(value, str):
        return False
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return False
    return isinstance(parsed, dict) and not parsed


def refresh_fields(item: dict, *, with_detail: bool) -> dict:
    """把 feed/详情条目里可用的值组装成 posts 的局部更新字典。

    空值（None / 空串）**不写入**：置顶刷新是局部更新，feed 缺字段时不能把库里
    已有的内容抹掉（B 站动态 feed 的 title 多数为空、专栏 feed 无 body_json）。

    with_detail=True 时若提供了 body_json，同步重算派生列 body_text（P2 全文搜索）。
    """
    out: dict = {}
    for key in (DETAIL_FIELDS if with_detail else FEED_FIELDS):
        value = item.get(key)
        if value is None or value == "":
            continue
        if key == "stats_json" and _blank_stats(value):
            continue
        out[key] = value
    if with_detail and out.get("body_json"):
        out["body_text"] = extract_post_text(out["body_json"])
    return out
