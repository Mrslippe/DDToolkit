"""独轮车 v2（时间分布判定）的用例。"""

from __future__ import annotations

from app.services.fan.spam2 import Trace, feed, verdict

H = 3_600_000


def _t(n: int, step_ms: int = 60_000, start: int = 0) -> list[int]:
    return [start + i * step_ms for i in range(n)]


def test_sustained_repeat_is_caught():
    """一条文本刷 60 次、横跨 2 小时 ⇒ sustained。"""
    tr = Trace()
    feed(tr, session_idx=0, mt=_t(60, 120_000), mh=[7] * 60)
    ok, rule = verdict(tr)
    assert ok is True and rule in ("sustained", "window"), rule


def test_window_flood_is_caught():
    """10 分钟内 40 条、其中 36 条同一句 ⇒ window。"""
    tr = Trace()
    mt = _t(40, 10_000)
    mh = [9] * 36 + [1, 2, 3, 4]
    feed(tr, session_idx=0, mt=mt, mh=mh)
    ok, rule = verdict(tr)
    assert ok is True and rule in ("window", "sustained"), rule


def test_cross_session_habit_is_caught():
    """同一条文本在 25 场里各出现 5 次，且占该用户消息的 5% 以上。"""
    tr = Trace()
    for s in range(25):
        feed(tr, session_idx=s, mt=_t(5, 60_000), mh=[42] * 5)
    ok, rule = verdict(tr)
    assert ok is True and rule == "cross_session", rule


def test_normal_chatter_is_not_spam():
    tr = Trace()
    for s in range(10):
        feed(tr, session_idx=s, mt=_t(10, 60_000), mh=list(range(s * 10, s * 10 + 10)))
    ok, rule = verdict(tr)
    assert ok is False and rule == "ok"


def test_too_few_messages_is_unknown():
    tr = Trace()
    feed(tr, session_idx=0, mt=_t(5), mh=[1] * 5)
    ok, rule = verdict(tr)
    assert ok is None and rule == "unknown"
