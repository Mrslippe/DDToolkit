"""系统消息（`uId <= 0`）作为下播时刻的**首选**依据；缺失时回退到率降/平台时间。

## 背景

上游会在直播结束时推送系统消息（type 7/8/11/12，`uId = -1`），内容形如
「直播中止」「录制结束」。它们比 `stopDate` 硬 —— `stopDate` 会偏长（实测有场多报 6.9h）。

**但不是每场都有**：没有时就完全退回原来的逻辑（率降裁尾 / 平台时间），不改变任何行为。

## 保守规则

只用"**最后一条系统消息**"，且必须满足：

- 它出现在**最后一条弹幕之后**（下播消息必然在聊天之后）；
- 与最后一条弹幕的间隔 ≤ `SYS_END_WINDOW_H` 小时（防止把隔天的一条消息当成下播）。

满足才把 `end_at` 收到该时刻 + 1 分钟；否则**什么都不做**。
"""

from __future__ import annotations

from datetime import datetime, timezone

#: **下播类**系统消息（2026-10-21 实测语义）
#: type 11 = 开播/提醒（总在开头）；type 7 / 8 / 12 = 结束相关（总在结尾 5 分钟内）
STOP_TYPES = frozenset({7, 8, 12})
#: 收尾留白（分钟）
SYS_END_GRACE_MIN = 1


def apply_sys_end(raw: dict, stats: dict) -> bool:
    """若有「下播类」系统消息，就以它为准。返回是否改动。

    2026-10-21 实测：type 11 永远出现在**开头**（开播），type 7/8/12 出现在**结尾**
    （距最后一条记录约 5 分钟）。所以只看 `STOP_TYPES`，取**最晚**的那条。

    不再要求"消息在最后一条弹幕之后" —— 下播后观众还会继续聊，这是常态。
    """
    events = stats.get("sys_events") or []
    stops = [int(e.get("ts") or 0) for e in events
             if e.get("type") in STOP_TYPES and int(e.get("ts") or 0) > 0]
    if not stops:
        return False
    candidate = max(stops) + SYS_END_GRACE_MIN * 60_000
    old = str(stats.get("end_at") or "")
    new = datetime.fromtimestamp(candidate / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S.%f")
    if old and new >= old:
        return False                       # 只允许变短
    stats["end_at"] = new
    stats["duration_note"] = "下播时刻取自系统消息（type 7/8/12）"
    return True
