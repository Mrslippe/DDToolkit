# -*- coding: utf-8 -*-
"""探针 WCAG 2.2 SC 2.5.8「点击目标」判据自身的用例（`scripts/ui_probe.py`）。

为什么给它写用例：这段判据是**几何**，而几何判据的第一版**真的算错了** ——
我最初写「方块角点到圆角圆心的距离 ≤ r」，把实测的 326×25 胶囊判成不合格（假红）：
方块角在 x=±12，离圆角圆心 x=±150.5 有 138px，看着"远在圆外"，
但那段是**直边中段**，根本没被圆角削掉。

**自洽的公式不一定是正确的公式** ⇒ 这些用例把标准原文的两个条件各自钉住：
① 装得下 24×24 轴对齐方块（含标准 Figure 3 那个"圆装不下"的反例）；
② 装不下时的间距例外（24px 圆不与相邻目标/相邻欠尺寸目标的圆相交）。
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import ui_probe as U  # noqa: E402


# ── ① Size requirement：目标里装得下 24×24 轴对齐方块 ─────────────────────────
@pytest.mark.parametrize("w,h,radius,want,why", [
    # 本仓实测值（1600 档，探针读回来的）
    (302, 25, 999, True, "顶栏胶囊实测 302×25（`border-radius:999px` → clamp 到 12.5）"),
    (65, 25, 999, True, "面板动作钮实测 65×25"),
    (326, 25, 999, True, "R38 批 5 收尾首次实测值（回归：这一条曾被判 False）"),
    # 边界：高 25 的完美胶囊需 **宽 ≥ 42**（方块角 (12,12) 恰好落在右半圆起点上）
    (42, 25, 12.5, True, "临界值：恰好装得下"),
    (41, 25, 12.5, False, "比临界少 1px ⇒ 装不下（这条是那个推导的牙）"),
    # 标准正文与 Figure 3
    (24, 24, 0, True, "直角 24×24 —— 标准正文的例子"),
    (24, 24, 12, False, "24×24 圆 —— 标准 Figure 3 的反例（圆装不下方块）"),
    (25, 25, 12.5, False, "25×25 圆：方块对角线 24√2≈33.9 > 25"),
    # 单边不足
    (326, 23, 999, False, "高 23 < 24"),
    (23, 100, 0, False, "宽 23 < 24"),
    # 小窗胶囊（实测 200×40）
    (200, 40, 999, True, "小窗宿主 200×40"),
])
def test_square_fit(w, h, radius, want, why):
    assert U._wcag_square_fits(w, h, radius) is want, why


def test_square_fit_wide_flat_capsule_is_not_a_false_red():
    """回归：宽而扁的胶囊**不能**因为"角点离圆角圆心很远"被判 False。

    这正是第一版的错法 —— 角点落在**直边中段**，那里没有被圆角削掉。
    """
    assert U._wcag_square_fits(326, 25, 999) is True
    assert U._wcag_square_fits(5000, 25, 999) is True, "越宽越该通过，不是越宽越可疑"


# ── ② Spacing 例外：24px 圆不与相邻目标相交 ──────────────────────────────────
def _t(sel, x, y, w, h, radius=999):
    return {"sel": sel, "x": x, "y": y, "w": w, "h": h, "radius": radius}


def test_spacing_exception_passes_when_far_apart():
    """实测：65×20 的动作钮与胶囊中心距 76px ⇒ 间距例外成立（标准判**通过**）。

    ⚠️ 这条是反向验证时发现的：把动作钮单独缩小**不报红**，一度以为判据没牙；
    手算确认中心距 76px（24px 圆半径才 12）⇒ **标准确实允许**。
    判据忠实于标准，不是没牙 —— 记在这里免得下次又怀疑一遍。
    """
    btn = _t(".si-item-action[0]", 878, 100, 65, 20)
    pill = _t(".si-island", 637, 8, 302, 25)
    assert U._wcag_circles_clear(btn, [btn, pill]) is True


def test_spacing_exception_fails_when_too_close():
    """把动作钮挪到胶囊正下方 20px 内 ⇒ 圆相交 ⇒ 例外不成立。"""
    btn = _t(".si-item-action[0]", 878, 35, 20, 18)
    pill = _t(".si-island", 637, 8, 302, 25)
    assert U._wcag_circles_clear(btn, [btn, pill]) is False


def test_spacing_exception_ignores_itself():
    """自己和自己的圆当然重合 —— 不能把自己算成"相邻目标"。"""
    btn = _t(".si-item-action[0]", 878, 100, 20, 18)
    assert U._wcag_circles_clear(btn, [btn]) is True


def test_spacing_exception_checks_other_undersized_circles():
    """两个**都欠尺寸**的目标、中心距 20px：圆（直径 24）会相交 ⇒ 不通过。"""
    a = _t("a", 0, 0, 20, 18)
    b = _t("b", 20, 0, 20, 18)
    assert U._wcag_circles_clear(a, [a, b]) is False
    # 拉开到 ≥ 24px 就通过
    b2 = _t("b", 25, 0, 20, 18)
    assert U._wcag_circles_clear(a, [a, b2]) is True


# ── ③ 判据函数：空样本必须报"空转"，不能静默全绿 ─────────────────────────────
def test_assert_hit_targets_flags_empty_sample():
    """采不到目标 ⇒ 判据空转。**宁可变红**也不要"看起来绿"（本仓反向验证纪律）。"""
    fails = U._assert_hit_targets({"hitTargets": []}, 1600)
    assert fails and "空转" in fails[0]


def test_assert_hit_targets_passes_real_measurements():
    """用探针真读回来的那一组矩形跑一遍（含胶囊 + 动作钮 + 顶栏邻居）。"""
    si = {
        "hitTargets": [
            _t(".si-island", 637, 8, 302, 25),
            _t(".si-item-action[0]", 878, 97, 65, 25),
            _t(".topbar-neighbor[1]", 1392, 0, 46, 40, radius=0),
        ],
        "pillBox": {"w": 302, "h": 25},
        "pillRadius": 999,
    }
    assert U._assert_hit_targets(si, 1600) == []


def test_assert_hit_targets_red_for_undersized_and_crowded():
    """尺寸与间距**双双**不满足 ⇒ 报红，且文案里点名了是哪个目标。"""
    si = {
        "hitTargets": [
            _t(".si-island", 637, 8, 302, 25),
            _t(".si-item-action[0]", 923, 35, 20, 18),
        ],
        "pillBox": {"w": 302, "h": 25},
        "pillRadius": 999,
    }
    fails = U._assert_hit_targets(si, 1600)
    assert fails and ".si-item-action[0]" in fails[0]
    assert "24×24" in fails[0] and "WCAG" in fails[0]
