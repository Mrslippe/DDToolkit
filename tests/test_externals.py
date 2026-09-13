# -*- coding: utf-8 -*-
"""P4 外部数据源测试（zeroroku / danmakus）：
- 时间解析（+00 偏移 → naive UTC）
- 幂等：重复导入不产生重复行（粉丝历史 / 礼物日聚合）
- vtuber 索引整表刷新语义（先清后插，source 隔离）
- 注册表与 laplace 空壳默认禁用
"""
import pytest
from datetime import datetime
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import (Account, AccountStatSnapshot, LiveGiftDay,
                               LiveSession, ThirdpartyVtuber, VTuber)
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

def test_fan_history_account_scoped_backfill(db):
    """收录新 V 时的账号白名单回填：只跑指定账号，不扫全站（2026-09-08）。"""
    import asyncio

    v = VTuber(name="新收录V")
    db.add(v)
    db.flush()
    new_acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="999")
    other = Account(vtuber_id=v.id, platform="bilibili", platform_uid="888")
    db.add_all([new_acc, other])
    db.commit()

    src = ZerorokuSource()
    client = FakeClient({
        "https://zeroroku.com/api/bilibili/author/999/history": {"items": [
            {"id": "1", "mid": "999", "fans": 100,
             "createdAt": "2026-09-04 14:28:37.73199+00"},
        ]},
        "https://zeroroku.com/api/bilibili/author/888/history": {"items": [
            {"id": "2", "mid": "888", "fans": 200,
             "createdAt": "2026-09-04 14:28:37.73199+00"},
        ]},
    })

    async def run():
        return await src.run_job("fan_history", db, client, account_ids=[new_acc.id])

    s = asyncio.run(run())
    assert s.stored == 1
    rows = db.query(AccountStatSnapshot).all()
    assert [r.account_id for r in rows] == [new_acc.id]   # 只写了白名单账号


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


# ── danmakus live_sessions 每日同步（v0.9.x M2） ────────────────────

def test_live_sessions_sync_idempotent(db):
    v = VTuber(name="测试V")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="434334701")
    db.add(acc)
    db.commit()

    lives = [{
        "liveId": "5ff53720-4f57-43b8-8890-23c5f1afe1a5",
        "title": "周六来唱歌！",
        "startDate": 1788609695000,
        "stopDate": 1788628090562,
        "parentArea": "虚拟主播", "area": "虚拟Singer",
        "totalIncome": 10501.5, "maxOnlineCount": 989, "danmakusCount": 17931,
    }]
    payload = {"code": 200, "message": "成功",
               "data": {"channel": {}, "lives": lives, "fansHistory": []}}
    src = DanmakusSource()
    client = FakeClient({"https://ukamnads.icu/api/v2/channel": payload})

    import asyncio
    s1 = asyncio.run(src.run_job("live_sessions", db, client))
    assert s1.stored == 1
    s2 = asyncio.run(src.run_job("live_sessions", db, client))
    assert s2.stored == 0                                        # 幂等
    row = db.query(LiveSession).one()
    assert row.source == "danmakus"
    assert row.title == "周六来唱歌！"
    assert row.area_name == "虚拟Singer"
    assert row.parent_area_name == "虚拟主播"
    assert row.total_income == 10501.5
    assert row.start_at == datetime(2026, 9, 5, 12, 1, 35)        # naive UTC
    assert row.end_at == datetime(2026, 9, 5, 17, 8, 10, 562000)


def test_live_sessions_sync_skips_bad_account(db):
    v = VTuber(name="测试V")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="434334701")
    db.add(acc)
    db.commit()

    src = DanmakusSource()
    client = FakeClient({"https://ukamnads.icu/api/v2/channel": {"code": 500, "data": None}})
    import asyncio
    s = asyncio.run(src.run_job("live_sessions", db, client))
    assert s.stored == 0 and s.skipped == 1


# ── 单场弹幕摘要（/api/v2/live，2026-09-07 实测公开） ────────────────

def test_parse_live_summary_wordcloud():
    from app.services.externals.danmakus import _parse_live_summary
    payload = {"total": 39316, "pageNum": 0, "pageSize": 1, "hasMore": True,
               "data": {"channel": {"fansCount": 133596, "totalDanmakuCount": 6951279},
                        "live": {
                   "liveId": "f2d49c20-e00b-4c18-aca0-91baf5832ab2",
                   "danmakusCount": 17931, "watchCount": 16216, "likeCount": 163579,
                   "payCount": 542, "interactionCount": 1127, "onlineRank": 250,
                   "commentCount": 0, "isFull": True, "isMerged": True,
                   "versions": [{"userName": "本站", "isOfficial": True}],
                   "extra": {"wordCloud": {"好耶": 3195, "MELODY": 210, "x": 0},
                             "onlineRank": {"1788609741572": 135,
                                            "1788609992428": 366,
                                            "1788609729866": 118}}}}}
    s = _parse_live_summary(payload)
    assert s["total"] == 39316
    assert s["danmakus_count"] == 17931
    assert s["word_cloud"][:2] == [("好耶", 3195), ("MELODY", 210)]   # 降序且忽略 0 次
    # A 组指标
    assert s["watch_count"] == 16216 and s["like_count"] == 163579
    assert s["pay_count"] == 542 and s["interaction_count"] == 1127
    assert s["online_rank"] == 250 and s["is_full"] is True and s["is_merged"] is True
    assert s["peaks"][0] == {"ts": 1788609992428, "count": 366}       # 峰值 top5 降序
    assert s["versions"][0] == {"user_name": "本站", "is_official": True}
    assert s["channel"]["fans_count"] == 133596
    # 异常形状 → 降级空摘要（不炸）
    assert _parse_live_summary(None) is None
    assert _parse_live_summary({"data": None})["word_cloud"] == []


def test_parse_live_summary_reports_upstream_wordcloud_status():
    """回归（2026-09-13，devlog/060 实测）：`extra` 缺失时状态要如实报出来。

    背景：上游原本在 `data.live.extra.wordCloud` 里给预计算好的热词，2026-09-13 实测
    该字段整个不存在（不是空对象）。前端需要据此显示「上游未提供 + 用弹幕自建」，
    所以解析层必须把"有没有 extra"如实带出来，而不是只给一个空 `word_cloud`。
    """
    from app.services.externals.danmakus import _parse_live_summary

    # ① 正常：有 wordCloud
    ok = _parse_live_summary({"total": 100, "data": {"live": {
        "danmakusCount": 100,
        "extra": {"wordCloud": {"好耶": 5}, "onlineRank": {"1": 9}}}}})
    assert ok["status"] == "upstream"
    assert ok["has_extra"] is True
    assert ok["word_cloud"] == [("好耶", 5)]

    # ② 断供：extra 整个缺失 → upstream_absent + has_extra False
    absent = _parse_live_summary({"total": 100, "data": {"live": {
        "danmakusCount": 100}}})
    assert absent["status"] == "upstream_absent"
    assert absent["has_extra"] is False
    assert absent["word_cloud"] == []

    # ③ extra 在、但 wordCloud 空（或全是 0 次）→ 同样算"上游没给词云"
    empty = _parse_live_summary({"total": 100, "data": {"live": {
        "danmakusCount": 100,
        "extra": {"wordCloud": {}, "onlineRank": {"1": 9}}}}})
    assert empty["has_extra"] is True
    assert empty["status"] == "upstream_absent"
    zero = _parse_live_summary({"total": 1, "data": {"live": {
        "extra": {"wordCloud": {"x": 0}}}}})
    assert zero["status"] == "upstream_absent"

    # ④ live 形状都不对时也不能抛错
    assert _parse_live_summary({"data": {"live": None}})["status"] == "upstream_absent"


def test_parse_live_events():
    from app.services.externals.danmakus import _parse_live_events
    payload = {"data": {"danmakus": [
        {"uId": -1, "uName": "", "type": 7, "sendDate": 1788628090562},
        {"uId": -1, "uName": "", "type": 8, "sendDate": 1788628100000},
        {"uId": 1, "uName": "x", "type": 1, "sendDate": 1788628000000},  # 礼物不采
    ]}}
    evts = _parse_live_events(payload)
    assert [(e["type"], e["send_date_ms"]) for e in evts] == [
        (7, 1788628090562), (8, 1788628100000)]
    assert _parse_live_events(None) == []


# ── 重试契约（devlog/062）────────────────────────────────────────────

def test_live_summary_retry_returns_none_not_raises(monkeypatch):
    """上游连续慢/失败时 `fetch_live_summary` **必须返回 None**，不能抛 RetryError。

    背景（devlog/062）：danmakus 上游会间歇性变慢，5 个最近场次全被单次 12s 超时
    误判成「本场没有弹幕数据」。修法是放宽超时 + 3 次重试；但如果重试耗尽后抛
    `tenacity.RetryError`，路由层会把「上游慢」变成 500 —— 所以这里锁死降级契约。
    """
    import asyncio
    from app.services.externals import danmakus as dm

    async def fake_sleep(_s):
        pass

    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    calls: list[str] = []

    async def always_none(live_id):
        calls.append(live_id)
        return None

    monkeypatch.setattr(dm, "_fetch_live_summary_once", always_none)
    res = asyncio.run(dm.fetch_live_summary("L-fail"))
    assert res is None                      # 不是 RetryError、不是异常
    assert len(calls) == 3                  # 确实重试了 3 次

    # 第 2 次成功 → 立刻返回，不再继续重试
    ok = {"total": 1, "word_cloud": [("好耶", 5)], "status": "upstream"}
    flaky: list[int] = []

    async def flaky_once(live_id):
        flaky.append(1)
        return None if len(flaky) == 1 else ok

    monkeypatch.setattr(dm, "_fetch_live_summary_once", flaky_once)
    assert asyncio.run(dm.fetch_live_summary("L-flaky")) == ok
    assert len(flaky) == 2


def test_live_events_retry_returns_empty_not_raises(monkeypatch):
    """事件请求同样：耗尽重试后返回 `[]`（同 `fetch_live_summary` 的降级契约）。"""
    import asyncio
    import httpx
    from app.services.externals import danmakus as dm

    async def fake_sleep(_s):
        pass

    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    calls: list[int] = []

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, *a, **kw):
            calls.append(1)
            raise httpx.ConnectTimeout("upstream too slow")

    monkeypatch.setattr(dm, "new_async_client", lambda *a, **kw: FakeClient())
    assert asyncio.run(dm.fetch_live_events("L-fail")) == []
    assert len(calls) == 3


def test_live_timeout_not_regressed_below_20s():
    """`_LIVE_TIMEOUT` 不允许被调回 12s：那是「有弹幕却被判无数据」的直接成因。"""
    from app.services.externals.danmakus import _LIVE_TIMEOUT
    assert _LIVE_TIMEOUT >= 20.0


# ── 注册表与空壳 ────────────────────────────────────────────────────

def test_registry_sources():
    names = {s.name for s in iter_external_sources()}
    assert {"zeroroku", "danmakus", "laplace"} <= names
    src = get_external_source("laplace")
    assert src is not None and src.enabled is False   # 无 API 默认禁用
    assert get_external_source("nonexistent") is None
