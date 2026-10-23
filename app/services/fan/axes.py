r"""粉丝结构分析 · 三轴与经验分位变换（P1）。

对应规格 `plans/fan-model-plan.md` §3。**不依赖 numpy** —— 应用运行时没有它。

## 三条轴

| 轴 | 公式 | 分母 |
|---|---|---|
| 出勤 $A$ | `att_n / N` | **在册场次数** $N$ |
| 互动 $I$ | `(Σ弹幕 + ΣSC) / att_n` | **出席场次数** |
| 付费 $P$ | `log(1 + Σ付费)` | —— |

分母不同的原因见规格 §3.3–3.5：用 $N$ 会稀释"来得少但每次说很多"的人。

## 经验分位变换

$$\pi(x) = \frac{1}{n}\left(\#\{x_i < x\} + \tfrac12\#\{x_i = x\}\right)$$

⚠️ **参照总体必须显式传入**：它是"相对于**谁**的分位"。传错总体会让全部分数错位，
而错位在结果里看不出来。因此 `empirical_percentile()` **不提供默认参照**。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence

from app.services.fan.loader import Window

# ── 具名常量（施工计划 A2）────────────────────────────────────────────────
#: 入选门槛：出席率不低于此值才进入分位参照总体（规格 §1.2 的 θ_in）
INCLUSION_FLOOR = 0.10
#: 付费轴 = ln(1 + Σ付费)，**必须用 math.log1p**（见 `_raw_axes` 的注释）

AXIS_ATTENDANCE = "attendance"
AXIS_INTERACTION = "interaction"
AXIS_PAYMENT = "payment"
AXES: tuple[str, str, str] = (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT)


class AxisError(Exception):
    """三轴计算的可恢复错误。"""


@dataclass
class AxisTable:
    """一个窗口内**入选者**的三轴原始值与分位。

    `uids` 的顺序是**加载顺序**（由窗口内的出席顺序决定），调用方若需要排序请用
    `compose.rank`，不要依赖这里的顺序。
    """

    vtuber: str
    n_sessions: int
    floor: float
    uids: tuple[str, ...]
    raw: dict[str, dict[str, float]] = field(default_factory=dict)
    pct: dict[str, dict[str, float]] = field(default_factory=dict)
    #: 次序键用的次级量（规格 §4.4）：累计付费 / 总弹幕 / 末次出席位置
    tie: dict[str, dict[str, float]] = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.uids)

    def column(self, axis: str) -> list[float]:
        """某个轴的原始值列（顺序同 `uids`）。"""
        if axis not in AXES:
            raise AxisError(f"未知的轴：{axis!r}；可用：{AXES}")
        return [self.raw[uid][axis] for uid in self.uids]

    def pct_column(self, axis: str) -> list[float]:
        if axis not in AXES:
            raise AxisError(f"未知的轴：{axis!r}；可用：{AXES}")
        return [self.pct[uid][axis] for uid in self.uids]


def empirical_percentile(
    values: Sequence[float],
    *,
    reference: Sequence[float],
) -> list[float]:
    r"""经验分位（平均秩归一）：$\pi(x)=\frac{1}{n}(\#\{x_i<x\}+\tfrac12\#\{x_i=x\})$。

    Args:
        values: 要转换的值。
        reference: **参照总体**，必填。传空会抛 `AxisError`。

    Returns:
        与 `values` 等长的分位列表，取值在 $(0, 1]$。

    Raises:
        AxisError: `reference` 为空，或含非有限值。

    Note:
        参照总体通常是"入选者的该轴原始值"。**不要**用全体观测者 —— 大量零值会把
        分位压塌（规格 §3.2 的 P4）。
    """
    if not reference:
        raise AxisError("`reference` 不能为空 —— 分位必须显式指定参照总体")
    ref = sorted(float(x) for x in reference)
    n = len(ref)
    if any(not math.isfinite(x) for x in ref):
        raise AxisError("`reference` 含 NaN/Inf")

    # 预先按值分组，避免对每个待转值线性扫描
    uniq: list[float] = []
    counts: list[int] = []
    for x in ref:
        if uniq and x == uniq[-1]:
            counts[-1] += 1
        else:
            uniq.append(x)
            counts.append(1)
    below: list[int] = [0] * len(uniq)
    acc = 0
    for i, c in enumerate(counts):
        below[i] = acc
        acc += c

    out: list[float] = []
    for v in values:
        v = float(v)
        if not math.isfinite(v):
            raise AxisError("待转换的值含 NaN/Inf")
        # 二分：找第一个 >= v 的位置
        lo, hi = 0, len(uniq)
        while lo < hi:
            mid = (lo + hi) // 2
            if uniq[mid] < v:
                lo = mid + 1
            else:
                hi = mid
        if lo < len(uniq) and uniq[lo] == v:
            # 并列：**1 基**平均秩 = 该组起始位置 + (组大小 + 1) / 2
            rank = below[lo] + (counts[lo] + 1) / 2.0
        else:
            # 值不在参照里（正常调用不会发生，因为 values 就是 reference）：
            # 取它落在的那个空隙的中点，并夹到 [1, n]
            rank = min(float(n), below[lo] + 0.5)
        # 不截断：值低于参照全体时 rank 会 < 1，那是正确行为（分位 < 1/n）
        out.append(rank / n)
    return out


def _raw_axes(u) -> dict[str, float]:
    """单个 `UserFact` → 三轴原始值。公式见模块 docstring。"""
    att = max(1, u.att_n)
    return {
        AXIS_ATTENDANCE: u.att_n,          # 由调用方除以 N
        AXIS_INTERACTION: (u.m + u.sc_cnt) / att,
        AXIS_PAYMENT: math.log1p(u.pay),   # ⚠️ 必须用 log1p：log(1.0+x) 会把小额截成同一个浮点数，
    }


def build_axis_table(win: Window, *, floor: float = INCLUSION_FLOOR,
                      pool_size: int | None = None) -> AxisTable:
    """把 `Window` 收成入选者的 `AxisTable`。

    Args:
        win: `loader.load_window()` 的结果。
        floor: 最低噪声门槛（出席率）—— 先按它筛出"大盘"。
        pool_size: 名单人数（ACV 方案：2×平均同接）。给了就在大盘内
            **按核心度 S 取前 N 人**（两遍：先建大盘表算 S，再在名单内重建，
            分位在名单内重算）；`None` = 直接用 `floor` 大盘。

    Returns:
        `AxisTable`。若没有入选者，返回空表（`len()==0`），不抛异常。

    ⚠️ 2026-10-24 改：选名单的依据从**出席场次**换成**核心度**。按出席选会丢掉
    "来得少但打钱多"的鲸鱼 —— 实测明前奶绿损失 36% 收入、星瞳损失 28%；
    按核心度选后收入保留 91%–96.5%（见 `scripts/pool_select_compare.py`）。
    """
    n = max(1, win.n)
    eligible = [u for u in win.users.values() if u.att_n / n >= floor]
    if pool_size is not None and pool_size > 0 and len(eligible) > pool_size:
        base = _table_from(win, eligible, floor)
        score = {
            uid: (base.pct[uid][AXIS_ATTENDANCE] + base.pct[uid][AXIS_INTERACTION]
                  + base.pct[uid][AXIS_PAYMENT]) / 3
            for uid in base.uids
        }
        eligible = sorted(eligible, key=lambda u: (-score.get(u.uid, 0.0), u.uid))[:pool_size]
    return _table_from(win, eligible, floor)


def _table_from(win: Window, pool: list, floor: float) -> AxisTable:
    """给定 pool 建表（内部的第二遍）。"""
    n = max(1, win.n)
    if not pool:
        return AxisTable(win.vtuber.name, win.n, floor, ())

    table = AxisTable(win.vtuber.name, win.n, floor, tuple(u.uid for u in pool))

    # ── 出勤轴（2026-10-20 改）：**先比来了几场，来的一样多时比谁到得早** ──
    # 出席率在顶部大量并列（N 场里可能就是几十人同为满勤），单靠比率排不出序；
    # 而"平均首次出场时滞"在这份数据里能分开同档用户（实测后段发言 73% vs 41%）。
    # 形式：A = (att_n + π_E) / (N + 1)，π_E 为**同出席场次内** (−mean_lag) 的经验分位。
    # 结果统一保留三位小数（见下方 round）。
    # 这样跨档顺序严格不变（来得多的一定在前），档内由时机决定 —— 不会牺牲预测力。
    lag_pct: dict[str, float] = {}
    by_att: dict[int, list] = {}
    for u in pool:
        by_att.setdefault(u.att_n, []).append(u)
    for group in by_att.values():
        # 没有时滞数据的用户取中性 0.5，不假装"最早"或"最晚"
        vals = sorted(group, key=lambda x: -(x.mean_lag if x.mean_lag is not None else 1e9))
        m = len(vals)
        for i, u in enumerate(vals):
            lag_pct[u.uid] = (i + 0.5) / m if m > 1 else 0.5

    for u in pool:
        r = _raw_axes(u)
        r[AXIS_ATTENDANCE] = (u.att_n + lag_pct[u.uid]) / (n + 1)
        # 三轴统一保留三位小数：对外展示与复算都以此为准，避免"同一份数据两串数字"
        table.raw[u.uid] = {k: round(v, 3) for k, v in r.items()}
        table.tie[u.uid] = {
            "pay": u.pay,
            "msg": float(u.m),
            "last_pos": u.last_pos,
        }

    # 三轴各自相对于**入选者**取分位
    for axis in AXES:
        col = [table.raw[u][axis] for u in table.uids]
        pcts = empirical_percentile(col, reference=col)
        for uid, p in zip(table.uids, pcts):
            table.pct.setdefault(uid, {})[axis] = p
    return table


__all__ = [
    "INCLUSION_FLOOR",
    "AXIS_ATTENDANCE",
    "AXIS_INTERACTION",
    "AXIS_PAYMENT",
    "AXES",
    "AxisError",
    "AxisTable",
    "empirical_percentile",
    "build_axis_table",
]
