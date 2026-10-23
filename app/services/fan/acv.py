"""平均同接（ACV）：从 danmakus 的 `live.extra.onlineRank` 时间线算。

## 为什么要裁剪头尾

同接曲线在开播时爬坡、下播时回落，直接取平均会被这两段拉低。实测（2026-10-23，
6 场样本）：**头部 10% 的均值只有整体的 55–65%**，尾部约 85–90%；去掉头尾各 10% 后，
均值上升 6.6%–9.8%，再往后（15%/20%）收益递减到 1% 以内。

因此 ACV = **去掉头尾各 10% 的点之后**的均值（按点数比例，短场次自适应）。

## 数据缺失怎么办

`onlineRank` 不是每场都有（抽样时偶发超时/未收录）。缺失时返回 `None`，
调用方（分析层）用**同 V 的 ACV 中位数**兜底，并在报告里标注。
"""

from __future__ import annotations

import statistics as st

#: 头尾各裁掉的比例（按点数）
TRIM_FRAC = 0.10


def acv_from_online_rank(extra: dict | None,
                         *, trim: float = TRIM_FRAC) -> tuple[float | None, int, int]:
    """返回 `(ACV, 点数, 峰值)`；没有数据时 `(None, 0, 0)`。"""
    tl = ((extra or {}).get("onlineRank")) or {}
    if not isinstance(tl, dict) or not tl:
        return None, 0, 0
    pts: list[tuple[int, int]] = []
    for k, v in tl.items():
        try:
            pts.append((int(k), int(v)))
        except (TypeError, ValueError):
            continue
    if not pts:
        return None, 0, 0
    pts.sort()
    vals = [v for _, v in pts]
    k = int(len(vals) * trim)
    core = vals[k:len(vals) - k] if k else vals
    core = [v for v in core if v > 0] or vals
    return st.mean(core), len(vals), max(vals)
