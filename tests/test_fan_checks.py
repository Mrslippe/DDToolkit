"""`checks` 的用例（P2）。

施工计划 §2 P2 的验收判据，重点是**三条反向用例**：

| 判据 | 构造 | 期望 |
|---|---|---|
| P2-2 C1 破坏 | 上游 type0 ≠ 现算 | **DROPPED** |
| P2-3 C3 低覆盖 | 外部源只覆盖 10% | **UNVERIFIED（不弃用）** |
| P2-4 外部源不可用 | 不传 external | **UNVERIFIED（不弃用）** |

外加：C2/C4 只降级、`summarize` 的弃用率分子只算 DROPPED、真实数据 0 弃用。
"""

from __future__ import annotations

import pytest

from app.services.fan import VTUBERS, load_window, resolve_data_dir
from app.services.fan.checks import (
    COVERAGE_FLOOR,
    STATUS_DEGRADED,
    STATUS_DROPPED,
    STATUS_OK,
    STATUS_UNVERIFIED,
    ExternalRef,
    check_coverage,
    check_identity,
    check_minute,
    check_summary,
    check_window,
    dropped,
    summarize,
    verdict,
)
from app.services.fan.loader import SessionRef


def _session(*, type0: int = 1000, price: float = 100.0, records: int = 2000,
             sum_m: int | None = None, sum_pay: float | None = None,
             n_pairs: int = 50, ref_count: int | None = None) -> SessionRef:
    sr = SessionRef(live_id="L1", start_at="2026-01-01T10:00:00",
                    end_at="2026-01-01T12:00:00", n_users=50)
    sr.stats = {
        "records": records,
        "type_hist": {"0": type0, "4": 500},
        "sum_price": price,
    }
    if ref_count is not None:
        sr.stats["ref_danmakus_count"] = ref_count
    sr.sum_m = type0 if sum_m is None else sum_m
    sr.sum_pay = price if sum_pay is None else sum_pay
    sr.n_pairs = n_pairs
    return sr


# ── C1（唯一弃用判据）────────────────────────────────────────────────────
def test_c1_passes_on_consistent_session() -> None:
    assert check_identity(_session()) == []


def test_c1_breaks_when_type0_mismatch() -> None:
    """P2-2：上游说 1000，现算 900 ⇒ 问题非空。"""
    problems = check_identity(_session(type0=1000, sum_m=900))
    assert any("弹幕恒等式破" in p for p in problems)


def test_c1_breaks_when_price_mismatch() -> None:
    problems = check_identity(_session(price=100.0, sum_pay=99.0))
    assert any("金额恒等式破" in p for p in problems)


def test_c1_tolerates_float_rounding_in_price() -> None:
    """金额只允许浮点级差异（0.01 元内）。"""
    assert check_identity(_session(price=100.0, sum_pay=100.005)) == []


def test_c1_drops_tiny_session() -> None:
    problems = check_identity(_session(records=2))
    assert any("记录数" in p for p in problems)


def test_c1_drops_session_with_no_pairs() -> None:
    problems = check_identity(_session(n_pairs=0, records=2000))
    assert any("没有任何" in p for p in problems)


# ── C2（只降级）──────────────────────────────────────────────────────────
def test_c2_passes_within_tolerance() -> None:
    assert check_summary(_session(type0=1000, ref_count=950)) == []


def test_c2_flags_large_deviation() -> None:
    problems = check_summary(_session(type0=1500, ref_count=1000))
    assert any("汇总与明细偏差" in p for p in problems)


def test_c2_silent_when_field_absent() -> None:
    """缺 `ref_danmakus_count` ⇒ 不检查（既不通过也不算失败）。"""
    assert check_summary(_session()) == []


# ── C3（决定外部源能不能用）───────────────────────────────────────────────
def test_c3_missing_external_is_unverified() -> None:
    assert check_coverage(None) != []


def test_c3_low_coverage_is_rejected() -> None:
    """P2-3 的前半：覆盖不足 ⇒ 外部源无权判本模型。"""
    problems = check_coverage(ExternalRef(coverage=0.10))
    assert any("无权用于判本模型" in p for p in problems)


def test_c3_enough_coverage_passes() -> None:
    assert check_coverage(ExternalRef(coverage=COVERAGE_FLOOR + 0.05)) == []


# ── C4（只降级）──────────────────────────────────────────────────────────
def test_c4_low_rho_flags() -> None:
    assert check_minute(ExternalRef(coverage=0.99, minute_rho=0.40)) != []


def test_c4_high_rho_passes() -> None:
    assert check_minute(ExternalRef(coverage=0.99, minute_rho=0.99)) == []


def test_c4_ignored_when_rho_missing() -> None:
    assert check_minute(ExternalRef(coverage=0.99)) == []


# ── 综合判定：分支顺序正确 ────────────────────────────────────────────────
def test_c1_dominates_everything() -> None:
    """C1 破时即使外部源也不可用，结果必须是 DROPPED 而不是 UNVERIFIED。"""
    v = verdict(_session(type0=1000, sum_m=900), external=None)
    assert v.status == STATUS_DROPPED
    assert not v.usable


def test_low_coverage_never_drops() -> None:
    """P2-3 的后半：**外部源不全不能成为弃用理由**（第一次事故的教训）。"""
    v = verdict(_session(), external=ExternalRef(coverage=0.12, message=88))
    assert v.status == STATUS_UNVERIFIED
    assert v.usable, "覆盖不足只意味着验证不了，不意味着数据坏了"


def test_missing_external_never_drops() -> None:
    """P2-4：外部源不可用 ⇒ UNVERIFIED，仍可用。"""
    v = verdict(_session(), external=None)
    assert v.status == STATUS_UNVERIFIED
    assert v.usable


def test_all_good_is_ok() -> None:
    v = verdict(_session(), external=ExternalRef(coverage=0.99, minute_rho=0.99,
                                                 message=1000, money=100.0))
    assert v.status == STATUS_OK
    assert v.reasons == []


def test_c2_only_degrades() -> None:
    v = verdict(_session(type0=1500, ref_count=1000),
                external=ExternalRef(coverage=0.99, minute_rho=0.99))
    assert v.status == STATUS_DEGRADED
    assert v.usable
    assert any("C2" in r for r in v.reasons)


def test_c4_only_degrades() -> None:
    v = verdict(_session(), external=ExternalRef(coverage=0.99, minute_rho=0.40))
    assert v.status == STATUS_DEGRADED
    assert v.usable


# ── summarize ─────────────────────────────────────────────────────────────
def test_summarize_counts_and_dropped_rate() -> None:
    vs = [verdict(_session(), external=None),
          verdict(_session(type0=1000, sum_m=1), external=None)]
    s = summarize(vs)
    assert s["total"] == 2
    assert s["dropped"] == 1
    assert s["dropped_rate"] == pytest.approx(0.5)
    assert s["usable"] == 1
    assert len(dropped(vs)) == 1   # 两场 live_id 都是 L1，用条数断言


# ── 真实数据 ──────────────────────────────────────────────────────────────
def _require_data() -> None:
    try:
        resolve_data_dir()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"没有真实数据：{exc}")


def test_real_data_c1_never_drops() -> None:
    """真实数据上 C1 全部通过 —— 与 `_probe` 的「弃 1 保 224」一致
    （那 1 场在加载阶段就因无入场事件被剔，不会走到 C1）。"""
    _require_data()
    total = 0
    for v in VTUBERS:
        try:
            w = load_window(v, 75)
        except Exception as exc:  # noqa: BLE001
            pytest.skip(str(exc))
        if not w.sessions:
            continue
        vs = check_window(w)
        assert dropped(vs) == [], f"{v.short} 出现 C1 弃用：{dropped(vs)}"
        total += len(vs)
    assert total > 0


def test_real_data_undated_flag_without_external() -> None:
    """真实数据不传外部源 ⇒ 全部 UNVERIFIED，但**没有一场被弃**。"""
    _require_data()
    w = load_window("弥月", 75)
    if not w.sessions:
        pytest.skip("无数据")
    vs = check_window(w)
    assert all(v.status == STATUS_UNVERIFIED for v in vs)
    assert all(v.usable for v in vs)


def test_real_data_tiny_session_dropped_when_not_prefiltered() -> None:
    """把 loader 的两道预筛关掉，那场只有 2 条记录的场次必须被 C1 判死。"""
    _require_data()
    try:
        w = load_window("明前奶绿", 75, require_entry=False, min_records=0)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(str(exc))
    if not w.sessions:
        pytest.skip("无数据")
    vs = check_window(w)
    tiny = [v for v in vs if v.details.get("records", 10 ** 9) < 100]
    assert tiny, "应当存在记录数 <100 的场次"
    assert all(v.status == STATUS_DROPPED for v in tiny)
