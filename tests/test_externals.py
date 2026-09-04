# -*- coding: utf-8 -*-
"""P4 外部数据源测试（zeroroku / danmakus）：
- 时间解析（+00 偏移 → naive UTC）
- 幂等：重复导入不产生重复行（粉丝历史 / 礼物日聚合）
- vtuber 索引整表刷新语义（先清后插，source 隔离）
- 注册表与 laplace 空壳默认禁用
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import (Account, AccountStatSnapshot, LiveGiftDay,
                               ThirdpartyVtuber, VTuber)
from app.services.externals.registry import (get_external_source,
                                             iter_external_sources)
from app.services.externals.zeroroku import (parse_zeroroku_ts,
                                             ZerorokuSource)
from app.services.externals.danmakus import DanmakusSource


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


class FakeResp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeClient:
    """按 URL 前缀分发响应的假 httpx 客户端（async get）。"""
    def __init__(self, routes: dict[str, dict]):
        self.routes = routes

    async def get(self, url, **kwargs):
        for prefix, payload in self.routes.items():
            if url.startswith(prefix):
                return FakeResp(200, payload)
        return FakeResp(404, {})


# ── 时间解析 ────────────────────────────────────────────────────────

def test_parse_zeroroku_ts():
    assert parse_zeroroku_ts("2026-09-04 14:28:37.73199+00").year == 2026
    assert parse_zeroroku_ts("2026-09-04 14:28:37.73199+00").tzinfo is None  # naive UTC
    assert parse_zeroroku_ts("2025-12-31 22:00:00.000000+00").hour == 22
    assert parse_zeroroku_ts("") is None
    assert parse_zeroroku_ts("not a date") is None
    assert parse_zeroroku_ts(None) is None


# ── zeroroku fan_history ────────────────────────────────────────────

def test_fan_history_idempotent(db):
    v = VTuber(name="七海Nana7mi")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="434334701")
    db.add(acc)
    db.commit()

    payload = {"items": [
        {"id": "1", "mid": "434334701", "fans": 1114115,
         "createdAt": "2026-09-04 14:28:37.73199+00"},
        {"id": "2", "mid": "434334701", "fans": 1114250,
         "createdAt": "2026-09-02 04:54:35.131248+00"},
    ]}
    src = ZerorokuSource()
    client = FakeClient({"https://zeroroku.com/api/bilibili/author/434334701/history": payload})

    async def run():
        return await src.run_job("fan_history", db, client)

    import asyncio
    s1 = asyncio.run(run())
    assert s1.stored == 2
    s2 = asyncio.run(run())          # 幂等：重复执行不新增
    assert s2.stored == 0
    assert db.query(AccountStatSnapshot).count() == 2
    row = db.query(AccountStatSnapshot).first()
    assert row.source == "zeroroku"
    assert row.followers_count == 1114115


# ── zeroroku gift_days ──────────────────────────────────────────────

def test_gift_days_idempotent(db):
    v = VTuber(name="测试V")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="123")
    db.add(acc)
    db.commit()

    payload = {
        "roomId": "21452505",
        "columns": ["bucket_start", "gift_amount", "guard_amount", "sc_amount", "total_amount"],
        "items": [
            {"bucket_start": "2026-09-04", "gift_amount": "0.000",
             "guard_amount": "0.000", "sc_amount": "2.000", "total_amount": "2.000"},
            {"bucket_start": "2026-09-02", "gift_amount": "0.000",
             "guard_amount": "336.000", "sc_amount": "128.000", "total_amount": "464.000"},
        ],
    }
    src = ZerorokuSource()
    client = FakeClient({"https://zeroroku.com/api/bilibili/author/123/live-paid-aggregations": payload})

    async def run():
        return await src.run_job("gift_days", db, client)

    import asyncio
    s1 = asyncio.run(run())
    assert s1.stored == 2
    s2 = asyncio.run(run())
    assert s2.stored == 0
    assert db.query(LiveGiftDay).count() == 2
    # 金额原始字符串保精度
    g = db.query(LiveGiftDay).filter(LiveGiftDay.gift_date == "2026-09-02").one()
    assert g.guard_amount == "336.000"
    assert g.room_id == "21452505"


# ── danmakus vtuber_index ───────────────────────────────────────────

def test_vtuber_index_refresh_source_isolated(db):
    # 预置旧数据：同源旧行 + 他源行
    db.add(ThirdpartyVtuber(platform="bilibili", platform_uid="111", name="旧行",
                            source="danmakus", updated_at=None))
    db.add(ThirdpartyVtuber(platform="bilibili", platform_uid="222", name="他源行",
                            source="other", updated_at=None))
    db.commit()

    mapping = {
        "333": {"name": "七海Nana7mi", "type": "vtuber", "room": 21452505, "group_name": ""},
        "444": {"name": "壳壳", "type": "group", "room": 0, "group_name": "XS"},
    }
    src = DanmakusSource()
    client = FakeClient({"https://ukamnads.icu/api/v2/vup-list": {"code": 200, "data": mapping}})

    async def run():
        return await src.run_job("vtuber_index", db, client)

    import asyncio
    s = asyncio.run(run())
    assert s.stored == 2
    # 整表刷新：同源清空（旧行没了），他源保留
    assert db.query(ThirdpartyVtuber).count() == 3
    assert db.query(ThirdpartyVtuber).filter(
        ThirdpartyVtuber.source == "danmakus").count() == 2
    three = db.query(ThirdpartyVtuber).filter(
        ThirdpartyVtuber.platform_uid == "333").first()
    assert three.name == "七海Nana7mi"
    assert three.room_id == "21452505"
    assert three.group_name is None      # 空串归一为 None
    assert db.query(ThirdpartyVtuber).filter(
        ThirdpartyVtuber.platform_uid == "222").one().source == "other"


def test_vtuber_index_bad_response(db):
    src = DanmakusSource()
    client = FakeClient({"https://ukamnads.icu/api/v2/vup-list": {"code": 500, "data": None}})
    import asyncio
    s = asyncio.run(src.run_job("vtuber_index", db, client))
    assert s.error is not None and s.stored == 0


# ── 注册表与空壳 ────────────────────────────────────────────────────

def test_registry_sources():
    names = {s.name for s in iter_external_sources()}
    assert {"zeroroku", "danmakus", "laplace"} <= names
    src = get_external_source("laplace")
    assert src is not None and src.enabled is False   # 无 API 默认禁用
    assert get_external_source("nonexistent") is None
