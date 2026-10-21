"""独轮车 v1（重复率）的用例。阈值 2026-10-21 与 v2 对齐。"""

from __future__ import annotations

from app.services.fan.spam import is_spam, spam_score


def test_low_variety_is_spam():
    """300 条里只有 30 种（重复率 90%）⇒ 独轮车。"""
    assert is_spam(uniq=30, maxrep=200, m=300) is True


def test_occasional_repeat_is_not_spam():
    """重复率 70%（不同文本率 30%）—— 口头禅型，不算。"""
    assert is_spam(uniq=300, maxrep=50, m=1000) is False


def test_unknown_when_sample_too_small():
    """少于 200 条不判 —— 未知不等于清白。"""
    assert is_spam(uniq=3, maxrep=3, m=3) is None
    assert spam_score(uniq=3, maxrep=3, m=3) is None
