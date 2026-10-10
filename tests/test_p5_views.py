# -*- coding: utf-8 -*-
"""P5 新展示视图后端数据测试：
- fan_trend_points：按天分桶（self 取天末、zeroroku 全量保留、时间升序）
- live_sessions：live_status 转移推导场次（0→1→0、进行中、跨天）
- ThirdpartyVtuberRepo.by_uid 精确查询
"""
from datetime import datetime, timedelta, timezone

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


def test_fan_trend_buckets_by_local_day_not_utc(db):
    """归日按**本地**时区，不是 UTC（2026-10-10 自审 F4，`devlog/461`）。

    `captured_at` 存的是**朴素 UTC**（同一约定写在 `_ser_captured_at`），
    所以直接 `strftime("%Y-%m-%d")` 得到的是 UTC 日期：东八区在本地 00:00–08:00
    抓的那次会落到**前一天**的柱子上，而同一个人的直播场次是按本地日期排的
    （`liveCalendarFmt.dayKeyIso` 专门为这条写了理由）。

    ⚠️ **`tz` 必须注入，不能靠跑测机器的时区**：CI 跑在 UTC 上，
    真值恰恰等于错值 ⇒ 这条判据在 CI 里会永远绿（等于没有判据）。
    这里钉 UTC+8 与 UTC-5 各一次，**两个方向都覆盖**。
    """
    acc = _mk_account(db)
    east = timezone(timedelta(hours=8))
    west = timezone(timedelta(hours=-5))
    # UTC 2026-09-13 23:00 ⇒ 东八区 09-14 07:00（第二天）/ 西五区 09-13 18:00（同一天）
    _snap(db, acc, datetime(2026, 9, 13, 23, 0, 0), fans=100)

    east_pts = AccountStatSnapshotRepo(db).fan_trend_points(acc.id, tz=east)
    assert east_pts == [{"date": "2026-09-14", "fans": 100, "source": "self"}], \
        "东八区：本地已经是 09-14 了，UTC 归日会把它算成 09-13"

    west_pts = AccountStatSnapshotRepo(db).fan_trend_points(acc.id, tz=west)
    assert west_pts == [{"date": "2026-09-13", "fans": 100, "source": "self"}], \
        "西五区：这条本来就该留在 09-13（反方向也要对）"

    # 正对照：不注入 tz 时**不许抛**（真机走这条，用本机时区）
    assert AccountStatSnapshotRepo(db).fan_trend_points(acc.id)[0]["fans"] == 100


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
