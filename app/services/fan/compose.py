"""粉丝结构分析 · 合成与输出（P1）。

对应规格 `plans/fan-model-plan.md` §4。**不依赖 numpy** —— OLS 用纯 Python 的高斯消元解。

## 三个输出，**必须分开调用**

本模块**故意不提供** `score()` 这类一揽子函数。理由见规格 §4.1：
一个叫"核心度"的单数字会被读成价值判断，而它其实只是"行为强度"。API 层面也不给被误用的机会。

| 函数 | 输出 | 性质 |
|---|---|---|
| `participation_strength()` | 参与强度 $S$ | **目标中立**，不含价值判断 |
| `type_label()` | 类型标注 | **约定**，不是发现的类别 |
| `fit_criterion_weights()` | 效标权重 $w$ | **必须显式声明效标** |
| `value_under_criterion()` | 效标加权分 $V_y$ | 带 `criterion` 名字 |
| `rank()` | 名单 | 带次序键，确定性 |

## 为什么 OLS 手写

应用运行时（`.venv`）**没有 numpy**。三分量 OLS 是 4×4 正规方程，用带部分主元的高斯消元
足够稳，且不引入新依赖。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

from app.services.fan.axes import (
    AXIS_ATTENDANCE,
    AXIS_INTERACTION,
    AXIS_PAYMENT,
    AXES,
    AxisError,
    AxisTable,
)

# ── 具名常量（施工计划 A2）────────────────────────────────────────────────
#: 类型纯度门槛：最高分位 − 次高分位 不低于此值才算"主导型"（规格 §4.2）
PURITY_THRESHOLD = 0.15
#: 参与强度的三轴权重 —— **等权**，理由见规格 §4.1（不存在同时最优的权重）
STRENGTH_WEIGHTS: tuple[float, float, float] = (1 / 3, 1 / 3, 1 / 3)

TYPE_ATTENDANCE = "出勤"
TYPE_INTERACTION = "互动"
TYPE_PAYMENT = "付费"
TYPE_MIXED = "综合"
TYPE_LABELS: tuple[str, str, str, str] = (
    TYPE_ATTENDANCE, TYPE_INTERACTION, TYPE_PAYMENT, TYPE_MIXED,
)
_AXIS_TO_TYPE = {
    AXIS_ATTENDANCE: TYPE_ATTENDANCE,
    AXIS_INTERACTION: TYPE_INTERACTION,
    AXIS_PAYMENT: TYPE_PAYMENT,
}


class ComposeError(Exception):
    """合成的可恢复错误。"""


class DegenerateOutcome(ComposeError):
    """效标无方差 —— 无法拟合权重。

    典型成因：**用了全窗口的预测子去预测后半窗口**。那样 `y` 几乎恒为 1，
    `beta` 退化为噪声。正确做法是用**前半窗口**的观测定池与定分位（规格 §4.3）。
    """


# ── 三个输出 ───────────────────────────────────────────────────────────────
def participation_strength(table: AxisTable) -> dict[str, float]:
    """参与强度 $S(u)=\\frac13(\\pi_A+\\pi_I+\\pi_P)$。

    **目标中立**：三个轴等权，不偏向任何效标。可用它排序"行为上最像核心的人"，
    **不能**用它回答"谁更值得重视"。
    """
    out: dict[str, float] = {}
    for uid in table.uids:
        p = table.pct[uid]
        out[uid] = sum(w * p[a] for w, a in zip(STRENGTH_WEIGHTS, AXES))
    return out


def type_label(
    table: AxisTable,
    *,
    purity: float = PURITY_THRESHOLD,
) -> dict[str, str]:
    """类型标注：主导轴 + 纯度门槛，否则「综合」。

    ⚠️ **这是约定，不是发现的类别**。规格 §5.3 的三条证据（轮廓系数无峰、纯度中位
    0.074~0.158、付费率随出席平滑单调）都指向连续谱。
    """
    out: dict[str, str] = {}
    for uid in table.uids:
        p = table.pct[uid]
        ordered = sorted((p[a] for a in AXES), reverse=True)
        if ordered[0] - ordered[1] < purity:
            out[uid] = TYPE_MIXED
            continue
        top_axis = max(AXES, key=lambda a: p[a])
        out[uid] = _AXIS_TO_TYPE[top_axis]
    return out


# ── 效标加权 ───────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class CriterionFit:
    """一次效标拟合的结果。"""

    criterion: str
    slopes: tuple[float, float, float]   # 三轴原始 β（含负值）
    weights: tuple[float, float, float]  # 非负归一的 w
    r2: float
    n: int


def _solve(matrix: list[list[float]], rhs: list[float]) -> list[float]:
    """带部分主元的高斯消元。矩阵小（≤4），直接做。"""
    n = len(matrix)
    a = [row[:] + [rhs[i]] for i, row in enumerate(matrix)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            raise ComposeError("正规方程奇异 —— 预测子完全共线")
        a[col], a[piv] = a[piv], a[col]
        pv = a[col][col]
        for r in range(col + 1, n):
            factor = a[r][col] / pv
            if factor == 0.0:
                continue
            for c in range(col, n + 1):
                a[r][c] -= factor * a[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = a[r][n] - sum(a[r][c] * x[c] for c in range(r + 1, n))
        x[r] = s / a[r][r]
    return x


def fit_criterion_weights(
    predictors: Sequence[Sequence[float]],
    outcomes: Sequence[float],
    *,
    criterion: str,
) -> CriterionFit:
    """对给定效标拟合三轴权重（规格 §4.3）。

    Args:
        predictors: $n\\times3$ 的三轴**分位**（来自**前半窗口**，见 `DegenerateOutcome`）。
        outcomes: 长度 $n$ 的效标值。
        criterion: 效标名，写进返回值供调用方展示。

    Returns:
        `CriterionFit`：原始 β、非负归一权重、$R^2$、样本量。

    Raises:
        DegenerateOutcome: $y$ 无方差（预测子用错了窗口）。
        ComposeError: 样本不足或预测子共线。
    """
    n = len(predictors)
    if n < 30:
        raise ComposeError(f"样本不足（{n} < 30），无法拟合权重")
    if len(outcomes) != n:
        raise ComposeError("predictors 与 outcomes 长度不一致")

    ys = [float(y) for y in outcomes]
    mean_y = sum(ys) / n
    var_y = sum((y - mean_y) ** 2 for y in ys) / n
    if math.sqrt(var_y) < 1e-9:
        raise DegenerateOutcome(
            f"效标 {criterion!r} 无方差 —— 预测子必须来自**前半窗口**，"
            "否则后半窗口的结果几乎恒为常数"
        )

    # 正规方程（含截距）: [1, x1, x2, x3] 共 4 列
    k = 4
    xtx = [[0.0] * k for _ in range(k)]
    xty = [0.0] * k
    for row, y in zip(predictors, ys):
        v = [1.0] + [float(x) for x in row]
        for i in range(k):
            xty[i] += v[i] * y
            for j in range(k):
                xtx[i][j] += v[i] * v[j]
    beta = _solve(xtx, xty)

    # R²
    sse = 0.0
    sst = 0.0
    for row, y in zip(predictors, ys):
        pred = beta[0] + sum(b * float(x) for b, x in zip(beta[1:], row))
        sse += (y - pred) ** 2
        sst += (y - mean_y) ** 2
    r2 = 1.0 - sse / sst if sst > 0 else 0.0

    slopes = (beta[1], beta[2], beta[3])
    clipped = [max(0.0, s) for s in slopes]
    total = sum(clipped)
    weights = ((1 / 3, 1 / 3, 1 / 3) if total <= 0
               else tuple(c / total for c in clipped))  # type: ignore[assignment]
    return CriterionFit(criterion, slopes, weights, r2, n)  # type: ignore[arg-type]


def income_outcome(pay: float) -> float:
    """效标用的**收入目标变量**：`log1p`，不是原始金额。

    为什么必须取对数（2026-10-21 实测，明前奶绿后半窗 37,225 人）：

    - **90.6% 的人一分钱没花**（星瞳 87.4%）；
    - **前 1% 的付费者贡献 89.5% 的收入**（星瞳 93.5%）。

    原始金额做线性回归时，这几个"鲸鱼"会主导残差平方和 —— R² 只有 0.022，
    而同一批预测变量在 log 尺度上是 **0.200**。也就是说：模型能排"谁更可能付费"，
    排不了"谁会打大钱"。用原始金额当效标，等于拿不可预测的极值惩罚一个本来有效的模型。
    """
    return math.log1p(max(0.0, float(pay)))


def retention_outcome(att_before: int, att_after: int, *, drop: float = 0.5) -> float:
    """效标用的**留存目标变量**：出席率跌幅**超过** `drop` 记 1（流失），否则 0。

    边界取严格小于：正好剩一半（10 → 5）不算流失 —— 与 10-17 记录的 0.073 对齐。

    不能直接用"后半有没有来"（2026-10-21 实测）：

    - 入选池要求前半出席率 ≥10%，这批人**本来就是常客**；
    - 于是后半留存率高达 **98.4%**（星瞳 98.2%），二值方差只有 0.0157；
    - 在 98% 的基准率下，任何排序的 R² 都注定很低（实测 0.024–0.036），
      这不是模型弱，是**目标变量没有方差**。

    换成"相对跌幅"后，目标重新有了区分度。
    """
    before = max(1, int(att_before))
    return 1.0 if int(att_after) < drop * before else 0.0


def value_under_criterion(
    table: AxisTable,
    fit: CriterionFit,
) -> dict[str, float]:
    """按效标拟合出的权重给每人打分：$V_y(u)=\\sum_k w_k\\pi_k(u)$。"""
    out: dict[str, float] = {}
    for uid in table.uids:
        p = table.pct[uid]
        out[uid] = sum(w * p[a] for w, a in zip(fit.weights, AXES))
    return out


# ── 排序 ───────────────────────────────────────────────────────────────────
def rank(table: AxisTable, primary: Mapping[str, float]) -> list[str]:
    """按 `primary` 降序排序，带**完整次序键**（规格 §4.4）。

    键 = (主键↓, 累计付费↓, 总弹幕↓, 末次出席位置↓, uid↑)

    最后一级 uid 保证**确定性**：同一输入必得同一输出。
    """
    missing = [u for u in table.uids if u not in primary]
    if missing:
        raise ComposeError(f"primary 缺少 {len(missing)} 个 uid，例如 {missing[:3]}")

    def key(uid: str) -> tuple:
        tie = table.tie[uid]
        return (
            -primary[uid],
            -tie["pay"],
            -tie["msg"],
            -tie["last_pos"],
            uid,   # 字符串升序即可，只需要确定性
        )

    return sorted(table.uids, key=key)


__all__ = [
    "PURITY_THRESHOLD",
    "STRENGTH_WEIGHTS",
    "TYPE_ATTENDANCE",
    "TYPE_INTERACTION",
    "TYPE_PAYMENT",
    "TYPE_MIXED",
    "TYPE_LABELS",
    "ComposeError",
    "DegenerateOutcome",
    "CriterionFit",
    "participation_strength",
    "type_label",
    "fit_criterion_weights",
    "value_under_criterion",
    "rank",
]
