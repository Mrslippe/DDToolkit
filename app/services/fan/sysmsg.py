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

#: 系统消息与最后一条弹幕的最大间隔（小时）
SYS_END_WINDOW_H = 2.0
#: 收尾留白（分钟）
SYS_END_GRACE_MIN = 1


def apply_sys_end(raw: dict, stats: dict) -> bool:
    """若存在"下播系统消息"，据此提前 `end_at`。返回是否改动。"""
    events = stats.get("sys_events") or []
    if not events:
        return False
    last_mt = 0
    for a in raw.values():
        if isinstance(a, dict) and a.get("mt"):
            last_mt = max(last_mt, int(a["mt"][-1]))
    if not last_mt:
        return False
    ts = [int(e.get("ts") or 0) for e in events if int(e.get("ts") or 0) > last_mt]
    if not ts:
        return False
    stop_ms = min(ts)                      # 结束后最早的一条系统消息 = 下播时刻
    if (stop_ms - last_mt) / 3_600_000 > SYS_END_WINDOW_H:
        return False
    candidate = stop_ms + SYS_END_GRACE_MIN * 60_000
    old = str(stats.get("end_at") or "")
    new = datetime.fromtimestamp(candidate / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S.%f")
    if old and new >= old:
        return False                       # 只允许变短
    stats["end_at"] = new
    stats["duration_note"] = "下播时刻取自系统消息（直播中止/录制结束）"
    return True
