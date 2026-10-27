"""L3：**不变量告警**（2026-10-27）。

与黄金值（钉死具体数字、重采必重录）不同，这里只断言**关系**，因此：

- 数据换了、场次多了，**不需要重录**；
- 但"采集静默丢数据 / 口径写坏 / 恒等式被破坏"这类问题会被抓住。

覆盖：
1. 每场 C1 内部恒等式（raw 现算 vs stats 声称）；
2. 全局 Σ 一致性（各用户聚合之和 vs 各场求和）；
3. 池占比落在合理区间（防止 ACV 或分位算法写崩）；
4. 每场覆盖率 ≥ 95%（采集完整性的最后一道闸）；
5. 类型分布不被单一标签吞掉（> 85% 视为判据失效）。
"""

from __future__ import annotations

import pytest

from app.services.fan import load_window, resolve_data_dir
from app.services.fan.axes import build_axis_table
from app.services.fan.checks import check_identity
from app.services.fan.compose import type_label
from app.services.fan.pool import pool_size_for

VSHORTS = ["弥月", "明前奶绿", "星瞳", "七海"]


def _window(short: str, n: int = 75):
    try:
        resolve_data_dir()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"没有真实数据：{exc}")
    try:
        w = load_window(short, n)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"{short} 数据不可用：{exc}")
    if not w.users:
        pytest.skip(f"{short} 无数据")
    return w


@pytest.mark.parametrize("short", VSHORTS)
def test_c1_identity_holds_for_every_session(short: str) -> None:
    """① 每场：raw 现算与 stats 声称必须自洽。"""
    w = _window(short)
    bad = []
    for s in w.sessions:
        problems = check_identity(s)
        if problems:
            bad.append((s.live_id[:8], problems[0]))
    assert not bad, f"{short} 有 {len(bad)} 场破坏 C1：{bad[:3]}"


@pytest.mark.parametrize("short", VSHORTS)
def test_global_sums_match_session_sums(short: str) -> None:
    """② 全局：各用户聚合之和 = 各场求和（两条独立路径必须对得上）。"""
    w = _window(short)
    sum_m_users = sum(u.m for u in w.users.values())
    sum_m_sessions = sum(s.sum_m or 0 for s in w.sessions)
    assert sum_m_users == sum_m_sessions, f"{short} 弹幕总数不一致：{sum_m_users} vs {sum_m_sessions}"


@pytest.mark.parametrize("short", VSHORTS)
def test_pool_ratio_is_sane(short: str) -> None:
    """③ 池占比：既不能是 0，也不能把大半观众都塞进名单（实测 2.7%–2.9%）。"""
    w = _window(short)
    pool = pool_size_for(w)
    total = len(w.users)
    assert pool > 0, f"{short} 池为空"
    ratio = pool / total
    # 实测 2.7%–2.9%（池 = 3×ACV，而分母是"全部看过的人"，天然很小）
    assert 0.005 <= ratio <= 0.2, f"{short} 池占比异常：{ratio:.1%}（{pool}/{total}）"


@pytest.mark.parametrize("short", VSHORTS)
def test_type_distribution_not_dominated(short: str) -> None:
    """④ 类型分布：单一标签超过 85% 说明判据失效（分位或阈值写坏）。"""
    w = _window(short)
    t = build_axis_table(w, pool_size=pool_size_for(w))
    labels = list(type_label(t).values())
    assert labels, f"{short} 没有类型标签"
    top = max(labels.count(k) for k in set(labels))
    assert top / len(labels) <= 0.85, f"{short} 单一类型占 {top / len(labels):.0%}"


@pytest.mark.parametrize("short", VSHORTS)
def test_coverage_per_session_is_complete(short: str) -> None:
    """⑤ 覆盖率：采集到的条数 / 平台计数 ≥ 95%（低于此说明分页或上游有问题）。"""
    w = _window(short)
    low = []
    for s in w.sessions:
        cov = (s.stats or {}).get("coverage") or {}
        ratio = cov.get("ratio")
        if isinstance(ratio, (int, float)) and ratio < 0.95:
            low.append((s.live_id[:8], ratio))
    assert not low, f"{short} 有 {len(low)} 场覆盖率不足：{low[:3]}"
