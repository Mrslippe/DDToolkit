"""池子规模：由**平均同接（ACV）**决定（2026-10-23 用户定案 B 方案）。

- 核心层 = 0.75 × ACV
- 次核心层 = 1.25 × ACV
- ⇒ 池子 = 2 × ACV，其余人"分流走"

ACV 取窗口内各场 `stats["acv"]` 的**中位数**（单场缺失不影响）。整个窗口都没有 ACV 时返回
`None`，调用方回退到 `axes.INCLUSION_FLOOR` 的老口径。

抽成公共函数的原因：路由、验证脚本、黄金值测试必须用**同一个**池子，否则同一个 V 会算出
两个不同的池子大小。
"""

from __future__ import annotations

import statistics as st

from app.services.fan.loader import Window

#: 池子 / 核心层相对 ACV 的倍数
POOL_MULT = 2.0
CORE_MULT = 0.75


def window_acv(win: Window) -> float | None:
    """窗口的平均同接：各场 `stats["acv"]` 的中位数；一场都没有就 `None`。"""
    vals = [float(sr.stats["acv"]) for sr in win.sessions
            if (sr.stats or {}).get("acv")]
    return float(st.median(vals)) if vals else None


def pool_size_for(win: Window) -> int | None:
    """池子人数（2×ACV）；没有 ACV 时 `None`。"""
    acv = window_acv(win)
    return round(acv * POOL_MULT) if acv else None


def core_size_for(win: Window) -> int | None:
    """核心层人数（0.75×ACV）；没有 ACV 时 `None`。"""
    acv = window_acv(win)
    return round(acv * CORE_MULT) if acv else None
