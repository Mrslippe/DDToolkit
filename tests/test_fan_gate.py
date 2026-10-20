"""质量闸与 vtb.cat 匹配的用例（纯函数，不联网）。"""

from __future__ import annotations

from app.services.externals.vtbcat import START_OFFSET_S, match_session
from app.services.fan.quality_gate import evaluate


def _stats(*, type0=1000, pay=100.0, records=1200, hist=None) -> dict:
    return {
        "type0": type0,
        "sum_price": pay,
        "records": records,
        "type_hist": hist if hist is not None else {"0": type0, "4": records - type0},
        "live_id": "x",
    }


def test_gate_ok_when_all_three_layers_agree():
    q = evaluate(
        stats=_stats(),
        platform={"danmakus_count": 1000, "income": 100.0},
        vtb={"Message": 1000, "Money": 100.0},
    )
    assert q["status"] == "ok"
    assert q["checks"]["type_sum_ok"] is True
    assert q["checks"]["vtb_matched"] is True


def test_gate_flags_low_coverage_from_platform():
    q = evaluate(stats=_stats(type0=500), platform={"danmakus_count": 1000, "income": 0})
    assert q["status"] == "low_coverage"
    assert q["checks"]["platform_message_ratio"] == 0.5


def test_gate_flags_low_income_from_vtb():
    """只有 vtb 说收入少 ⇒ low_income（收入维度仍按单侧判，弹幕维度才要求双源一致）。"""
    q = evaluate(stats=_stats(pay=10.0), vtb={"Message": 1000, "Money": 100.0})
    assert q["status"] == "low_income"


def test_gate_ignores_vtb_when_it_barely_indexed():
    """vtb 只收了几十条时不能拿它判我们（danmakus 是超集）。"""
    q = evaluate(stats=_stats(type0=1000), vtb={"Message": 50, "Money": 0})
    assert q["status"] == "ok"


def test_gate_marks_internal_inconsistency():
    bad = _stats(records=1200, hist={"0": 900})     # 求和 900 ≠ records 1200
    q = evaluate(stats=bad)
    assert q["status"] == "inconsistent"


def test_vtb_match_uses_eight_hour_offset():
    our_start_ms = 1_787_832_549_000           # 2026-08-27 12:09 UTC
    target = our_start_ms / 1000 + START_OFFSET_S
    lives = [{"StartAt": int(target), "Message": 1234}]
    assert match_session(lives, our_start_ms) == lives[0]

    # 偏差超过容差就不认（避免错配到别的场次）
    far = [{"StartAt": int(target + 10 * 3600), "Message": 1}]
    assert match_session(far, our_start_ms) is None


def test_two_sources_disagree_marks_suspect_not_low_coverage():
    """抽查 2026-10-21：17 场 low_coverage 里 13 场是单侧误报。

    规则：平台与 vtb 都说"我们少"才判 low_coverage；只有一边说就标 *_suspect。
    """
    # 平台说我们只有 50%，但 vtb 说我们够 ⇒ 平台的数偏大
    q = evaluate(stats=_stats(type0=500),
                 platform={"danmakus_count": 1000, "income": 0},
                 vtb={"Message": 500, "Money": 0})
    assert q["status"] == "platform_suspect", q

    # 平台说够，vtb 说我们只有一半 ⇒ vtb 侧（合并/错配）
    q = evaluate(stats=_stats(type0=1000),
                 platform={"danmakus_count": 1000, "income": 0},
                 vtb={"Message": 2000, "Money": 0})
    assert q["status"] == "vtb_suspect", q

    # 两边都说少 ⇒ 真截断
    q = evaluate(stats=_stats(type0=500),
                 platform={"danmakus_count": 1000, "income": 0},
                 vtb={"Message": 1000, "Money": 0})
    assert q["status"] == "low_coverage", q
