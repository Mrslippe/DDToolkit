"""粉丝结构分析 · 跨 V 对照（P4）。

对应规格 `plans/fan-model-plan.md` §5.5 与 §7。

## ★ 只比层级，不比分数

规格 §5.5 已否证**测量不变性**：三轴的 75 分位在三个 V 上最多差 **4.2 倍**，
交叉套用 18 组里 **7 组**偏离超 8 个百分点。所以"这个人在 A 的核心度 0.8、在 B 是 0.6"
**不是一个合法陈述**。本模块只输出：

- 该 uid 在各 V 上落在**哪一层**（核心 / 次核心 / 外层）
- 两 V 名单的**重叠**（实际 / 期望 / lift / 双向比例）

## ★ 零模型是必选的

单纯报"两 V 交集 300 人"**不可解释** —— 两个主播的受众本就有天然交集。
必须同时给**超几何期望**与 **lift**，并**分方向**给 `|A∩B|/|A|` 与 `|A∩B|/|B|`。

## 池子的选择（写死并说明）

超几何的 N（总体）默认取**两 V 入选者的并集**，不是"全库所有 uid"。
理由：全库规模会随库增长而漂移，使 lift 失去可比性；而"两个主播的粉丝并集"
是一个有界、可复算的量。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import combinations
from typing import Iterable, Mapping, Sequence

from app.services.fan.axes import AxisTable, build_axis_table
from app.services.fan.compose import participation_strength
from app.services.fan.loader import Window

# ── 具名常量（施工计划 A2）────────────────────────────────────────────────
#: 层级门槛：按**本 V 内**的参与强度分位切，不是绝对分数（规格 §5.5）
TIER_CORE_FLOOR = 0.80
TIER_MID_FLOOR = 0.50

TIER_CORE = "核心"
TIER_MID = "次核心"
TIER_OUTER = "外层"
TIERS: tuple[str, str, str] = (TIER_CORE, TIER_MID, TIER_OUTER)
_TIER_ORDER = {TIER_CORE: 0, TIER_MID: 1, TIER_OUTER: 2}


@dataclass
class VProfile:
    """一个 V 的结构画像（层级 + 强度）。"""

    name: str
    short: str
    n_sessions: int
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


@dataclass
class Overlap:
    """两 V 名单的重叠与零模型。"""

    a: str
    b: str
    size_a: int
    size_b: int
    intersection: int
    population: int
    expected: float
    lift: float
    p_value: float          # P(X ≥ 观测值)，上尾（富集用）
    p_value_lower: float    # P(X ≤ 观测值)，下尾（**贫化**用）
    share_of_a: float       # |A∩B| / |A|
    share_of_b: float       # |A∩B| / |B|
    tiers: dict[str, dict[str, int]] = field(default_factory=dict)
    shared_uids: list[str] = field(default_factory=list)

    @property
    def is_enriched(self) -> bool:
        """显著多于随机预期的重叠。"""
        return self.p_value < 0.05 and self.lift > 1.0

    @property
    def is_depleted(self) -> bool:
        """显著少于随机预期的重叠 —— **两个主播的受众在分化**。"""
        return self.p_value_lower < 0.05 and self.lift < 1.0

    @property
    def jaccard(self) -> float:
        union = self.size_a + self.size_b - self.intersection
        return (self.intersection / union) if union else 0.0


def _log_comb(n: int, k: int) -> float:
    if k < 0 or k > n:
        return float("-inf")
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def hypergeom_sf(k: int, population: int, successes: int, draws: int) -> float:
    """$P(X \\ge k)$，超几何分布上尾。

    参数命名按统计惯用：`population` = N（总体），`successes` = K（总体中"命中"类），
    `draws` = n（抽样数）。
    """
    if k <= 0:
        return 1.0
    upper = min(successes, draws)
    if k > upper:
        return 0.0
    denom = _log_comb(population, draws)
    terms = []
    for i in range(k, upper + 1):
        rest = draws - i
        if rest < 0 or rest > population - successes:
            continue
        terms.append(_log_comb(successes, i) + _log_comb(population - successes, rest) - denom)
    if not terms:
        return 0.0
    mx = max(terms)
    return min(1.0, math.exp(mx) * sum(math.exp(t - mx) for t in terms))


def hypergeom_cdf(k: int, population: int, successes: int, draws: int) -> float:
    """$P(X \\le k)$，超几何分布下尾 —— **判"贫化"（重叠显著少于随机）用**。"""
    if k < 0:
        return 0.0
    upper = min(successes, draws)
    if k >= upper:
        return 1.0
    denom = _log_comb(population, draws)
    terms = []
    for i in range(0, k + 1):
        rest = draws - i
        if rest < 0 or rest > population - successes:
            continue
        terms.append(_log_comb(successes, i) + _log_comb(population - successes, rest) - denom)
    if not terms:
        return 0.0
    mx = max(terms)
    return min(1.0, math.exp(mx) * sum(math.exp(t - mx) for t in terms))


def assign_tiers(table: AxisTable, strength: Mapping[str, float] | None = None) -> dict[str, str]:
    """按**本 V 内**的参与强度分位切层。

    ⚠️ 这里的"核心"是**相对本 V 的**，跨 V 不可比（规格 §5.5）。
    返回的层级只能用来回答"同一个人在两个 V 上各处于什么位置"。
    """
    s = dict(strength) if strength is not None else participation_strength(table)
    if not s:
        return {}
    # 分位：用平均秩，避免并列把某一层撑爆
    order = sorted(s, key=lambda u: (-s[u], u))
    n = len(order)
    out: dict[str, str] = {}
    for rank, uid in enumerate(order):
        q = 1.0 - (rank + 1) / n            # 1 = 最强
        out[uid] = (TIER_CORE if q >= TIER_CORE_FLOOR
                    else TIER_MID if q >= TIER_MID_FLOOR else TIER_OUTER)
    return out


def profile(win: Window) -> VProfile:
    """从一个窗口算出 V 画像。"""
    table = build_axis_table(win)
    strength = participation_strength(table)
    return VProfile(win.vtuber.name, win.vtuber.short, win.n,
                    assign_tiers(table, strength), strength)


def overlap(a: VProfile, b: VProfile, *, shared: Sequence[str] | None = None) -> Overlap:
    """两 V 名单的重叠 + 超几何零模型。

    Args:
        a, b: 两个 V 画像。
        shared: 预筛好的交集（省一次求交；不传就现算）。

    Returns:
        `Overlap`。`population` 默认取**两者并集**（见模块 docstring）。
    """
    sa, sb = a.pool, b.pool
    inter = set(shared) if shared is not None else (sa & sb)
    union = sa | sb
    pop, ka, kb = len(union), len(sa), len(sb)
    # 期望 = K·n/N；pop 为 0 时避免除零
    expected = (ka * kb / pop) if pop else 0.0
    lift = (len(inter) / expected) if expected > 0 else 0.0
    p = hypergeom_sf(len(inter), pop, ka, kb) if pop else 0.0
    p_low = hypergeom_cdf(len(inter), pop, ka, kb) if pop else 0.0

    # 层级交叉表：行 = A 的层，列 = B 的层
    tiers = {ta: {tb: 0 for tb in TIERS} for ta in TIERS}
    for uid in inter:
        tiers[a.tier[uid]][b.tier[uid]] += 1

    return Overlap(
        a=a.name, b=b.name,
        size_a=ka, size_b=kb, intersection=len(inter), population=pop,
        expected=expected, lift=lift, p_value=p, p_value_lower=p_low,
        share_of_a=(len(inter) / ka) if ka else 0.0,
        share_of_b=(len(inter) / kb) if kb else 0.0,
        tiers=tiers,
        shared_uids=sorted(inter),
    )


def tier_moves(a: VProfile, b: VProfile) -> dict[str, int]:
    """在他俩的**公共名单**里，层级发生迁移的人数（按方向计数）。"""
    inter = a.pool & b.pool
    moves: dict[str, int] = {}
    for uid in inter:
        ta, tb = a.tier[uid], b.tier[uid]
        if ta == tb:
            key = f"{ta}→{ta}（不变）"
        else:
            direction = "升" if _TIER_ORDER[tb] < _TIER_ORDER[ta] else "降"
            key = f"{ta}→{tb}（{direction}）"
        moves[key] = moves.get(key, 0) + 1
    return dict(sorted(moves.items(), key=lambda kv: -kv[1]))


def describe(ov: Overlap) -> str:
    """给人看的一句话判读。**必须区分富集 / 贫化 / 无差异三种**。

    ⚠️ 只写"无显著差异"会误导：lift 0.29 且下尾 p≈0 的情形是**显著贫化**
    （两边受众在分化），与"看不出关系"完全是两件事。
    """
    if ov.population == 0:
        return "两 V 都没有入选者，无法对照"
    head = (f"{ov.a} 与 {ov.b} 的名单重叠 {ov.intersection} 人"
            f"（随机预期 {ov.expected:.1f}，lift {ov.lift:.2f}）")
    if ov.is_enriched:
        return head + f"，**显著富集**（上尾 p={ov.p_value:.3g}）"
    if ov.is_depleted:
        return head + (f"，**显著贫化**（下尾 p={ov.p_value_lower:.3g}）"
                       f" ⇒ 两边受众在分化，重叠只有随机预期的 {ov.lift:.0%}")
    return head + (f"，与随机预期无显著差异"
                   f"（上尾 p={ov.p_value:.3g} / 下尾 p={ov.p_value_lower:.3g}）"
                   f" ⇒ **不能**据此说两边粉丝结构相似或相异")


__all__ = [
    "TIER_CORE_FLOOR",
    "TIER_MID_FLOOR",
    "TIER_CORE",
    "TIER_MID",
    "TIER_OUTER",
    "TIERS",
    "VProfile",
    "Overlap",
    "hypergeom_sf",
    "hypergeom_cdf",
    "assign_tiers",
    "profile",
    "overlap",
    "tier_moves",
    "describe",
]
