"""把「细桶弹幕率骤降」并入 quality：给出更贴近真实的下播时刻。

## 判据（三条约束，缺一不可）

1. **基线用本场自己的**：前 `START_AFTER_H` 小时里，每 `BUCKET_MIN` 分钟一桶的中位桶量；
   阈值 = 基线 × `MIN_RATIO`。绝对阈值不可用 —— 不同主播的弹幕密度能差十倍。
2. **只用它来"变短"**：候选结束时间若晚于现有 `end_at`，不采纳。
3. **加宽限**：最后活跃桶再往后 `GRACE_MIN` 分钟，避免把下播前的告别语切掉。

只对**已经超过 `START_AFTER_H` 小时**的场次生效 —— 短场次不需要判断。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from statistics import median

BUCKET_MIN = 5
START_AFTER_H = 5
MIN_RATIO = 0.10
GRACE_MIN = 30


def rate_based_end(raw: dict, *,
                   bucket_min: int = BUCKET_MIN,
                   start_after_h: int = START_AFTER_H,
                   min_ratio: float = MIN_RATIO,
                   grace_min: int = GRACE_MIN) -> datetime | None:
    """返回建议的下播时刻；不需要调整时返回 `None`。"""
    ts = sorted(
        int(t) for a in raw.values() if isinstance(a, dict) for t in (a.get("mt") or [])
    )
    if len(ts) < 100:
        return None
    span_h = (ts[-1] - ts[0]) / 3_600_000
    if span_h <= start_after_h:
        return None

    step = bucket_min * 60_000
    t0 = ts[0]
    n_buckets = (ts[-1] - t0) // step + 1
    counts = [0] * n_buckets
    for t in ts:
        counts[(t - t0) // step] += 1

    head_n = min(n_buckets, int(start_after_h * 60 / bucket_min))
    head = sorted(counts[:head_n] or [0])
    # 用 **p75** 而不是中位数：前 5 小时里通常已经夹着安静时段（如凌晨低语期），
    # 中位数会被它们拉低，导致"阈值太低、尾巴全算活跃"，裁不出结果。
    base = head[min(len(head) - 1, int(len(head) * 0.75))]
    if base <= 0:
        return None
    need = max(1, base * min_ratio)

    last_active = max((i for i, c in enumerate(counts) if c >= need), default=None)
    if last_active is None:
        return None
    end_ms = t0 + (last_active + 1) * step + grace_min * 60_000
    if end_ms >= ts[-1]:
        return None          # 本来就没提前结束
    return datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)


def apply_rate_end(raw: dict, stats: dict) -> bool:
    """若弹幕率在 5 小时后骤降，把 `end_at` 提前。返回是否改动。"""
    cand = rate_based_end(raw)
    if cand is None:
        return False
    old = str(stats.get("end_at") or "")
    new = cand.strftime("%Y-%m-%d %H:%M:%S.%f")
    if old and new >= old:
        return False          # 只允许变短
    stats["end_at"] = new
    stats["duration_note"] = (
        f"弹幕率骤降：{new[:16]} 之后连续 {BUCKET_MIN} 分钟桶低于基线 {MIN_RATIO:.0%}"
        f"（含 {GRACE_MIN} 分钟宽限）"
    )
    return True
