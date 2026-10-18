"""粉丝结构分析 · L6 时间动态（2026-10-18）。对应 `plans/fan-structure-analysis.md` §3.6。

设计原文只有一句「滑动窗口 → 分层序列 → 迁移矩阵」+ 输出清单里的「换血率 / 半衰期」。
本模块把它做法定死，四条都是**防止误读**的：

## ① 窗口是**场次窗口**，不是日历窗口

`size=25` 场、`step=10` 场地滑。日历窗口会让"播得勤的主播"的粉丝天然多出场机会
（与 §2.2 同一条理由）。

## ② 层级**在窗内定**（分位切），**绝不跨窗比绝对分位**

与 §5.5 同一条纪律：换一个窗口 ⇒ 分位参照总体就变了。所以本模块只输出**层级迁移**，
不输出"某人的强度从 0.8 掉到 0.6"。

## ③ ★ 迁移矩阵有**第 4 个状态：未观测**

一个人可能在 t 窗入池、t+1 窗**根本没入池**（来得少或没来）。这**不等于"降到外层"**。
把它并进"外层"会把"停止观看"和"看得少了"混成一件事 —— 那正是这个模块最容易被读错的地方。

## ④ ★ 迁移矩阵必须配**零模型**

层级按分位切 ⇒ 任何一层的规模是**固定比例**（如核心 20%）。所以"核心层 80% 下一窗还在核心"
**不能直接读成强留存** —— 若层级与时间无关，也会有一大截落在对角线上。
本模块同时给**独立假设下的期望**与 **lift**，判据是 lift，不是对角线本身。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any, Sequence

from app.services.fan.axes import AxisTable, build_axis_table
from app.services.fan.compose import participation_strength
from app.services.fan.cross_v import (
    TIER_CORE,
    TIER_MID,
    TIER_OUTER,
    TIERS,
    assign_tiers,
)
from app.services.fan.loader import VtuberRef, Window, load_window

# ── 具名常量（施工计划 A2）────────────────────────────────────────────────
#: 滑动窗的场次数。与方案文档的「三档嵌套 25/50/75」对齐，取最小那档 —— 窗口越小，
#: 同一段历史里能切出的窗口越多，时间动态才看得见。
WINDOW_SIZE = 25
#: 相邻窗的步长（场）。取 10 = 窗宽的 40%，相邻窗有 60% 重叠 —— 太小则窗口间差异被
#: 重叠稀释，太大则窗数不够。
WINDOW_STEP = 10
#: 第 4 个状态：在 t 窗入池、t+1 窗未入池。
TIER_UNSEEN = "未观测"
#: 迁移矩阵的列（含未观测）
TIERS_WITH_UNSEEN = TIERS + (TIER_UNSEEN,)
#: 半衰期最多向后看几个窗
MAX_LAG = 8
#: 生存曲线拟合时，S 低于此值的点不参与 log 线性拟合（噪声大）
MIN_SURVIVAL_FOR_FIT = 0.02


@dataclass
class WindowSnapshot:
    """一个滑动窗的层级切分。"""

    index: int
    start_session: int
    end_session: int        # 半开区间 [start, end)
    n_sessions: int
    first_date: str
    last_date: str
    tier: dict[str, str]
    strength: dict[str, float]

    @property
    def pool(self) -> set[str]:
        return set(self.tier)

    def counts(self) -> dict[str, int]:
        out = {t: 0 for t in TIERS}
        for t in self.tier.values():
            out[t] = out.get(t, 0) + 1
        return out

    def meta(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "sessions": self.n_sessions,
            "start_session": self.start_session,
            "end_session": self.end_session,
            "first_date": self.first_date,
            "last_date": self.last_date,
            "pool": len(self.pool),
            "tiers": self.counts(),
        }


@dataclass
class Transition:
    """相邻两窗的迁移矩阵 + 零模型。"""

    from_index: int
    to_index: int
    counts: dict[str, dict[str, int]] = field(default_factory=dict)
    expected: dict[str, dict[str, float]] = field(default_factory=dict)
    lift: dict[str, dict[str, float]] = field(default_factory=dict)
    union: int = 0
    col_sizes: dict[str, int] = field(default_factory=dict)

    def retention(self, tier: str) -> float:
        """该层的**原始**留存率（对角线占比）。**不要单独读它** —— 见模块 docstring ④。"""
        row = self.counts.get(tier, {})
        total = sum(row.values())
        return (row.get(tier, 0) / total) if total else 0.0

    def churn(self, tier: str) -> float:
        """换血率 = 1 − 原始留存率。"""
        return 1.0 - self.retention(tier)

    def diagonal_lift(self, tier: str) -> float:
        """对角线的 lift —— **这才是"留存是否高于随机"的判据**。"""
        return self.lift.get(tier, {}).get(tier, 0.0)


@dataclass
class Decay:
    """一层的生存曲线与半衰期（单位 = 窗）。

    ⚠️ **半衰期只在指数衰减成立时才可信**。实测三个 V 的核心层曲线全都是
    「先掉一截、然后走平」（例：0.83 → 0.71 → 0.63 → 0.61 → 0.58）——那是**两段式**：
    一截在换人、一截是稳定核心。此时指数拟合出来的半衰期会**偏大**。
    所以本对象同时给 `r2`（拟合优度）与 `plateau`（尾部平台），**判读以这两个为准**。
    """

    tier: str
    cohort: int
    points: list[tuple[int, float]]        # (滞后窗数, 生存率)
    half_life: float | None                # None = 数据不足以估
    lambda_: float | None
    note: str = ""
    #: 对 log S 做线性回归的 R²；低于 0.9 说明"指数"这个假设本身就不成立
    r2: float | None = None
    #: 尾部平台 = 最后两个滞后点的均值；它比半衰期更能说明"稳定核心有多大"
    plateau: float | None = None
    plateau_from_lag: int | None = None

    def meta(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "cohort": self.cohort,
            "points": [{"lag": k, "survival": round(s, 6)} for k, s in self.points],
            "half_life_windows": (round(self.half_life, 3)
                                  if self.half_life is not None else None),
            "r2": (round(self.r2, 4) if self.r2 is not None else None),
            "plateau": (round(self.plateau, 4) if self.plateau is not None else None),
            "plateau_from_lag": self.plateau_from_lag,
            "note": self.note,
        }


class TimelineError(Exception):
    """时间动态的可恢复错误。"""


# ── 滑动窗 ─────────────────────────────────────────────────────────────────
def _slice_window(v: VtuberRef, n_total: int, start: int, size: int) -> Window:
    """用 `load_window` 的 `keep` 切一段。只有被切中的场次会读 raw。"""
    return load_window(v, n_total, keep=lambda i, _t: start <= i < start + size)


def build_windows(
    vtuber: VtuberRef | str,
    n_total: int = 75,
    *,
    size: int = WINDOW_SIZE,
    step: int = WINDOW_STEP,
) -> tuple[list[WindowSnapshot], Window]:
    """切出全部滑动窗。

    Returns:
        `(snapshots, full)` —— `full` 是整个 `n_total` 的窗口，调用方可以据此报告
        "覆盖了多少场、从哪天到哪天"。

    Raises:
        TimelineError: 场次不够切出**两个**窗（少于两个就没有迁移可看）。
    """
    full = load_window(vtuber, n_total)
    total = full.n
    if total < size + step:
        raise TimelineError(
            f"可用场次 {total} 不足以切出两个窗口（size={size} + step={step}）；"
            "先把区间放宽或把窗口调小"
        )

    snaps: list[WindowSnapshot] = []
    starts = list(range(0, total - size + 1, step))
    for idx, start in enumerate(starts):
        sub = full if (start == 0 and size == total) else _slice_window(
            full.vtuber, n_total, start, size)
        if not sub.sessions:
            continue
        table = build_axis_table(sub)
        strength = participation_strength(table)
        snaps.append(WindowSnapshot(
            index=idx,
            start_session=start,
            end_session=start + len(sub.sessions),
            n_sessions=len(sub.sessions),
            first_date=sub.sessions[0].start_at[:10],
            last_date=sub.sessions[-1].start_at[:10],
            tier=assign_tiers(table, strength),
            strength=strength,
        ))
    if len(snaps) < 2:
        raise TimelineError(f"只切出 {len(snaps)} 个窗口，无法看迁移")
    return snaps, full


# ── 迁移矩阵 ───────────────────────────────────────────────────────────────
def transition(a: WindowSnapshot, b: WindowSnapshot) -> Transition:
    """相邻两窗的迁移矩阵 + 独立假设下的零模型。

    零模型的参照总体 = `|pool(a) ∪ pool(b)|`。对 `pool(a)` 里的每个人，假设其 b 窗层级
    与 a 窗**独立**，则落在第 j 列的概率 = `|b 窗第 j 层| / |并集|`（"未观测"那一列
    就是 `|并集| − |pool(b)|`）。`lift = 实际 / 期望`。
    """
    union = a.pool | b.pool
    n_union = len(union) or 1
    col_sizes = {t: 0 for t in TIERS_WITH_UNSEEN}
    for uid in b.pool:
        col_sizes[b.tier[uid]] = col_sizes.get(b.tier[uid], 0) + 1
    col_sizes[TIER_UNSEEN] = n_union - len(b.pool)

    counts = {ra: {cb: 0 for cb in TIERS_WITH_UNSEEN} for ra in TIERS}
    for uid in a.pool:
        rb = b.tier.get(uid, TIER_UNSEEN)
        counts[a.tier[uid]][rb] += 1

    expected: dict[str, dict[str, float]] = {}
    lift: dict[str, dict[str, float]] = {}
    for ra in TIERS:
        row_total = sum(counts[ra].values())
        expected[ra] = {cb: row_total * col_sizes[cb] / n_union for cb in TIERS_WITH_UNSEEN}
        lift[ra] = {
            cb: (counts[ra][cb] / expected[ra][cb]) if expected[ra][cb] > 0 else 0.0
            for cb in TIERS_WITH_UNSEEN
        }
    return Transition(from_index=a.index, to_index=b.index, counts=counts,
                      expected=expected, lift=lift, union=n_union, col_sizes=col_sizes)


# ── 生存曲线与半衰期 ───────────────────────────────────────────────────────
def survival(snaps: list[WindowSnapshot], tier: str,
             *, max_lag: int = MAX_LAG) -> Decay:
    """某一层的队列生存曲线：t0 窗在 `tier` 的人，k 个窗之后**仍在 `tier`** 的比例。

    ⚠️ 分母是**队列人数**；"未观测"与"降到别的层"**都算没存活** —— 这是"换血"的定义。
    若想看"只是掉层但还在看"，用迁移矩阵的对应单元格，不要改这里的定义。
    """
    if not snaps:
        raise TimelineError("没有窗口")
    t0 = snaps[0]
    cohort = [u for u, t in t0.tier.items() if t == tier]
    if not cohort:
        return Decay(tier, 0, [], None, None, note="该窗口里这一层是空的")

    points: list[tuple[int, float]] = []
    for lag in range(1, min(max_lag, len(snaps) - 1) + 1):
        later = snaps[lag]
        still = sum(1 for u in cohort if later.tier.get(u) == tier)
        points.append((lag, still / len(cohort)))

    fit = _fit_half_life(points, len(snaps) - 1)
    plateau, from_lag = _plateau(points)
    return Decay(tier, len(cohort), points, fit.half, fit.lam, fit.note,
                 r2=fit.r2, plateau=plateau, plateau_from_lag=from_lag)


@dataclass(frozen=True)
class _Fit:
    lam: float | None
    half: float | None
    r2: float | None
    note: str


def _fit_half_life(points: Sequence[tuple[int, float]], max_lag: int) -> _Fit:
    """`S(k) = exp(-λk)` 的最小二乘拟合（对 log S 做线性回归），并报 R²。"""
    usable = [(k, s) for k, s in points if s >= MIN_SURVIVAL_FOR_FIT]
    if len(usable) < 2:
        if not points:
            return _Fit(None, None, None, "没有滞后点")
        if all(s <= MIN_SURVIVAL_FOR_FIT for _, s in points):
            return _Fit(math.log(2), 1.0, None, "第一个滞后窗就掉到 ~0 ⇒ 半衰期 ≤ 1 窗")
        return _Fit(None, None, None, "有效滞后点少于 2 个，无法拟合")
    xs = [k for k, _ in usable]
    ys = [math.log(s) for _, s in usable]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return _Fit(None, None, None, "滞后点全在同一位置")
    lam = -num / den
    # R²（对 log S 的线性回归）
    pred = [my + (-lam) * (x - mx) for x in xs]
    ss_res = sum((y - p) ** 2 for y, p in zip(ys, pred))
    ss_tot = sum((y - my) ** 2 for y in ys)
    r2 = (1.0 - ss_res / ss_tot) if ss_tot > 0 else None
    if lam <= 0:
        return _Fit(None, None, r2, "生存率没有衰减（λ ≤ 0）—— 窗口太短，看不出换血")
    half = math.log(2) / lam
    note = ""
    if half > max_lag:
        note = "半衰期超出观测范围（是下界）"
    if r2 is not None and r2 < 0.9:
        note = (note + "；" if note else "") + (
            f"⚠️ 指数拟合很差（R²={r2:.2f}）⇒ 半衰期不可信，看 plateau")
    return _Fit(lam, half, r2, note)


def _plateau(points: Sequence[tuple[int, float]]) -> tuple[float | None, int | None]:
    """尾部平台：最后两个滞后点的均值。它比半衰期更能说明"稳定核心有多大"。"""
    tail = list(points)[-2:]
    if len(tail) < 2:
        return (tail[-1][1] if tail else None), (tail[-1][0] if tail else None)
    return sum(s for _, s in tail) / 2.0, tail[0][0]


# ── 汇总 ───────────────────────────────────────────────────────────────────
def summarize(snaps: list[WindowSnapshot]) -> dict[str, Any]:
    """整条时间线的判读摘要。"""
    trans = [transition(a, b) for a, b in pairwise(snaps)]
    core_lifts = [t.diagonal_lift(TIER_CORE) for t in trans]
    core_raw = [t.retention(TIER_CORE) for t in trans]
    decay = survival(snaps, TIER_CORE)

    # 换血：核心层每一跳的"出/进"
    churn = []
    for t in trans:
        a, b = snaps[t.from_index], snaps[t.to_index]
        core_a, core_b = a.tier, b.tier
        left = sum(1 for u, x in core_a.items() if x == TIER_CORE and core_b.get(u) != TIER_CORE)
        entered = sum(1 for u, x in core_b.items() if x == TIER_CORE and core_a.get(u) != TIER_CORE)
        n_a = max(1, sum(1 for x in core_a.values() if x == TIER_CORE))
        n_b = max(1, sum(1 for x in core_b.values() if x == TIER_CORE))
        churn.append({
            "from": t.from_index, "to": t.to_index,
            "core_out_rate": round(left / n_a, 4),
            "core_in_rate": round(entered / n_b, 4),
        })

    return {
        "windows": len(snaps),
        "transitions": len(trans),
        "core": {
            "retention_raw": [round(x, 4) for x in core_raw],
            "retention_lift": [round(x, 3) for x in core_lifts],
            "churn": churn,
            "decay": decay.meta(),
        },
        "reading": _reading(core_lifts, decay, len(snaps)),
    }


def _reading(lifts: list[float], decay: Decay, windows: int) -> str:
    """一句话判读。**优先报平台值，不是半衰期** —— 实测曲线都不是指数。"""
    if not lifts:
        return "窗口太少，给不出判读"
    lo, hi = min(lifts), max(lifts)

    bits: list[str] = []
    if decay.plateau is not None:
        bits.append(
            f"到第 {decay.plateau_from_lag} 个窗之后仍有约 {decay.plateau:.0%} 留在核心层"
        )
    if decay.half_life is not None:
        if decay.r2 is not None and decay.r2 < 0.9:
            bits.append(
                f"指数拟合很差（R²={decay.r2:.2f}），半衰期 {decay.half_life:.1f} 窗**只能当粗估**"
            )
        else:
            bits.append(f"半衰期约 {decay.half_life:.1f} 个窗")
    tail = ("；" + "；".join(bits)) if bits else ""

    if lo > 1.5:
        lead = f"核心层留存**显著高于随机**（对角 lift {lo:.2f}~{hi:.2f}）"
        closes = "核心是稳的，不是分位切出来的假象"
    elif hi < 1.2:
        lead = f"核心层留存**接近随机**（lift {lo:.2f}~{hi:.2f}）"
        closes = "⚠️ 层在换人，别把「这一窗的核心」当成「稳定的核心群体」"
    else:
        lead = f"核心层留存高于随机但不强（lift {lo:.2f}~{hi:.2f}）"
        closes = ""
    return f"{lead}{tail} —— {closes}" if closes else f"{lead}{tail}"


__all__ = [
    "WINDOW_SIZE", "WINDOW_STEP", "TIER_UNSEEN", "TIERS_WITH_UNSEEN", "MAX_LAG",
    "WindowSnapshot", "Transition", "Decay", "TimelineError",
    "build_windows", "transition", "survival", "summarize",
]
