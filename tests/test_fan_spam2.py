"""独轮车 v2（文本多样性判定）的用例。"""

from __future__ import annotations

from app.services.fan.spam2 import Trace, feed, verdict


def test_low_variety_overall_is_caught():
    """累计 600 条里只有 20 种文本（3.3%）⇒ 独轮车。"""
    tr = Trace()
    for s in range(2):
        feed(tr, session_idx=s, mt=list(range(300)), mh=[i % 10 for i in range(300)])
    ok, rule = verdict(tr)
    assert ok is True and rule == "low_variety", (round(tr.variety, 3), rule)


def test_high_volume_chatter_is_not_spam():
    """用户实测反例：6.9 万条、72% 文本互不相同 —— 话痨，不是独轮车。"""
    tr = Trace()
    for s in range(20):
        feed(tr, session_idx=s, mt=list(range(300)),
             mh=list(range(s * 250, s * 250 + 300)))   # 每场几乎全是新文本
    ok, rule = verdict(tr)
    assert ok is False and rule == "ok", rule


def test_occasional_catchphrase_is_not_spam():
    """说几千次“哈哈哈”、但只占 5.7%、整体 72% 不重复 ⇒ 不是独轮车。

    关键是“零星”而不是“某一小时里全在刷”：每场 200 次口头禅 + 3,000 条别的。
    """
    tr = Trace()
    for s in range(20):
        mh = [7] * 200 + list(range(s * 3300, s * 3300 + 3000))
        feed(tr, session_idx=s, mt=list(range(len(mh))), mh=mh)
    ok, rule = verdict(tr)
    assert ok is False and rule == "ok", (round(tr.variety, 3), rule)


def test_cross_session_needs_low_variety():
    """横跨很多场，但文本多样 ⇒ 不判。"""
    tr = Trace()
    for s in range(25):
        feed(tr, session_idx=s, mt=list(range(250)),
             mh=[42] * 120 + list(range(s * 130, s * 130 + 130)))
    ok, rule = verdict(tr)
    assert ok is False, (tr.variety, rule)      # 多样性约 52%


def test_too_few_messages_is_unknown():
    tr = Trace()
    feed(tr, session_idx=0, mt=list(range(50)), mh=[1] * 50)
    ok, rule = verdict(tr)
    assert ok is None and rule == "unknown"
