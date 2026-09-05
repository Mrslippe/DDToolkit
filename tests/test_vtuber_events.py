# -*- coding: utf-8 -*-
"""P7 档案视图细化后端测试：
- VtuberEventRepo：手动事件 CRUD / 未来预约解析（desc1 格式×年份推断×已结束过滤）
- live_sessions 附带 live_title（场次内最后一条非空标题）
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import (Account, AccountStatSnapshot, Post, VTuber,
                               VtuberEvent)
from app.repositories.vtuber_repo import (AccountStatSnapshotRepo,
                                          VtuberEventRepo)


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


T0 = datetime(2026, 9, 6, 12, 0, 0)


def _mk_vtuber(db, uid="10086") -> VTuber:
    v = VTuber(name="测试V")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid)
    db.add(acc)
    db.commit()
    return v


def _mk_post(db, uid="10086", body_json=None, raw_json=None,
             published_at=None) -> Post:
    p = Post(platform="bilibili", platform_uid=uid, platform_post_id=f"p{hash(body_json or '')}",
             type="text", body_json=body_json, raw_json=raw_json,
             published_at=published_at)
    db.add(p)
    db.commit()
    return p


# ── 手动事件 CRUD ───────────────────────────────────────────────────

def test_event_crud(db):
    v = _mk_vtuber(db)
    repo = VtuberEventRepo(db)
    e1 = repo.create(v.id, "生日歌回", "2026-10-12")
    e2 = repo.create(v.id, "周年纪念", "2026-09-27")
    # 日期升序
    rows = repo.list_by_vtuber(v.id)
    assert [r.title for r in rows] == ["周年纪念", "生日歌回"]
    # 删除
    assert repo.delete(e1.id) is True
    assert [r.title for r in repo.list_by_vtuber(v.id)] == ["周年纪念"]
    assert repo.delete(9999) is False


# ── 未来预约解析 ────────────────────────────────────────────────────

def _resv(desc1, button_text="预约", title="", reserve_total=5, rid="21452505"):
    import json
    return json.dumps({"reservation": {
        "status": None, "button_text": button_text, "button_status": 1,
        "button_type": 2, "desc1": desc1, "desc2": "0人预约",
        "reserve_total": reserve_total, "title": title, "rid": rid,
    }})


def test_future_reservations_full_date(db):
    v = _mk_vtuber(db)
    _mk_post(db, body_json=_resv("2026-11-24 20:00 直播", title="直播预约|平安夜歌回"),
             published_at=T0 - timedelta(days=2))
    out = VtuberEventRepo(db).future_reservations(v.id, now=T0, days=90)
    assert len(out) == 1
    assert out[0]["title"] == "平安夜歌回"          # raw 前缀已去
    assert out[0]["start_at"] == datetime(2026, 11, 24, 20, 0)
    assert out[0]["reserve_total"] == 5
    assert out[0]["rid"] == "21452505"


def test_future_reservations_mm_dd_cross_year(db):
    """MM-DD 无年份：解析早于发布日 → 次年（跨年预约）。"""
    v = _mk_vtuber(db)
    now = datetime(2025, 12, 31, 12, 0)
    _mk_post(db, body_json=_resv("01-01 19:00 直播"),
             published_at=datetime(2025, 12, 31, 8, 0))
    out = VtuberEventRepo(db).future_reservations(v.id, now=now, days=90)
    assert [x["start_at"] for x in out] == [datetime(2026, 1, 1, 19, 0)]


def test_future_reservations_mm_dd_same_year(db):
    """MM-DD 无年份：当年日期晚于发布日 → 当年。"""
    v = _mk_vtuber(db)
    _mk_post(db, body_json=_resv("09-15 20:00 直播"),
             published_at=datetime(2026, 9, 1, 8, 0))
    _mk_post(db, body_json=_resv("10-08 20:00 直播"),
             published_at=datetime(2026, 9, 1, 8, 0))
    out = VtuberEventRepo(db).future_reservations(v.id, now=T0, days=90)
    # 排序按 start_at
    assert [x["start_at"] for x in out] == [datetime(2026, 9, 15, 20, 0),
                                            datetime(2026, 10, 8, 20, 0)]


def test_future_reservations_today_tomorrow(db):
    v = _mk_vtuber(db)
    _mk_post(db, body_json=_resv("今天 20:00 直播"), published_at=T0)
    _mk_post(db, body_json=_resv("明天 19:00 直播"), published_at=T0)
    out = VtuberEventRepo(db).future_reservations(v.id, now=T0)
    starts = [x["start_at"] for x in out]
    assert starts == [datetime(2026, 9, 6, 20, 0), datetime(2026, 9, 7, 19, 0)]


def test_future_reservations_filters(db):
    v = _mk_vtuber(db)
    # 已结束
    _mk_post(db, body_json=_resv("2026-10-01 20:00 直播", button_text="已结束"),
             published_at=T0)
    # 已过时刻
    _mk_post(db, body_json=_resv("2026-09-06 11:00 直播"), published_at=T0 - timedelta(days=1))
    # 超出 90 天
    _mk_post(db, body_json=_resv("2027-06-01 20:00 直播"), published_at=T0)
    # 无 desc1 解析
    _mk_post(db, body_json=_resv("时间待定"), published_at=T0)
    # 其他账号不影响
    other = VTuber(name="别的V")
    db.add(other)
    db.flush()
    db.add(Account(vtuber_id=other.id, platform="bilibili", platform_uid="999"))
    db.commit()
    _mk_post(db, uid="999", body_json=_resv("2026-12-01 20:00 直播"), published_at=T0)

    out = VtuberEventRepo(db).future_reservations(v.id, now=T0, days=90)
    assert out == []


def test_future_reservations_title_fallback_raw(db):
    """旧帖 body_json.reservation 无 title → 回退 raw_json reserve.title。"""
    v = _mk_vtuber(db)
    raw = ('{"modules": {"module_dynamic": {"additional": {"reserve": {'
           '"title": "直播预约|七夕转转转", "desc1": {"text": "09-20 20:00 直播"}}}}}}')
    _mk_post(db, body_json=_resv("09-20 20:00 直播", title=""), raw_json=raw,
             published_at=datetime(2026, 9, 15, 8, 0))
    out = VtuberEventRepo(db).future_reservations(v.id, now=T0, days=90)
    assert len(out) == 1
    assert out[0]["title"] == "七夕转转转"


def test_future_reservations_desc1_fallback(db):
    """无 title 无 raw → 降级用 desc1 原文。"""
    v = _mk_vtuber(db)
    _mk_post(db, body_json=_resv("09-12 20:00 直播", title=""), raw_json=None,
             published_at=datetime(2026, 9, 10, 8, 0))
    out = VtuberEventRepo(db).future_reservations(v.id, now=T0, days=90)
    assert len(out) == 1
    assert out[0]["title"] == "09-12 20:00 直播"


# ── live_sessions 带标题 ────────────────────────────────────────────

def _snap(db, acc, ts, status, title=None):
    db.add(AccountStatSnapshot(account_id=acc.id, followers_count=1,
                               live_status=status, live_title=title,
                               captured_at=ts, source="self"))
    db.commit()


def test_live_sessions_carries_title(db):
    v = _mk_vtuber(db)
    acc = db.query(Account).filter(Account.vtuber_id == v.id).first()
    _snap(db, acc, T0, 1, "开场标题")
    _snap(db, acc, T0 + timedelta(minutes=5), 1, "中场改标题")
    _snap(db, acc, T0 + timedelta(minutes=10), 1, None)   # 空标题不覆盖
    _snap(db, acc, T0 + timedelta(minutes=20), 0)
    s = AccountStatSnapshotRepo(db).live_sessions(acc.id)
    assert len(s) == 1
    assert s[0]["live_title"] == "中场改标题"


def test_live_sessions_ongoing_title(db):
    v = _mk_vtuber(db)
    acc = db.query(Account).filter(Account.vtuber_id == v.id).first()
    _snap(db, acc, T0, 1, "进行中")
    s = AccountStatSnapshotRepo(db).live_sessions(acc.id)
    assert s[0]["live_title"] == "进行中"


def test_live_sessions_no_title(db):
    v = _mk_vtuber(db)
    acc = db.query(Account).filter(Account.vtuber_id == v.id).first()
    _snap(db, acc, T0, 1)
    _snap(db, acc, T0 + timedelta(minutes=5), 0)
    s = AccountStatSnapshotRepo(db).live_sessions(acc.id)
    assert s[0]["live_title"] is None
