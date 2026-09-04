# -*- coding: utf-8 -*-
"""P5 新展示视图后端数据测试：
- fan_trend_points：按天分桶（self 取天末、zeroroku 全量保留、时间升序）
- live_sessions：live_status 转移推导场次（0→1→0、进行中、跨天）
- ThirdpartyVtuberRepo.by_uid 精确查询
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import (Account, AccountStatSnapshot, ThirdpartyVtuber,
                               VTuber)
from app.repositories.vtuber_repo import (AccountStatSnapshotRepo,
                                          ThirdpartyVtuberRepo)


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


T0 = datetime(2026, 9, 1, 12, 0, 0)


def _mk_account(db, uid="10086") -> Account:
    v = VTuber(name="测试V")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid)
    db.add(acc)
    db.commit()
    return acc


def _snap(db, acc, ts, fans=None, status=None, source="self"):
    db.add(AccountStatSnapshot(account_id=acc.id, followers_count=fans,
                               live_status=status, captured_at=ts, source=source))
    db.commit()


# ── fan_trend_points ────────────────────────────────────────────────

def test_fan_trend_bucketing(db):
    acc = _mk_account(db)
    # self：同一天多行 → 取天末（fans 更大的那行）
    _snap(db, acc, T0, fans=100)
    _snap(db, acc, T0 + timedelta(hours=3), fans=120)
    _snap(db, acc, T0 + timedelta(days=1), fans=150)
    # zeroroku：日粒度稀疏，全量保留（含同日多条）
    _snap(db, acc, T0 - timedelta(days=5), fans=90, source="zeroroku")
    _snap(db, acc, T0 - timedelta(days=3), fans=95, source="zeroroku")
    _snap(db, acc, T0 - timedelta(days=3, hours=1), fans=94, source="zeroroku")

    pts = AccountStatSnapshotRepo(db).fan_trend_points(acc.id)
    assert [p["source"] for p in pts] == ["zeroroku", "zeroroku", "zeroroku", "self", "self"]
    # self 天末值
    assert pts[3] == {"date": "2026-09-01", "fans": 120, "source": "self"}
    assert pts[4] == {"date": "2026-09-02", "fans": 150, "source": "self"}
    # zeroroku 全量（同日两条都在）
    assert sum(1 for p in pts if p["source"] == "zeroroku") == 3
    # 时间升序
    assert pts == sorted(pts, key=lambda p: (p["date"], p["source"]))


def test_fan_trend_ignores_null_fans(db):
    acc = _mk_account(db)
    db.add(AccountStatSnapshot(account_id=acc.id, followers_count=None,
                               captured_at=T0, source="self"))
    db.commit()
    assert AccountStatSnapshotRepo(db).fan_trend_points(acc.id) == []


# ── live_sessions ───────────────────────────────────────────────────

def test_live_sessions_transitions(db):
    acc = _mk_account(db)
    _snap(db, acc, T0, status=0, fans=1)
    _snap(db, acc, T0 + timedelta(minutes=5), status=1, fans=1)
    _snap(db, acc, T0 + timedelta(minutes=10), status=1, fans=1)
    _snap(db, acc, T0 + timedelta(minutes=20), status=0, fans=1)
    sessions = AccountStatSnapshotRepo(db).live_sessions(acc.id)
    assert len(sessions) == 1
    assert sessions[0]["start_at"] == T0 + timedelta(minutes=5)
    assert sessions[0]["end_at"] == T0 + timedelta(minutes=20)
    assert sessions[0]["duration_minutes"] == 15


def test_live_sessions_ongoing_and_archived_sources(db):
    acc = _mk_account(db)
    _snap(db, acc, T0, status=1, fans=1)                    # 开场后未收场
    _snap(db, acc, T0 + timedelta(minutes=5), status=1, fans=1, source="zeroroku")
    sessions = AccountStatSnapshotRepo(db).live_sessions(acc.id)
    assert len(sessions) == 1
    assert sessions[0]["start_at"] == T0
    assert sessions[0]["end_at"] is None
    assert sessions[0]["duration_minutes"] is None


def test_live_sessions_ignores_zeroroku_transitions(db):
    """源隔离：只有 self 序列参与场次推导（第三方不参与起止判定）。"""
    acc = _mk_account(db)
    _snap(db, acc, T0, status=1, fans=1, source="zeroroku")
    _snap(db, acc, T0 + timedelta(minutes=5), status=0, fans=1, source="zeroroku")
    assert AccountStatSnapshotRepo(db).live_sessions(acc.id) == []


# ── by_uid ──────────────────────────────────────────────────────────

def test_thirdparty_by_uid(db):
    db.add(ThirdpartyVtuber(platform="bilibili", platform_uid="434334701",
                            name="七海Nana7mi", type="vtuber",
                            room_id="21452505", group_name="VirtuaReal",
                            source="danmakus", updated_at=T0))
    db.add(ThirdpartyVtuber(platform="bilibili", platform_uid="434334701",
                            name="七海Nana7mi", type="vtuber",
                            room_id=None, group_name=None,
                            source="other", updated_at=T0))
    db.add(ThirdpartyVtuber(platform="bilibili", platform_uid="999",
                            name="别的", type="vtuber",
                            source="danmakus", updated_at=T0))
    db.commit()
    repo = ThirdpartyVtuberRepo(db)
    hits = repo.by_uid("434334701")
    assert len(hits) == 2
    assert {h.group_name for h in hits} == {"VirtuaReal", None}
    assert repo.by_uid("434334701", source="danmakus")[0].group_name == "VirtuaReal"
    assert repo.by_uid("missing") == []
