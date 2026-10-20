"""`axes` + `compose` 的用例（P1）。

覆盖施工计划 §2 P1 的四条验收判据：

- **P1-1 与探针一致**：三 V 的入选池、类型分布、强度前 3 名与冻结的黄金值相等。
- **P1-2 分位变换的四条性质**：尺度自由 / 抗异常 / 并列 / 样本内。
- **P1-3 次序键确定性**：同一输入两次排序逐行相同，且并列处按次级键分开。
- **P1-4 效标加权防退化**：效标无方差时报错（这是"用错窗口"的信号）。

外加：OLS 能恢复已知系数、非负约束生效、纯 Python 不依赖 numpy。
"""

from __future__ import annotations

import math

import pytest

from app.services.fan import load_window, resolve_data_dir
from app.services.fan.axes import (
    AXES,
    AxisError,
    AxisTable,
    build_axis_table,
    empirical_percentile,
)
from app.services.fan.compose import (
    ComposeError,
    DegenerateOutcome,
    TYPE_MIXED,
    fit_criterion_weights,
    participation_strength,
    rank,
    type_label,
    value_under_criterion,
)

# ── P1-1 黄金值（规格口径：**全窗口**入选池；2026-10-20 重录）────────────────
# 重录原因（两项都要写清，否则以后没人知道为什么变）：
#   1. 数据回填：`stats` 的场次跨度此前混用本地时间，227 场中 76 场偏 +8h，
#      按天筛选与"最近 75 场"的取法因此改变；
#   2. 模型改动：出勤轴由「出席率」改为「出席场次 + 档内首次出场时机」的字典序
#      —— 见 `axes.build_axis_table` 与 docs/analysis/analysis-model.md §2.1′。
GOLDEN = {
    #            入选池   类型分布                                        强度前 3（uid, S）
    "弥月": (14_767,
             {"出勤": 3_155, "互动": 1_361, "付费": 480, "综合": 9_771},
             [("19871", 0.9999), ("1464721816", 0.9996), ("6094722", 0.9992)]),
    "明前奶绿": (34_443,
             {"出勤": 6_698, "互动": 4_255, "付费": 1_092, "综合": 22_398},
             [("431410658", 0.9999), ("13892390", 0.9999), ("259217653", 0.9992)]),
    "星瞳": (33_434,
             {"出勤": 6_499, "互动": 6_210, "付费": 6_957, "综合": 13_768},
             [("44947708", 0.9998), ("47844811", 0.9991), ("38025900", 0.9989)]),
}


def _require_data() -> None:
    try:
        resolve_data_dir()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"没有真实数据，跳过：{exc}")


@pytest.mark.parametrize("short", list(GOLDEN))
def test_outputs_match_golden(short: str) -> None:
    """P1-1：入选池 / 类型分布 / 强度前 3 与冻结值一致。"""
    _require_data()
    try:
        w = load_window(short, 75)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"{short} 数据不可用：{exc}")
    if not w.users:
        pytest.skip(f"{short} 无数据")
    t = build_axis_table(w)
    assert len(t) == GOLDEN[short][0]

    labels = type_label(t)
    got = {k: list(labels.values()).count(k) for k in ("出勤", "互动", "付费", "综合")}
    assert got == GOLDEN[short][1]

    s = participation_strength(t)
    order = rank(t, s)
    top3 = [(order[i], round(s[order[i]], 4)) for i in range(3)]
    for (uid_g, val_g), (uid_w, val_w) in zip(top3, GOLDEN[short][2]):
        assert uid_g == uid_w
        assert abs(val_g - val_w) < 1e-3


# ── P1-2 分位变换的四条性质 ────────────────────────────────────────────────
def test_property_scale_free() -> None:
    """性质 1：对**正比缩放**不变（分位只看序）。"""
    ref = [0.0, 1.0, 2.0, 2.0, 5.0, 100.0]
    a = empirical_percentile(ref, reference=ref)
    b = empirical_percentile([x * 1000 for x in ref], reference=[x * 1000 for x in ref])
    assert a == pytest.approx(b)


def test_property_robust_to_outlier() -> None:
    """性质 2：往参照里塞一个极端值，**其余人的秩序与分位只平移 1/n**。"""
    base = [1.0, 2.0, 3.0, 4.0, 5.0]
    p_base = empirical_percentile(base, reference=base)
    with_outlier = base + [1e9]
    p_out = empirical_percentile(base, reference=with_outlier)
    # 极端值只把所有人往上推一个名次，不会重排
    order_ok = all((p_base[i] < p_base[j]) == (p_out[i] < p_out[j])
                   for i in range(len(base)) for j in range(len(base)))
    assert order_ok, "异常值不得改变其余人的相对次序"
    assert max(abs(a - b) for a, b in zip(p_base, p_out)) <= 1 / len(base) + 1e-12


def test_property_ties_share_percentile() -> None:
    """性质 3：并列取同一分位（平均秩）。"""
    ref = [1.0, 2.0, 2.0, 2.0, 5.0]
    p = empirical_percentile(ref, reference=ref)
    assert p[1] == p[2] == p[3]
    assert p[0] < p[1] < p[4]


def test_property_sample_relative() -> None:
    """性质 4：同一个值在不同参照总体里分位不同 —— 这就是"不可跨 V 比"的根源。"""
    v = 5.0
    low_ref = [1.0, 2.0, 3.0, 5.0, 100.0]
    high_ref = [50.0, 60.0, 70.0, 80.0, 90.0]
    p_low = empirical_percentile([v], reference=low_ref)[0]
    p_high = empirical_percentile([v], reference=high_ref)[0]
    assert p_low > p_high
    assert p_low == pytest.approx(4 / 5)   # 1 基平均秩 4
    assert p_high == pytest.approx(1 / 10)  # 落在最小空隙的中点：0.5/5


def test_empty_reference_raises() -> None:
    with pytest.raises(AxisError, match="参照总体"):
        empirical_percentile([1.0], reference=[])


def test_nan_raises() -> None:
    with pytest.raises(AxisError):
        empirical_percentile([float("nan")], reference=[1.0])


def test_percentile_is_monotone_and_bounded() -> None:
    """分位必须单调且落在 (0, 1]。"""
    ref = [0.0, 0.0, 1.0, 5.0, 5.0, 5.0, 9.0]
    p = empirical_percentile(ref, reference=ref)
    assert all(0 < x <= 1 for x in p)
    assert p == sorted(p)


# ── 合成：强度 / 类型 ───────────────────────────────────────────────────────
def _table(pcts: dict[str, dict[str, float]]) -> AxisTable:
    t = AxisTable("测试", 10, 0.10, tuple(pcts))
    for uid, p in pcts.items():
        t.raw[uid] = dict(p)
        t.pct[uid] = dict(p)
        t.tie[uid] = {"pay": 0.0, "msg": 0.0, "last_pos": 0.0}
    return t


def test_strength_is_equal_weighted_mean() -> None:
    t = _table({"u1": {"attendance": 1.0, "interaction": 1.0, "payment": 1.0},
                "u2": {"attendance": 0.0, "interaction": 0.0, "payment": 0.0}})
    s = participation_strength(t)
    assert s["u1"] == pytest.approx(1.0)
    # 分位不会真的为 0（1 基），但这里是我们构造的输入
    assert s["u2"] == pytest.approx(0.0)


def test_strength_treats_axes_symmetrically() -> None:
    """交换任意两个轴的分位，强度不变 —— 等权、无偏。"""
    a = {"attendance": 0.9, "interaction": 0.1, "payment": 0.5}
    b = {"attendance": 0.1, "interaction": 0.9, "payment": 0.5}
    sa = participation_strength(_table({"u": a}))["u"]
    sb = participation_strength(_table({"u": b}))["u"]
    assert sa == pytest.approx(sb)


def test_type_dominant_axis() -> None:
    t = _table({"u1": {"attendance": 0.9, "interaction": 0.2, "payment": 0.1},
                "u2": {"attendance": 0.1, "interaction": 0.9, "payment": 0.2},
                "u3": {"attendance": 0.1, "interaction": 0.2, "payment": 0.9}})
    assert type_label(t) == {"u1": "出勤", "u2": "互动", "u3": "付费"}


def test_type_mixed_when_purity_below_threshold() -> None:
    """纯度 = 最高 − 次高 < 0.15 ⇒ 综合型。"""
    t = _table({"u": {"attendance": 0.80, "interaction": 0.70, "payment": 0.1}})
    assert type_label(t)["u"] == TYPE_MIXED


def test_type_boundary_is_inclusive() -> None:
    """纯度**恰等于**阈值时应判为主导型（条件写的是 `< purity` 才是综合）。"""
    t = _table({"u": {"attendance": 0.85, "interaction": 0.70, "payment": 0.1}})
    assert type_label(t)["u"] == "出勤"


# ── 效标加权：OLS ──────────────────────────────────────────────────────────
def test_ols_recovers_known_slopes() -> None:
    """构造 y = 0.5·x1 + 0·x2 + 0·x3 ⇒ 拟合应恢复。"""
    rows, ys = [], []
    for i in range(200):
        x1 = i / 200
        x2 = ((i * 7) % 200) / 200
        x3 = ((i * 13) % 200) / 200
        rows.append([x1, x2, x3])
        ys.append(0.5 * x1)
    fit = fit_criterion_weights(rows, ys, criterion="测试")
    assert fit.slopes[0] == pytest.approx(0.5, abs=1e-6)
    assert fit.slopes[1] == pytest.approx(0.0, abs=1e-6)
    assert fit.weights == pytest.approx((1.0, 0.0, 0.0))
    assert fit.r2 == pytest.approx(1.0, abs=1e-6)


def test_weights_are_non_negative_and_normalized() -> None:
    """原始 β 为负时，权重截到 0 并归一 —— 不允许"负权重"进解释。"""
    rows, ys = [], []
    for i in range(300):
        x1 = i / 300
        rows.append([x1, ((i * 7) % 300) / 300, ((i * 13) % 300) / 300])
        ys.append(-2.0 * x1 + (i % 5) * 1e-6)
    fit = fit_criterion_weights(rows, ys, criterion="负向")
    assert fit.slopes[0] < 0
    assert all(w >= 0 for w in fit.weights)
    assert sum(fit.weights) == pytest.approx(1.0)


def test_degenerate_outcome_raises() -> None:
    """P1-4：效标无方差 ⇒ 报错。

    这是"用了全窗口预测子去预测后半窗口"的信号 —— 那种用法下 `y` 几乎恒为 1。
    """
    rows = [[i / 100, (i % 7) / 7, (i % 11) / 11] for i in range(100)]
    with pytest.raises(DegenerateOutcome, match="无方差"):
        fit_criterion_weights(rows, [1.0] * 100, criterion="退化")


def test_too_few_samples_raises() -> None:
    with pytest.raises(ComposeError, match="样本不足"):
        fit_criterion_weights([[0.1, 0.2, 0.3]] * 5, [0.0, 1.0, 0.0, 1.0, 1.0],
                              criterion="少")


def test_value_under_criterion_uses_weights() -> None:
    t = _table({"u": {"attendance": 1.0, "interaction": 0.0, "payment": 0.0}})
    # 三列都要有方差，否则正规方程奇异（前一版测试就踩了这个）
    rows = [[i / 100, (i % 7) / 7, (i % 11) / 11] for i in range(100)]
    ys = [i / 100 for i in range(100)]
    fit = fit_criterion_weights(rows, ys, criterion="收入")
    assert value_under_criterion(t, fit)["u"] == pytest.approx(fit.weights[0])


# ── P1-3 次序键 ────────────────────────────────────────────────────────────
def test_rank_is_deterministic() -> None:
    """P1-3：同一输入跑两次，名单逐行相同。"""
    t = _table({f"u{i}": {"attendance": 0.5, "interaction": 0.5, "payment": 0.5}
                for i in range(50)})
    s = participation_strength(t)
    assert rank(t, s) == rank(t, s)


def test_rank_breaks_ties_by_secondary_keys() -> None:
    """主键全并列时，按 累计付费↓ → 总弹幕↓ → 末次出席↓ → uid↑ 分开。"""
    t = _table({f"u{i}": {"attendance": 0.5, "interaction": 0.5, "payment": 0.5}
                for i in range(4)})
    t.tie["u0"] = {"pay": 100.0, "msg": 0.0, "last_pos": 0.0}
    t.tie["u1"] = {"pay": 0.0, "msg": 500.0, "last_pos": 0.0}
    t.tie["u2"] = {"pay": 0.0, "msg": 0.0, "last_pos": 0.9}
    t.tie["u3"] = {"pay": 0.0, "msg": 0.0, "last_pos": 0.0}
    s = participation_strength(t)
    assert rank(t, s) == ["u0", "u1", "u2", "u3"]


def test_rank_missing_primary_raises() -> None:
    t = _table({"u1": {"attendance": 1.0, "interaction": 1.0, "payment": 1.0}})
    with pytest.raises(ComposeError, match="primary 缺少"):
        rank(t, {})


# ── 依赖约束 ───────────────────────────────────────────────────────────────
def test_no_numpy_dependency() -> None:
    """P1 的模块**不得**引入 numpy —— 应用运行时没有它。"""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / "app" / "services" / "fan"
    for name in ("axes.py", "compose.py", "loader.py"):
        src = (root / name).read_text(encoding="utf-8")
        assert "import numpy" not in src, f"{name} 引入了 numpy"
