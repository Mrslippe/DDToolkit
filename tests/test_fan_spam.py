"""独轮车判定（`fan.spam`）的用例。"""

from __future__ import annotations

from app.services.fan.spam import is_spam, spam_score


def test_plain_repeat_is_spam():
    """整体重复率高 ⇒ 独轮车。"""
    assert is_spam(uniq=30, maxrep=10, m=100) is True
    assert spam_score(uniq=30, maxrep=10, m=100) == 0.7


def test_single_text_flood_is_spam_even_if_dup_rate_low():
    """单条文本反复刷、但整体重复率没到 60% —— 旧实现会漏判（2026-10-21 修正）。"""
    assert is_spam(uniq=80, maxrep=40, m=100) is True


def test_normal_user_is_not_spam():
    assert is_spam(uniq=90, maxrep=5, m=100) is False


def test_unknown_when_sample_too_small():
    """少于 20 条不判 —— 未知不等于清白。"""
    assert is_spam(uniq=3, maxrep=3, m=3) is None
    assert spam_score(uniq=3, maxrep=3, m=3) is None
