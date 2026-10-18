"""粉丝结构分析 · 完整性判据（P2）。

对应规格 `plans/fan-model-spec.md` §2.3 的 C1–C4 与 §2.4 的留存规则。

## ★ 判据分两类，处置**必须**不同

```
C1 内部恒等式   → 不过 = DROPPED（唯一弃用理由）
C2~C4 外部一致  → 不过 = 只降级，绝不弃用
```

这条**在代码里是不同分支**，不是靠注释提醒 —— 第一次事故（`devlog/508`）
就是把 C3 当成了弃用理由，20 场完全可用的数据被判为"偏离"。

## 四条判据

| # | 判据 | 比较对象 | 不过时 |
|---|---|---|---|
| **C1** | 聚合恒等式 | `stats` 的上游汇总 vs 从 `raw` 现算 | **DROPPED** |
| C2 | 汇总与明细一致 | `ref_danmakus_count` vs 现算弹幕数 | degraded |
| C3 | 外部覆盖比 γ | 外部源的时间跨度 / 本模型的时间跨度 | **unverified** |
| C4 | 逐分钟一致性 ρ | 外部源与本模型的逐分钟条数相关 | degraded |

C3 的关键：**γ < 门槛时不能说"外部源说我们错了"** —— 那只说明外部源没收录全。
实测有 γ = 0.12 的场次，按"最近一条"对账会得出 **+622%** 的伪偏离。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence

from app.services.fan.loader import MIN_RECORDS, SessionRef, Window

# ── 具名常量（施工计划 A2）────────────────────────────────────────────────
#: 金额恒等式的浮点容差（元）
SUM_PRICE_TOL = 0.01
#: C2：现算弹幕数与上游汇总的相对偏差上限，超过只降级
SUMMARY_TOLERANCE = 0.15
#: C3：外部源的时间跨度覆盖比门槛；低于此值外部源**无权**用于判本模型
COVERAGE_FLOOR = 0.90
#: C4：逐分钟相关的下限，低于只降级
MINUTE_RHO_FLOOR = 0.80

STATUS_OK = "ok"
STATUS_DEGRADED = "degraded"
STATUS_UNVERIFIED = "unverified"
STATUS_DROPPED = "dropped"
STATUSES: tuple[str, str, str, str] = (
    STATUS_OK, STATUS_DEGRADED, STATUS_UNVERIFIED, STATUS_DROPPED,
)


@dataclass(frozen=True)
class ExternalRef:
    """外部源对同一场次的观测（可选）。

    全部字段都可以缺 —— 缺了只会让 C3/C4 记为"未验证"，**不会**导致弃用。
    """

    message: int | None = None        # 外部源的普通弹幕条数
    money: float | None = None        # 外部源的金额合计
    coverage: float | None = None     # γ = 外部跨度 / 本模型跨度
    minute_rho: float | None = None   # 逐分钟条数的 Spearman 相关


@dataclass
class Verdict:
    """一个场次的判定结果。"""

    live_id: str
    status: str
    reasons: list[str] = field(default_factory=list)
    details: dict[str, float] = field(default_factory=dict)

    @property
    def usable(self) -> bool:
        return self.status != STATUS_DROPPED


# ── C1 内部恒等式（唯一弃用判据）──────────────────────────────────────────
def check_identity(sr: SessionRef, *, min_records: int = MIN_RECORDS) -> list[str]:
    """C1：上游汇总 vs 从 raw 现算。返回**问题列表**（空 = 通过）。

    两条恒等式：

    - 弹幕：`type_hist["0"]` == `Σ_u m`
    - 金额：`sum_price` == `Σ_u p`（容差 `SUM_PRICE_TOL`）

    另含"记录数下限" —— 它与 C1 同属**内部判据**，因此也是弃用理由。
    """
    problems: list[str] = []
    if sr.records < min_records:
        problems.append(f"记录数 {sr.records} < {min_records}（C1 内部判据）")
        return problems
    if not sr.n_pairs:
        problems.append("raw 里没有任何 (人,场) 对（C1 内部判据）")
        return problems
    if sr.upstream_type0 != sr.sum_m:
        problems.append(
            f"弹幕恒等式破：上游 type0={sr.upstream_type0} vs 现算 {sr.sum_m}"
            f"（差 {sr.sum_m - sr.upstream_type0:+d}）"
        )
    if abs(sr.upstream_sum_price - sr.sum_pay) > SUM_PRICE_TOL:
        problems.append(
            f"金额恒等式破：上游 Σprice={sr.upstream_sum_price:.2f} vs "
            f"现算 {sr.sum_pay:.2f}"
        )
    return problems


# ── C2 汇总与明细一致（只降级）────────────────────────────────────────────
def check_summary(sr: SessionRef, *, tol: float = SUMMARY_TOLERANCE) -> list[str]:
    """C2：上游"场次列表"给的 `ref_danmakus_count` 与现算弹幕数的相对偏差。

    ⚠️ 缺字段时返回空（视为未检查），**不是**通过也不是失败。
    """
    ref = sr.stats.get("ref_danmakus_count")
    if ref is None:
        return []
    ref = int(ref)
    if ref <= 0 or sr.sum_m <= 0:
        return []
    dev = (sr.sum_m - ref) / ref
    if abs(dev) <= tol:
        return []
    return [f"汇总与明细偏差 {dev:+.1%}（上游 {ref} vs 现算 {sr.sum_m}）"]


# ── C3 外部覆盖比（只 unverified / degraded）──────────────────────────────
def check_coverage(ext: ExternalRef | None) -> list[str]:
    """C3：先问"外部源全不全"。**不全会直接让 C4 失效。**

    返回的问题列表语义是"外部源不可用于判本模型"，**不是**"本模型有问题"。
    """
    if ext is None:
        return ["外部源不可用（C3 未验证）"]
    if ext.coverage is None:
        return ["外部源未提供覆盖比（C3 未验证）"]
    if ext.coverage < COVERAGE_FLOOR:
        return [
            f"外部源只覆盖 {ext.coverage:.1%} 的时间跨度"
            f"（门槛 {COVERAGE_FLOOR:.0%}）⇒ 无权用于判本模型"
        ]
    return []


# ── C4 逐分钟一致性（只降级）──────────────────────────────────────────────
def check_minute(ext: ExternalRef | None, *, floor: float = MINUTE_RHO_FLOOR) -> list[str]:
    """C4：逐分钟条数的相关。**只在 C3 通过后才有意义**。"""
    if ext is None or ext.minute_rho is None:
        return []
    if ext.minute_rho >= floor:
        return []
    return [f"逐分钟相关 {ext.minute_rho:.3f} < {floor:.2f}"]


# ── 综合判定 ───────────────────────────────────────────────────────────────
def verdict(sr: SessionRef, *, external: ExternalRef | None = None) -> Verdict:
    """把 C1–C4 合成一个判定。

    **分支顺序很重要**：C1 不过直接 DROPPED，后面的判据不再参与；
    C2–C4 无论如何都只能产生 DEGRADED / UNVERIFIED。
    """
    details: dict[str, float] = {
        "records": sr.records,
        "sum_m": sr.sum_m,
        "sum_pay": round(sr.sum_pay, 4),
        "n_pairs": sr.n_pairs,
    }

    # ── C1：唯一可以判死的判据
    c1 = check_identity(sr)
    if c1:
        return Verdict(sr.live_id, STATUS_DROPPED, [f"C1 {x}" for x in c1], details)

    # ── C2：只降级
    reasons = [f"C2 {x}" for x in check_summary(sr)]

    # ── C3：外部源不可用 ⇒ unverified；覆盖不足 ⇒ 也是 unverified（不是我们错）
    c3 = check_coverage(external)
    if c3:
        reasons.extend(f"C3 {x}" for x in c3)
        details["coverage"] = float(external.coverage) if external and ext_is_num(external.coverage) else float("nan")
        return Verdict(sr.live_id, STATUS_UNVERIFIED, reasons, details)

    # ── C4：C3 通过才有意义
    c4 = check_minute(external)
    reasons.extend(f"C4 {x}" for x in c4)
    if external and external.coverage is not None:
        details["coverage"] = float(external.coverage)
    if external and external.minute_rho is not None:
        details["minute_rho"] = float(external.minute_rho)

    status = STATUS_DEGRADED if reasons else STATUS_OK
    return Verdict(sr.live_id, status, reasons, details)


def ext_is_num(x: object) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(float(x))


def check_window(
    win: Window,
    *,
    externals: Mapping[str, ExternalRef] | None = None,
) -> list[Verdict]:
    """对一个窗口里的每个场次做判定。`externals` 按 `live_id` 索引。"""
    exts = externals or {}
    return [verdict(sr, external=exts.get(sr.live_id)) for sr in win.sessions]


def summarize(verdicts: Sequence[Verdict]) -> dict[str, object]:
    """汇总：各状态的场次数 + 弃用率。**弃用率的分子只算 DROPPED。**"""
    counts = {s: 0 for s in STATUSES}
    for v in verdicts:
        counts[v.status] = counts.get(v.status, 0) + 1
    total = len(verdicts)
    return {
        "total": total,
        **counts,
        "dropped_rate": (counts[STATUS_DROPPED] / total) if total else 0.0,
        "usable": total - counts[STATUS_DROPPED],
    }


def dropped(verdicts: Sequence[Verdict]) -> list[str]:
    return [v.live_id for v in verdicts if v.status == STATUS_DROPPED]


__all__ = [
    "SUM_PRICE_TOL",
    "SUMMARY_TOLERANCE",
    "COVERAGE_FLOOR",
    "MINUTE_RHO_FLOOR",
    "STATUS_OK",
    "STATUS_DEGRADED",
    "STATUS_UNVERIFIED",
    "STATUS_DROPPED",
    "STATUSES",
    "ExternalRef",
    "Verdict",
    "check_identity",
    "check_summary",
    "check_coverage",
    "check_minute",
    "verdict",
    "check_window",
    "summarize",
    "dropped",
]
