"""粉丝结构分析 · 效标加权（P1 的后半，规格 §4.3）。

## 为什么单独一个模块

`compose.fit_criterion_weights()` 是**纯数学**（给预测子与结果，解 OLS）。
本模块负责**怎么切出这两样东西** —— 而这里有一处极易错的地方：

> **预测子只能来自"过去"。**

若用全窗口的三轴预测后半窗口的结果，`y` 几乎恒为 1（入选者留存率 91.6%~94.0%），
方差趋近 0，`β` 退化为噪声。实测三个 V 都踩过这个坑（`devlog/508` 的 bootstrap 退化）。

所以本模块强制：**前半窗口定池、定分位；后半窗口出结果**。
`compose.fit_criterion_weights` 在 `y` 无方差时会抛 `DegenerateOutcome` 作为第二道闸门。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from app.services.fan.axes import INCLUSION_FLOOR, AxisTable, build_axis_table
from app.services.fan.compose import CriterionFit, fit_criterion_weights
from app.services.fan.loader import Window, load_window

# ── 具名常量（施工计划 A2）────────────────────────────────────────────────
CRITERION_RETENTION = "retention"
CRITERION_INCOME = "income"
#: 支持的效标；**没有默认值** —— 调用方必须显式选（规格 §4.3 的要求）
CRITERIA: tuple[str, str] = (CRITERION_RETENTION, CRITERION_INCOME)

CRITERION_DESC = {
    CRITERION_RETENTION: "后半窗口是否还出现（留存）",
    CRITERION_INCOME: "后半窗口付费额的对数（收入）",
}


@dataclass(frozen=True)
class FittedCriterion:
    """一次效标加权的完整结果。"""

    criterion: str
    fit: CriterionFit
    #: 入模样本量（前半池里在后半也有记录的人不需要 —— 缺失按"没出现"处理）
    n_predictors: int


def half_windows(
    vtuber: object,
    n: int,
    *,
    root: Path | None = None,
) -> tuple[Window, Window]:
    """把窗口切成前半 / 后半。前半用于**定池与定分位**，后半用于**出结果**。"""
    first = load_window(vtuber, n, root=root, keep=lambda i, t: i < t // 2)
    second = load_window(vtuber, n, root=root, keep=lambda i, t: i >= t // 2)
    return first, second


def build_dataset(
    first: Window,
    second: Window,
    *,
    criterion: str,
    floor: float = INCLUSION_FLOOR,
) -> tuple[list[str], list[list[float]], list[float]]:
    """构造 `(uids, predictors, outcomes)`。

    - **池**：前半窗口出席率 ≥ `floor` 的人（规格 §1.2）。
    - **预测子**：前半窗口的三轴分位（`AxisTable.pct`）。
    - **结果**：后半窗口的表现。**没在后半出现 = 留存 0 / 收入 0**。
    """
    if criterion not in CRITERIA:
        raise ValueError(f"未知效标 {criterion!r}；可用：{CRITERIA}")

    table = build_axis_table(first, floor=floor)
    if len(table) == 0:
        return [], [], []

    from app.services.fan.axes import AXES

    uids = list(table.uids)
    predictors = [[table.pct[uid][a] for a in AXES] for uid in uids]
    outcomes: list[float] = []
    for uid in uids:
        u = second.users.get(uid)
        if criterion == CRITERION_RETENTION:
            outcomes.append(1.0 if u is not None else 0.0)
        else:
            outcomes.append(math.log1p(u.pay) if u is not None else 0.0)
    return uids, predictors, outcomes


def fit(
    win: Window,
    criterion: str,
    *,
    root: Path | None = None,
) -> FittedCriterion:
    """对 `win` 的窗口做效标拟合。

    ⚠️ `win` 只用于取 `vtuber` 与 `requested_n`；**预测子与结果都从切半窗口重算**，
    不复用 `win` 的全窗分位（那就是"用未来预测过去"）。
    """
    if criterion not in CRITERIA:
        raise ValueError(f"未知效标 {criterion!r}；可用：{CRITERIA}")
    first, second = half_windows(win.vtuber, win.requested_n, root=root)
    _uids, predictors, outcomes = build_dataset(first, second, criterion=criterion)
    fitted = fit_criterion_weights(predictors, outcomes, criterion=criterion)
    return FittedCriterion(criterion, fitted, len(predictors))


def score(table: AxisTable, fitted: CriterionFit) -> dict[str, float]:
    """把拟合出的权重应用到**要展示的**分位上（全窗口分位）。"""
    from app.services.fan.axes import AXES

    out: dict[str, float] = {}
    for uid in table.uids:
        p = table.pct[uid]
        out[uid] = sum(w * p[a] for w, a in zip(fitted.weights, AXES))
    return out


__all__ = [
    "CRITERION_RETENTION",
    "CRITERION_INCOME",
    "CRITERIA",
    "CRITERION_DESC",
    "FittedCriterion",
    "half_windows",
    "build_dataset",
    "fit",
    "score",
]
