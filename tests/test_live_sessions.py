# -*- coding: utf-8 -*-
"""v0.9.x 直播日历内容管道 M1 后端测试：
- LiveSessionRepo.upsert_danmakus：幂等 upsert（live_id 唯一）、字段映射、无效跳过
- LiveSessionRepo.merged：表内场次 ∪ self 快照（±90min 窗口合并、双源标记、
  未匹配快照→self 虚拟场次）
- LiveSessionRepo.upsert_feed：其他数据源接入接口（M3 预留）
- live_type.infer_category：title/area/date 信号栈 + fallback
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import (Account, AccountStatSnapshot, LiveSession,
                               VTuber)
from app.repositories.vtuber_repo import LiveSessionRepo
from app.services.live_type import infer_category

T0 = datetime(2026, 9, 1, 12, 0, 0)


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _mk_account(db, uid="10086") -> Account:
    v = VTuber(name="测试V", birthday="09-01")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid)
    db.add(acc)
    db.commit()
    return acc


def _snap(db, acc, ts, status=None, fans=1, source="self"):
    db.add(AccountStatSnapshot(account_id=acc.id, followers_count=fans,
                               live_status=status, captured_at=ts, source=source))
    db.commit()


def _dm_item(live_id, title, start_ms, stop_ms=0, area="游戏",
             parent="网络游戏", income=None):
    return {
        "liveId": live_id, "title": title, "startDate": start_ms,
        "stopDate": stop_ms, "parentArea": parent, "area": area,
        "totalIncome": income, "maxOnlineCount": 100, "danmakusCount": 50,
        "coverUrl": None,
    }


EPOCH = datetime(1970, 1, 1)


def _ms(dt: datetime) -> int:
    """naive UTC 约定（库内时间列均为 naive UTC）→ 毫秒 epoch。"""
    return int((dt - EPOCH).total_seconds() * 1000)


# ── upsert_danmakus ────────────────────────────────────────────────

def test_upsert_danmakus_insert_and_update(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    items = [
        _dm_item("live-a", "杂谈回", _ms(T0), _ms(T0 + timedelta(hours=2)),
                 area="虚拟日常", parent="虚拟主播", income=123.5),
        _dm_item("live-b", "歌回", _ms(T0 + timedelta(days=1))),
    ]
    res = repo.upsert_danmakus(acc.id, items)
    assert res == {"added": 2, "updated": 0, "skipped": 0}

    # 幂等：重跑不新增；可变字段刷新
    items[0]["totalIncome"] = 999.0
    res = repo.upsert_danmakus(acc.id, items)
    assert res == {"added": 0, "updated": 2, "skipped": 0}
    rows = repo.list_by_account(acc.id)
    assert len(rows) == 2
    assert rows[0].total_income == 999.0
    assert rows[0].source == "danmakus"
    assert rows[0].end_at == T0 + timedelta(hours=2)
    assert rows[0].area_name == "虚拟日常"


def test_upsert_danmakus_skips_invalid(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    res = repo.upsert_danmakus(acc.id, [
        {"liveId": "", "startDate": _ms(T0)},                 # 无 live_id
        {"liveId": "live-x", "startDate": 0},                 # 无开始时间
        {"liveId": "live-y", "startDate": "bad"},             # 非法时间
    ])
    assert res == {"added": 0, "updated": 0, "skipped": 3}
    assert repo.list_by_account(acc.id) == []


def test_upsert_feed_interface(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    added = repo.upsert_feed(acc.id, "736525563447432921", {
        "title": "无限流游戏", "start_at": T0,
        "parent_area_name": "单机游戏", "area_name": "主机游戏",
    })
    assert added is True
    rows = repo.list_by_account(acc.id)
    assert len(rows) == 1
    assert rows[0].source == "feed"
    assert repo.upsert_feed(acc.id, "736525563447432921", {"title": "新标题"}) is False
    assert repo.list_by_account(acc.id)[0].title == "新标题"


# ── merged ─────────────────────────────────────────────────────────

def test_merged_snapshot_patches_danmakus_end(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    # danmakus 场次：直播中（无 end）
    repo.upsert_danmakus(acc.id, [
        _dm_item("live-a", "周六来唱歌！", _ms(T0), 0, area="虚拟Singer",
                 parent="虚拟主播", income=10501.5),
    ])
    # self 快照：±90min 内开场，20 分钟后收场
    _snap(db, acc, T0 - timedelta(minutes=5), status=0)
    _snap(db, acc, T0, status=1)
    _snap(db, acc, T0 + timedelta(minutes=20), status=0)

    merged = repo.merged(acc.id)
    assert len(merged) == 1
    m = merged[0]
    assert m["source"] == "danmakus+self"
    assert m["start_at"] == T0                       # danmakus 起点为准
    assert m["end_at"] == T0 + timedelta(minutes=20)  # 快照补 end
    assert m["duration_minutes"] == 20
    assert m["live_title"] == "周六来唱歌！"
    assert m["total_income"] == 10501.5
    assert m["area_name"] == "虚拟Singer"


def test_merged_outside_window_stays_two(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, [_dm_item("live-a", "播了", _ms(T0))])
    _snap(db, acc, T0 + timedelta(hours=3), status=1)
    _snap(db, acc, T0 + timedelta(hours=4), status=0)

    merged = repo.merged(acc.id)
    assert len(merged) == 2
    assert [m["source"] for m in merged] == ["danmakus", "self"]


def test_merged_virtual_self_and_row_alone(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    # 只有快照场次（danmakus 未收录主播场景）
    _snap(db, acc, T0, status=1)
    _snap(db, acc, T0 + timedelta(minutes=10), status=0)
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["source"] == "self"
    assert merged[0]["live_title"] is None

    # 只有表内场次（无快照观测期）
    repo.upsert_danmakus(acc.id, [_dm_item("live-a", "历史场", _ms(T0 - timedelta(days=30)))])
    merged = repo.merged(acc.id)
    assert len(merged) == 2
    assert merged[0]["source"] == "danmakus"


def test_merged_danmakus_end_wins(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, [
        _dm_item("live-a", "回放场", _ms(T0), _ms(T0 + timedelta(hours=3))),
    ])
    _snap(db, acc, T0 - timedelta(minutes=2), status=1)
    _snap(db, acc, T0 + timedelta(hours=2), status=0)
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["end_at"] == T0 + timedelta(hours=3)      # danmakus end 优先
    assert merged[0]["duration_minutes"] == 180


# ── infer_category ────────────────────────────────────────────────

def test_category_title_signal(db):
    assert infer_category("深夜杂谈回聊聊生活")[0] == "chat"
    assert infer_category("周六来唱歌！")[0] == "song"
    assert infer_category("新年特别直播！")[0] == "special"
    assert infer_category("百万粉纪念歌回")[0] == "special"    # 优先于歌回
    assert infer_category("原神深渊")[0] == "game"
    assert infer_category("联动企划双人合唱")[0] == "collab"

    key, src = infer_category("随便玩玩杂谈")
    assert (key, src) == ("chat", "title")


def test_category_area_signal(db):
    # 标题空白 → 分区兜底
    assert infer_category("", area_name="主机游戏", parent_area_name="单机游戏") == ("game", "area")
    assert infer_category(None, area_name="虚拟Singer", parent_area_name="虚拟主播") == ("song", "area")
    assert infer_category("", area_name="虚拟日常", parent_area_name="虚拟主播") == ("chat", "area")
    # 标题命中优先于分区
    assert infer_category("歌回", area_name="主机游戏", parent_area_name="单机游戏")[0] == "song"


def test_category_date_anchor(db):
    # 生日当日（MM-DD）
    assert infer_category("", start_at=T0, birthday="09-01") == ("special", "date")
    # 出道日（YYYY-MM-DD）
    assert infer_category("", start_at=T0, debut_date="2022-09-01") == ("special", "date")
    # 手动事件当日
    assert infer_category("", start_at=T0, event_dates=["2026-09-01"]) == ("special", "date")
    # 无信号 → fallback
    assert infer_category("", start_at=T0, birthday="05-05") == ("live", "fallback")
