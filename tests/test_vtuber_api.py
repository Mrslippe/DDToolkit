import json
import pytest
from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

# 独立测试库，避免污染开发数据库
test_engine = create_engine("sqlite:///./test_vtuber.db", connect_args={"check_same_thread": False})


# 与生产同口径：SQLite 默认不校验外键，只有开 PRAGMA 才能测出
# 「删账号时子表没清干净」这类整次回滚的问题（2026-09-08 解除订阅失败事故）。
@event.listens_for(test_engine, "connect")
def _fk_on(dbapi_connection, _record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


TestingSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

from app.main import app
from app.core.database import Base, get_db
from app.models.vtuber import (VTuber, Account, Post, AccountStatSnapshot,
                               LiveSession, LiveCategoryOverride, LiveGiftDay,
                               VtuberEvent, VtuberFieldHistory)
from app.repositories.vtuber_repo import AccountStatSnapshotRepo


def override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    db = TestingSession()
    try:
        # 顺序即外键依赖：子表先清（PRAGMA foreign_keys=ON 下反序会被挡）
        for t in (Post, AccountStatSnapshot, LiveSession, LiveCategoryOverride,
                  LiveGiftDay, VtuberEvent, Account, VTuber):
            db.query(t).delete()
        db.commit()
    finally:
        db.close()
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def client():
    return TestClient(app)


# ── VTuber ─────────────────────────────────────────────────────────

def test_create_vtuber(client):
    resp = client.post("/vtuber", json={"name": "测试主播", "birthday": "01-01"})
    assert resp.status_code == 201
    assert resp.json()["name"] == "测试主播"


def test_list_vtubers(client):
    client.post("/vtuber", json={"name": "A"})
    client.post("/vtuber", json={"name": "B"})
    assert len(client.get("/vtuber/list").json()) == 2


def test_get_vtuber(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    assert client.get(f"/vtuber/{vid}").json()["name"] == "测试"


def test_update_vtuber(client):
    vid = client.post("/vtuber", json={"name": "旧"}).json()["id"]
    assert client.put(f"/vtuber/{vid}", json={"name": "新"}).json()["name"] == "新"


def test_delete_vtuber(client):
    vid = client.post("/vtuber", json={"name": "待删除"}).json()["id"]
    assert client.delete(f"/vtuber/{vid}").status_code == 204
    assert client.get(f"/vtuber/{vid}").status_code == 404


# ── Account ─────────────────────────────────────────────────────────

def test_add_account(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    resp = client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "123"})
    assert resp.status_code == 201
    assert resp.json()["platform_uid"] == "123"


def test_add_account_triggers_fetch_and_backfill(monkeypatch, client):
    """「添加平台账号」立刻拉起该账号的抓取链路（v0.9.3 用户反馈：此前只建行不抓取；
    v0.9.4 改为只抓新增账号 + 首屏内容并发，见 _adopt_background）。"""
    import app.routers.vtuber as router_mod

    queued: list[tuple[int, int, str]] = []

    async def fake_background(vtuber_id: int, account_id: int, label: str = "") -> None:
        queued.append((vtuber_id, account_id, label))

    monkeypatch.setattr(router_mod, "_adopt_background", fake_background)

    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    resp = client.post(f"/vtuber/{vid}/accounts",
                       json={"platform": "bilibili", "platform_uid": "1234",
                             "display_name": "昵称A"})
    assert resp.status_code == 201
    aid = resp.json()["id"]
    assert queued == [(vid, aid, "昵称A")]   # 响应后立刻拉起该账号的抓取链路


def test_adopt_background_runs_account_and_first_screen_concurrently(monkeypatch):
    """收录后台链路：账号信息 ∥ 首屏内容（两把锁独立，墙钟 = max），
    第三方历史回填脱离关键路径（create_task，不阻塞前两步）。"""
    import asyncio

    import app.routers.vtuber as router_mod

    started: set[str] = set()
    gate = asyncio.Event()
    order: list[str] = []
    spawned_before_gather: list[int] = []

    async def fake_accounts(account_ids, label=""):
        started.add("account")
        # 回填必须在两条关键路径**跑起来之前**就已 spawn（否则日志里会断开）
        spawned_before_gather.append(len(created))
        if len(started) == 2:
            gate.set()
        await asyncio.wait_for(gate.wait(), timeout=2)   # 串行执行会超时
        order.append("account-done")
        return type("R", (), {"success": 1, "failed": 0, "skipped": 0, "details": []})()

    async def fake_first_screen(account_id):
        started.add("first")
        spawned_before_gather.append(len(created))
        if len(started) == 2:
            gate.set()
        await asyncio.wait_for(gate.wait(), timeout=2)
        order.append("first-done")
        return None

    backfilled: list[int] = []

    async def fake_backfill(account_id: int, label: str = "") -> None:
        backfilled.append(account_id)

    monkeypatch.setattr(router_mod, "async_fetch_accounts", fake_accounts)
    monkeypatch.setattr(router_mod, "async_fetch_first_screen", fake_first_screen)
    monkeypatch.setattr(router_mod, "_backfill_adopted_history", fake_backfill)

    created: list = []

    class _FakeTask:
        def __init__(self, coro):
            self.coro = coro
            self.callbacks = []

        def add_done_callback(self, cb):
            self.callbacks.append(cb)

    def fake_create_task(coro):
        created.append(_FakeTask(coro))
        return created[-1]

    monkeypatch.setattr(router_mod.asyncio, "create_task", fake_create_task)
    # 强引用集合也换成假的，避免污染模块级状态
    monkeypatch.setattr(router_mod, "_background_tasks", set())

    asyncio.run(router_mod._adopt_background(5, 42))
    assert started == {"account", "first"}      # 两条路径都跑到了
    assert sorted(order) == ["account-done", "first-done"]
    assert len(created) == 1                     # 第三方回填以独立任务启动（未阻塞）
    assert spawned_before_gather == [1, 1]       # 且是在两条关键路径起跑之前 spawn 的
    assert len(created[0].callbacks) == 1        # 完成回调已挂（强引用集合自清理）

    # 收尾：把未 await 的协程关掉，避免 RuntimeWarning
    created[0].coro.close()


def test_adopt_triggers_background_chain(monkeypatch, client):
    """收录（添加新 V）：建库 + 后台链路（账号信息 ∥ 首屏 + 第三方历史）。"""
    import app.routers.vtuber as router_mod

    monkeypatch.setattr(
        router_mod.pool, "find_in_pool",
        lambda p, u: {"name": "池内名", "platform": p, "platform_uid": u})

    queued: list[tuple[int, int, str]] = []

    async def fake_background(vtuber_id: int, account_id: int, label: str = "") -> None:
        queued.append((vtuber_id, account_id, label))

    monkeypatch.setattr(router_mod, "_adopt_background", fake_background)

    r = client.post("/vtuber/adopt",
                    json={"platform": "bilibili", "platform_uid": "401315430"})
    assert r.status_code == 201
    vid = r.json()["id"]
    assert r.json()["name"] == "池内名"     # 名称以池为准
    aid = client.get(f"/vtuber/{vid}/accounts").json()[0]["id"]
    assert queued == [(vid, aid, "池内名")]
    # 池内不存在 → 404（不建库）
    monkeypatch.setattr(router_mod.pool, "find_in_pool", lambda p, u: None)
    assert client.post("/vtuber/adopt",
                       json={"platform": "bilibili", "platform_uid": "999"}).status_code == 404


def test_bili_search_endpoint_maps_items_and_flags_in_library(monkeypatch, client):
    """`GET /vtuber/bili/search`（R11，devlog/083）：字段透传 + `in_library` 标注 + 错误文案。

    `in_library` 是前端"已订阅置灰"的依据；标错的代价是"看着能加、点了 409"。
    """
    import app.routers.vtuber as router_mod
    from app.services.bili_search import SearchResult

    async def fake_search(kw: str, page: int = 1):
        assert kw == "塔菲" and page == 2
        return SearchResult(items=[
            {"platform": "bilibili", "platform_uid": "1265680561", "name": "永雏塔菲",
             "sign": "王牌级偶像", "followers": 2753531, "avatar": "https://x/a.jpg",
             "verified": "bilibili 知名游戏UP主", "is_live": True, "room_id": "22603245",
             "videos": 463, "level": 6, "exact": False},
            {"platform": "bilibili", "platform_uid": "999", "name": "已订阅的人",
             "sign": "", "followers": 1, "avatar": "", "verified": "",
             "is_live": False, "room_id": None, "videos": 0, "level": 0, "exact": False},
        ], page=2, total_pages=5, has_more=True, cached=True)

    monkeypatch.setattr(router_mod.bili_search_svc, "search", fake_search)

    # 先把 uid=999 入库，验证已订阅标注
    vid = client.post("/vtuber", json={"name": "已订阅"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts",
                json={"platform": "bilibili", "platform_uid": "999"})

    r = client.get("/vtuber/bili/search?kw=塔菲&page=2")
    assert r.status_code == 200
    body = r.json()
    assert body["page"] == 2 and body["has_more"] is True and body["cached"] is True
    items = {it["platform_uid"]: it for it in body["items"]}
    assert items["1265680561"]["name"] == "永雏塔菲"
    assert items["1265680561"]["followers"] == 2753531
    assert items["1265680561"]["verified"] == "bilibili 知名游戏UP主"
    assert items["1265680561"]["in_library"] is False      # 没入库
    assert items["999"]["in_library"] is True              # 已入库 → 前端置灰

    # 错误路径：error + hint 必须原样透传（前端据此说人话，而不是"没有这个人"）
    async def fake_degraded(kw: str, page: int = 1):
        return SearchResult(error="upstream_degraded", hint="B 站对本次检索做了限制")

    monkeypatch.setattr(router_mod.bili_search_svc, "search", fake_degraded)
    body2 = client.get("/vtuber/bili/search?kw=塔菲").json()
    assert body2["items"] == [] and body2["error"] == "upstream_degraded"
    assert "限制" in body2["hint"]


def test_adopt_from_bilibili_requires_server_side_verification(monkeypatch, client):
    """池外收录（`source='bilibili'`）**必须服务端实查通过**才建库（R11，devlog/083）。

    这条是安全边界：不实查就能随便填个 uid 建 V；名称也必须以实查结果为准
    （前端传什么都不作数）。
    """
    import app.routers.vtuber as router_mod
    from app.services.bili_search import SearchResult

    monkeypatch.setattr(router_mod.pool, "find_in_pool", lambda p, u: None)   # 池外
    called = {"n": 0}

    async def fake_exact(uid: str, client=None):
        called["n"] += 1
        if uid == "1265680561":
            return SearchResult(items=[{"platform_uid": uid, "name": "永雏塔菲",
                                        "sign": "", "followers": 1, "avatar": "",
                                        "verified": "", "is_live": False,
                                        "room_id": None, "videos": 0, "level": 0,
                                        "exact": True}], exact=True)
        return SearchResult(error="not_found", hint="B 站没有这个 UID（或已注销）")

    monkeypatch.setattr(router_mod.bili_search_svc, "exact_user", fake_exact)

    async def noop_background(*_a, **_k) -> None:
        return None
    monkeypatch.setattr(router_mod, "_adopt_background", noop_background)

    # ① 实查通过 → 建库，名称取实查结果
    r = client.post("/vtuber/adopt",
                    json={"platform": "bilibili", "platform_uid": "1265680561",
                          "source": "bilibili"})
    assert r.status_code == 201
    assert r.json()["name"] == "永雏塔菲"
    assert called["n"] == 1

    # ② 实查失败 → 404，不建库（错误文案用上游给的 hint）
    r2 = client.post("/vtuber/adopt",
                     json={"platform": "bilibili", "platform_uid": "99999999",
                           "source": "bilibili"})
    assert r2.status_code == 404
    assert "注销" in r2.json()["detail"]
    assert client.get("/vtuber/list").json().__len__() == 1        # 只建了上面那一个

    # ③ 池外但没声明 source → 仍 404（不给"顺手绕过池子"的口子）
    r3 = client.post("/vtuber/adopt",
                     json={"platform": "bilibili", "platform_uid": "88888888"})
    assert r3.status_code == 404
    assert called["n"] == 2                                        # ③ 没有触发实查

    # ④ 池外 + 非 bilibili → 400（当前只支持 B 站直搜）
    r4 = client.post("/vtuber/adopt",
                     json={"platform": "weibo", "platform_uid": "88888888",
                           "source": "bilibili"})
    assert r4.status_code == 400

    # ⑤ 池内条目**不**触发实查（原行为不变，省一次上游）
    monkeypatch.setattr(router_mod.pool, "find_in_pool",
                        lambda p, u: {"name": "池内名", "platform": p, "platform_uid": u})
    r5 = client.post("/vtuber/adopt",
                     json={"platform": "bilibili", "platform_uid": "401315430"})
    assert r5.status_code == 201 and r5.json()["name"] == "池内名"
    assert called["n"] == 2


def test_adopt_does_not_disguise_upstream_failure_as_not_found(monkeypatch, client):
    """池外收录：**上游没问到 ≠ 没有这个人**（R11 复核，2026-09-15）。

    实测踩到：未登录时 WBI 取密钥失败（`nav` 回 -101），当时异常直接冒成 500；
    若图省事一律回 404"查不到"，用户会以为"B 站没这个 UID"，实际是**自己没登录**。
    所以只有 `not_found`/`bad_uid` 是 404，其余（未登录/网络/风控）一律 503 + 原因。
    """
    import app.routers.vtuber as router_mod
    from app.services.bili_search import SearchResult

    monkeypatch.setattr(router_mod.pool, "find_in_pool", lambda p, u: None)
    state = {"err": "not_logged_in", "hint": "请先登录 B 站"}

    async def fake_exact(uid: str, client=None):
        return SearchResult(error=state["err"], hint=state["hint"])

    monkeypatch.setattr(router_mod.bili_search_svc, "exact_user", fake_exact)

    async def noop_background(*_a, **_k) -> None:
        return None
    monkeypatch.setattr(router_mod, "_adopt_background", noop_background)

    payload = {"platform": "bilibili", "platform_uid": "1265680561", "source": "bilibili"}
    r = client.post("/vtuber/adopt", json=payload)
    assert r.status_code == 503
    assert "登录" in r.json()["detail"]

    # 网络/风控同样是 503（"我们没问到"）
    state.update(err="network_error", hint="网络异常，稍后重试")
    assert client.post("/vtuber/adopt", json=payload).status_code == 503

    # 只有上游确实说"没有这个人"才是 404
    state.update(err="not_found", hint="B 站没有这个 UID 或该用户已注销")
    r404 = client.post("/vtuber/adopt", json=payload)
    assert r404.status_code == 404
    assert "注销" in r404.json()["detail"]

    # 全程没建库
    assert client.get("/vtuber/list").json() == []


def test_pool_search_merges_csv_pool_and_thirdparty_index(monkeypatch, client):
    """本地检索合并两个来源（R11）：csv 池优先 + danmakus 索引兜底，按 uid 去重、剔除已入库。"""
    import app.routers.vtuber as router_mod
    from app.models.vtuber import ThirdpartyVtuber

    monkeypatch.setattr(router_mod.pool, "search_pool", lambda kw, limit=20: [
        {"name": "永雏塔菲", "platform": "bilibili", "platform_uid": "1265680561"},
    ])
    db = TestingSession()
    try:
        db.add_all([
            # 与池内同 uid（应被去重，池优先）
            ThirdpartyVtuber(platform="bilibili", platform_uid="1265680561",
                             name="索引里的塔菲", source="danmakus"),
            # 只在索引里（新 V）→ 应作为 origin=index 出现
            ThirdpartyVtuber(platform="bilibili", platform_uid="777777",
                             name="索引新V", group_name="某企划", source="danmakus"),
            # 已入库 → 不该出现
            ThirdpartyVtuber(platform="bilibili", platform_uid="555555",
                             name="已订阅的", source="danmakus"),
        ])
        db.commit()
    finally:
        db.close()
    vid = client.post("/vtuber", json={"name": "已订阅"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts",
                json={"platform": "bilibili", "platform_uid": "555555"})

    rows = client.get("/vtuber/pool/search?kw=塔菲").json()
    by_uid = {r["platform_uid"]: r for r in rows}
    assert by_uid["1265680561"]["name"] == "永雏塔菲"        # 池优先（名称更规范）
    assert by_uid["1265680561"]["origin"] == "pool"
    assert "555555" not in by_uid                            # 已入库剔除

    rows2 = client.get("/vtuber/pool/search?kw=索引").json()
    idx = {r["platform_uid"]: r for r in rows2}
    assert idx["777777"]["origin"] == "index"
    assert idx["777777"]["group"] == "某企划"


def test_backfill_registers_external_status(monkeypatch, client):
    """收录回填期间登记外部任务状态（顶栏胶囊），结束后注销并自增 seq。"""
    import app.routers.vtuber as router_mod
    from app.services import scheduler as sch

    events: list[tuple[str, str]] = []

    monkeypatch.setattr(sch, "external_task_started",
                        lambda token, label: events.append(("start", f"{token}|{label}")))
    monkeypatch.setattr(sch, "external_task_finished",
                        lambda token: events.append(("finish", token)))

    # 建库阶段不跑真实后台链路（本用例只验证回填的状态登记）
    async def noop_background(*_a, **_k) -> None:
        return None

    monkeypatch.setattr(router_mod, "_adopt_background", noop_background)

    async def fake_interval(interval, account_ids=None):
        return [{"kind": "fan_history"}, {"kind": "live_sessions"}]

    import app.services.externals.runner as runner_mod
    monkeypatch.setattr(runner_mod, "run_external_interval", fake_interval)

    vid = client.post("/vtuber", json={"name": "回填V"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": "555",
                            "display_name": "回填V"}).json()["id"]

    import asyncio

    asyncio.run(router_mod._backfill_adopted_history(aid, "回填V"))
    assert events[0][0] == "start"
    assert events[0][1] == f"adopt:{aid}|回填V 的历史数据"
    assert events[-1] == ("finish", f"adopt:{aid}")


def test_account_order_endpoint(client, monkeypatch):
    """P8-B（v0.9.7）：平台账号展示顺序可重排（card 视图拖拽落库）。"""
    import app.routers.vtuber as router_mod

    async def noop_background(*_a, **_k) -> None:
        return None

    monkeypatch.setattr(router_mod, "_adopt_background", noop_background)

    vid = client.post("/vtuber", json={"name": "排序V"}).json()["id"]
    ids = [
        client.post(f"/vtuber/{vid}/accounts",
                    json={"platform": p, "platform_uid": u,
                          "display_name": p}).json()["id"]
        for p, u in (("bilibili", "111"), ("weibo", "222"), ("youtube", "333"))
    ]
    assert [a["id"] for a in client.get(f"/vtuber/{vid}/accounts").json()] == ids

    r = client.put(f"/vtuber/{vid}/account-order",
                   json={"account_ids": [ids[2], ids[0]]})   # 未列出的 ids[1] 排在其后
    assert r.status_code == 200
    assert [a["id"] for a in r.json()] == [ids[2], ids[0], ids[1]]
    assert [a["sort_order"] for a in r.json()] == [0, 1, 2]
    assert [a["id"] for a in client.get(f"/vtuber/{vid}/accounts").json()] == \
        [ids[2], ids[0], ids[1]]
    assert client.put("/vtuber/99999/account-order",
                      json={"account_ids": []}).status_code == 404


def test_former_values_roundtrip(client, monkeypatch):
    """2026-09-13（devlog/075 改口径）：曾用值只由**抓取覆盖**产生，手改不入账。

    用户实测反馈："展示的内容不对，那是我上次修改入库的错误签名，不是真的历史签名"——
    所以 `PUT /account` 改成**不记**，端点只反映平台侧被覆盖掉的旧值
    （写入路径见 `test_fetch_one_account_records_former_name_and_sign`）。
    """
    import app.routers.vtuber as router_mod

    async def noop_background(*_a, **_k) -> None:
        return None

    monkeypatch.setattr(router_mod, "_adopt_background", noop_background)

    vid = client.post("/vtuber", json={"name": "曾用名V"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": "556",
                            "display_name": "旧昵称", "sign": "旧签名"}).json()["id"]

    # 空态：还没被抓取覆盖过 → 两个列表都空
    empty = client.get(f"/vtuber/{vid}/former-values").json()
    assert empty == {"names": [], "signs": []}

    r = client.put(f"/account/{aid}", json={"display_name": "手改昵称", "sign": "手改签名"})
    assert r.status_code == 200
    assert "locked_fields" not in r.json()          # 字段已退役，不再回传
    assert r.json()["display_name"] == "手改昵称"    # 手改照常写入

    # ⚠️ 核心口径：手改**不产生**曾用值（否则用户自己打错的字符串会被标成"曾用签名"）
    assert client.get(f"/vtuber/{vid}/former-values").json() == {"names": [], "signs": []}

    # 平台侧覆盖（模拟抓取回写）→ 旧值入库，且能读出平台标注
    from app.services.vtuber_history import record_field_change
    db = TestingSession()
    try:
        record_field_change(db, vtuber_id=vid, account_id=aid,
                            field="display_name", old_value="旧昵称")
        db.commit()
    finally:
        db.close()
    d = client.get(f"/vtuber/{vid}/former-values").json()
    assert [n["value"] for n in d["names"]] == ["旧昵称"]
    assert d["names"][0]["platform"] == "bilibili"  # 标注是哪个平台的曾用名
    assert d["names"][0]["changed_at"] is not None

    db = TestingSession()
    try:
        record_field_change(db, vtuber_id=vid, account_id=aid,
                            field="display_name", old_value="旧昵称")   # 同一值重复 → 不记
        record_field_change(db, vtuber_id=vid, account_id=aid,
                            field="display_name", old_value="平台第二版")
        db.commit()
    finally:
        db.close()
    d2 = client.get(f"/vtuber/{vid}/former-values").json()
    assert [n["value"] for n in d2["names"]] == ["平台第二版", "旧昵称"]

    assert client.get("/vtuber/99999/former-values").status_code == 404


def test_vtuber_sign_source_roundtrip(client, monkeypatch):
    """签名来源与覆盖两个字段可经 PUT /vtuber/{id} 写入并回读（A3 口径）。"""
    import app.routers.vtuber as router_mod

    async def noop_background(*_a, **_k) -> None:
        return None

    monkeypatch.setattr(router_mod, "_adopt_background", noop_background)
    vid = client.post("/vtuber", json={"name": "签名V"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": "557"}).json()["id"]

    d = client.get(f"/vtuber/{vid}").json()
    assert d["sign_override"] is None and d["sign_source_account_id"] is None

    r = client.put(f"/vtuber/{vid}", json={"sign_override": "自定义签名",
                                          "sign_source_account_id": aid})
    assert r.status_code == 200
    body = r.json()
    assert body["sign_override"] == "自定义签名"
    assert body["sign_source_account_id"] == aid
    # 清空覆盖（回落到"跟随来源账号"）
    d2 = client.put(f"/vtuber/{vid}", json={"sign_override": None}).json()
    assert d2["sign_override"] is None
    assert d2["sign_source_account_id"] == aid


def test_list_accounts(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "111"})
    client.post(f"/vtuber/{vid}/accounts", json={"platform": "youtube", "platform_uid": "222"})
    assert len(client.get(f"/vtuber/{vid}/accounts").json()) == 2


def test_update_account(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "123"}).json()["id"]
    assert client.put(f"/account/{aid}", json={"display_name": "新昵称"}).json()["display_name"] == "新昵称"


def test_delete_account(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "123"}).json()["id"]
    assert client.delete(f"/account/{aid}").status_code == 204


# ── Post ────────────────────────────────────────────────────────────

def test_add_post(client):
    resp = client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "123", "platform_post_id": "BV123",
        "type": "video", "title": "新视频",
    })
    assert resp.status_code == 201
    assert resp.json()["platform"] == "bilibili"


def test_list_posts(client):
    client.post("/posts", json={"platform": "bilibili", "platform_uid": "U1", "platform_post_id": "p1", "type": "text"})
    client.post("/posts", json={"platform": "bilibili", "platform_uid": "U1", "platform_post_id": "p2", "type": "video"})
    client.post("/posts", json={"platform": "bilibili", "platform_uid": "U2", "platform_post_id": "p3", "type": "text"})
    assert len(client.get("/posts/bilibili/U1").json()) == 2


# ── Error cases ─────────────────────────────────────────────────────

def test_get_nonexistent_vtuber(client):
    assert client.get("/vtuber/99999").status_code == 404


def test_delete_nonexistent_vtuber(client):
    assert client.delete("/vtuber/99999").status_code == 404


def test_cascade_delete(client):
    vid = client.post("/vtuber", json={"name": "级联"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "999"})
    client.delete(f"/vtuber/{vid}")
    assert client.get(f"/vtuber/{vid}/accounts").status_code == 404


# ── 分页 / 统计端点（前端帖子列表用） ─────────────────────────────────

def _seed_posts(client, uid="U1", n=25):
    for i in range(n):
        client.post("/posts", json={
            "platform": "bilibili", "platform_uid": uid,
            "platform_post_id": f"p{i:03d}",
            "type": "video" if i % 2 == 0 else "text",
            "title": f"标题 {i}",
        })


def test_posts_paginated(client):
    _seed_posts(client, n=25)
    r1 = client.get("/posts/bilibili/U1/paginated?page=1&page_size=10").json()
    assert r1["total"] == 25
    assert len(r1["items"]) == 10
    assert r1["page"] == 1 and r1["page_size"] == 10
    r3 = client.get("/posts/bilibili/U1/paginated?page=3&page_size=10").json()
    assert len(r3["items"]) == 5
    # 越界页返回空列表但 total 不变
    r9 = client.get("/posts/bilibili/U1/paginated?page=9&page_size=10").json()
    assert r9["items"] == []
    assert r9["total"] == 25


def test_posts_paginated_filter_by_type(client):
    _seed_posts(client, n=10)
    r = client.get("/posts/bilibili/U1/paginated?type=video").json()
    assert r["total"] == 5
    assert all(p["type"] == "video" for p in r["items"])
    # 兼容性：旧端点（无分页参数）仍返回完整列表
    legacy = client.get("/posts/bilibili/U1").json()
    assert len(legacy) == 10


def test_posts_paginated_filter_multi_type(client):
    # 逗号分隔多型（前端「投稿/图文」分组 chip）：video+text → 全部 10 条
    _seed_posts(client, n=10)
    r = client.get("/posts/bilibili/U1/paginated?type=video,text").json()
    assert r["total"] == 10
    assert all(p["type"] in ("video", "text") for p in r["items"])
    # 逗号带空格同样生效（strip 容错）
    r2 = client.get("/posts/bilibili/U1/paginated?type=video,%20text").json()
    assert r2["total"] == 10


def test_posts_stats(client):
    _seed_posts(client, n=10)
    r = client.get("/posts/bilibili/U1/stats").json()
    assert r["total"] == 10
    assert r["archived"] == 0
    assert r["by_type"] == {"video": 5, "text": 5}
    assert r["platform"] == "bilibili" and r["platform_uid"] == "U1"


def test_posts_paginated_search_matches_body_text(client):
    # P2 全文搜索：q 命中正文正文（title/summary 均不含）——body_text 由后端
    # 从 body_json 派生（create_post），检索逻辑扩展 OR 匹配
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1",
        "platform_post_id": "pbody", "type": "text",
        "title": "第一个帖子", "summary": "第一段摘要",
        "body_json": json.dumps({"text": "海马体在深海里开花了吗", "images": []}, ensure_ascii=False),
    })
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1",
        "platform_post_id": "phead", "type": "text",
        "title": "标题命中", "summary": "摘要也在",
    })
    r = client.get("/posts/bilibili/U1/paginated?q=海马体").json()
    assert r["total"] == 1
    assert r["items"][0]["platform_post_id"] == "pbody"
    # 标题/摘要命中回归不变
    r2 = client.get("/posts/bilibili/U1/paginated?q=标题命中").json()
    assert r2["total"] == 1
    assert r2["items"][0]["platform_post_id"] == "phead"
    # 正文 HTML（content）剥离标签后亦可命中
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1",
        "platform_post_id": "phtml", "type": "article",
        "title": "专栏", "summary": "专栏摘要",
        "body_json": json.dumps({"content": "<p>深处埋着霓虹色的鲸歌</p>"}, ensure_ascii=False),
    })
    r3 = client.get("/posts/bilibili/U1/paginated?q=霓虹色").json()
    assert r3["total"] == 1
    assert r3["items"][0]["platform_post_id"] == "phtml"


# ── 归档规则 + 未归档动态更新（devlog/016） ─────────────────────────────

def test_archive_posts_endpoint(client):
    """归档端点：早于 cutoff 的归档、晚于的不动，且幂等。

    ⚠️ 日期必须**相对 now 算**（2026-09-14，devlog/081）：原来"新帖"写死
    `2026-08-15`，而断言是 `days=30` —— 那是个**日期炸弹**：日子一到
    （08-15 + 30d = 09-14）"新帖"自己跨过截止线，用例毫无改动地变红
    （实测 `archived: 1 → 2`）。写这类"多久算旧"的断言一律用相对时间。
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    old_at = (now - timedelta(days=60)).strftime("%Y-%m-%dT%H:%M:%S")
    new_at = (now - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1", "platform_post_id": "OLD",
        "type": "text", "published_at": old_at,
    })
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1", "platform_post_id": "NEW",
        "type": "text", "published_at": new_at,
    })
    r = client.post("/posts/archive?days=30").json()
    assert r["status"] == "done"
    assert r["archived"] == 1
    assert r["unarchived_total"] == 1
    # 幂等：再次执行不再归档
    assert client.post("/posts/archive?days=30").json()["archived"] == 0


def test_update_posts_endpoint(client, monkeypatch):
    from app.routers import vtuber as vrouter

    async def fake_update(name=None):
        return {"status": "done", "archived": 5,
                "total": {"dynamics": 3, "stored": 1, "skipped": 2},
                "details": [{"platform_uid": "123", "dynamics": 3, "stored": 1,
                             "skipped": 2, "archived_stop": True, "rate_limited": False}]}

    monkeypatch.setattr(vrouter, "async_update_unarchived_posts", fake_update)
    r1 = client.post("/vtuber/update-posts?name=明前").json()
    assert r1["status"] == "done" and r1["archived"] == 5
    r2 = client.post("/vtuber/update-posts").json()  # 无 name = 全部
    assert r2["total"]["stored"] == 1
    assert r2["details"][0]["archived_stop"] is True


def test_fetch_vtuber_endpoint(client, monkeypatch):
    from app.routers import vtuber as vrouter

    vid = client.post("/vtuber", json={"name": "单V测试"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "123"})

    async def fake_fetch(vtuber_id):
        return type("R", (), {"success": 1, "failed": 0, "skipped": 0, "details": []})()

    monkeypatch.setattr(vrouter, "async_fetch_vtuber", fake_fetch)
    r = client.post(f"/vtuber/{vid}/fetch").json()
    assert r["status"] == "done"
    assert r["result"]["success"] == 1
    # 不存在的 VTuber → 404
    assert client.post("/vtuber/99999/fetch").status_code == 404


# ── 优化项：唯一约束 409 / 删帖作用域 ───────────────────────────────────

def test_duplicate_account_returns_409(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    payload = {"platform": "bilibili", "platform_uid": "123"}
    assert client.post(f"/vtuber/{vid}/accounts", json=payload).status_code == 201
    r = client.post(f"/vtuber/{vid}/accounts", json=payload)
    assert r.status_code == 409  # 修复：此前 IntegrityError 冒泡成 500


def test_duplicate_post_returns_409(client):
    data = {"platform": "bilibili", "platform_uid": "U1", "platform_post_id": "p1", "type": "text"}
    assert client.post("/posts", json=data).status_code == 201
    assert client.post("/posts", json=data).status_code == 409


def test_delete_account_cleans_posts(client):
    """修复：删单个账号此前只删 account，其帖子成孤儿数据。"""
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": "U1"}).json()["id"]
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1", "platform_post_id": "p1", "type": "text",
    })
    assert client.delete(f"/account/{aid}").status_code == 204
    assert client.get("/posts/bilibili/U1").json() == []


def test_delete_vtuber_does_not_delete_other_platform_same_uid(client):
    """修复：解订阅删帖曾只按 platform_uid 过滤，跨平台同 UID 会误删。"""
    vid1 = client.post("/vtuber", json={"name": "A"}).json()["id"]
    client.post(f"/vtuber/{vid1}/accounts", json={"platform": "bilibili", "platform_uid": "123"})
    vid2 = client.post("/vtuber", json={"name": "B"}).json()["id"]
    client.post(f"/vtuber/{vid2}/accounts", json={"platform": "youtube", "platform_uid": "123"})
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "123", "platform_post_id": "B1", "type": "text",
    })
    client.post("/posts", json={
        "platform": "youtube", "platform_uid": "123", "platform_post_id": "Y1", "type": "text",
    })
    assert client.delete(f"/vtuber/{vid1}").status_code == 204
    assert client.get("/posts/bilibili/123").json() == []
    assert len(client.get("/posts/youtube/123").json()) == 1  # youtube 帖保留


def test_delete_vtuber_cleans_account_children(client):
    """回归（2026-09-08 解除订阅失败）：账号之下还有挂外键的子表，
    只清 posts 时 `DELETE FROM accounts` 会被 foreign_keys=ON 挡下 → 整次回滚 500。
    这里每张子表都塞一行，删完必须一行不剩。

    f004（devlog/074）新增 `vtuber_field_history`，**必须**跟着进这张清单：
    它同时挂 `vtubers.id` 与 `accounts.id` 两个外键，漏掉就是同一个事故重演。
    """
    vid = client.post("/vtuber", json={"name": "待解订阅"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": "U9"}).json()["id"]
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U9", "platform_post_id": "p1", "type": "text",
    })
    db = TestingSession()
    try:
        db.add(AccountStatSnapshot(account_id=aid, followers_count=123))
        db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-1",
                           title="深夜杂谈", start_at=datetime(2026, 9, 7, 12, 5)))
        db.add(LiveGiftDay(account_id=aid, source="zeroroku", gift_date="2026-09-07",
                           total_amount="12.5"))
        db.add(LiveCategoryOverride(account_id=aid, live_id="uuid-1", category="chat"))
        db.add(VtuberEvent(vtuber_id=vid, title="生日歌回", event_date="2026-09-09"))
        db.add(VtuberFieldHistory(vtuber_id=vid, account_id=aid, field="display_name",
                                  value="旧名字"))
        # account_id 为空的历史行（来源账号已被删）只能靠按 vtuber_id 的那一遍清掉
        db.add(VtuberFieldHistory(vtuber_id=vid, account_id=None, field="sign",
                                  value="旧签名"))
        db.commit()
        # 先确认子表确实有行（否则下面的"一行不剩"是假绿）
        assert db.query(AccountStatSnapshot).count() == 1
        assert db.query(LiveSession).count() == 1
        assert db.query(LiveGiftDay).count() == 1
        assert db.query(LiveCategoryOverride).count() == 1
        assert db.query(VtuberEvent).count() == 1
        assert db.query(VtuberFieldHistory).count() == 2
    finally:
        db.close()

    assert client.delete(f"/vtuber/{vid}").status_code == 204
    assert client.get(f"/vtuber/{vid}").status_code == 404

    db = TestingSession()
    try:
        for model, cond in (
            (AccountStatSnapshot, AccountStatSnapshot.account_id == aid),
            (LiveSession, LiveSession.account_id == aid),
            (LiveGiftDay, LiveGiftDay.account_id == aid),
            (LiveCategoryOverride, LiveCategoryOverride.account_id == aid),
            (VtuberEvent, VtuberEvent.vtuber_id == vid),
            (VtuberFieldHistory, VtuberFieldHistory.vtuber_id == vid),
            (Account, Account.id == aid),
        ):
            assert db.query(model).filter(cond).count() == 0, model.__name__
    finally:
        db.close()
    assert client.get("/posts/bilibili/U9").json() == []


def test_delete_account_cleans_children(client):
    """删单个账号同样要清子表（否则外键挡下 + 孤儿数据）。"""
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": "U7"}).json()["id"]
    db = TestingSession()
    try:
        db.add(AccountStatSnapshot(account_id=aid, followers_count=1))
        db.add(LiveSession(account_id=aid, source="feed", live_id="feed-1",
                           start_at=datetime(2026, 9, 7, 20, 0)))
        db.add(VtuberFieldHistory(vtuber_id=vid, account_id=aid, field="sign", value="旧签名"))
        db.commit()
    finally:
        db.close()

    assert client.delete(f"/account/{aid}").status_code == 204
    assert client.get(f"/vtuber/{vid}").status_code == 200   # V 本体保留

    db = TestingSession()
    try:
        assert db.query(AccountStatSnapshot).filter(
            AccountStatSnapshot.account_id == aid).count() == 0
        assert db.query(LiveSession).filter(LiveSession.account_id == aid).count() == 0
        assert db.query(VtuberFieldHistory).filter(
            VtuberFieldHistory.account_id == aid).count() == 0
    finally:
        db.close()


# ── 自定义背景：上传 / 清除 ─────────────────────────────────────────────

def test_set_and_clear_background(client, monkeypatch):
    """沙箱限制：不用 pytest tmp_path（%TEMP% 可能无权限），改用工作区临时目录。"""
    import shutil
    from pathlib import Path

    from app.core.config import settings

    bg_dir = Path("./.bgtest")
    bg_dir.mkdir(exist_ok=True)
    old_dir = settings.DATA_DIR
    monkeypatch.setattr(settings, "DATA_DIR", bg_dir)
    try:
        vid = client.post("/vtuber", json={"name": "背景测试"}).json()["id"]
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 64  # 伪 PNG 字节
        r = client.post(
            f"/vtuber/{vid}/background",
            files={"file": ("bg.png", png, "image/png")},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["background_path"] and body["background_path"].startswith("static/custom_bg/")
        assert (bg_dir / body["background_path"]).exists()  # 落盘
        # VTuberOut 序列化已含背景字段（前端直接取用）
        assert client.get(f"/vtuber/{vid}").json()["background_path"] == body["background_path"]
        # 非图片类型 → 415
        bad = client.post(
            f"/vtuber/{vid}/background",
            files={"file": ("bg.txt", b"not-an-image", "text/plain")},
        )
        assert bad.status_code == 415
        # 不存在 → 404
        assert client.post(
            "/vtuber/99999/background", files={"file": ("b.png", png, "image/png")},
        ).status_code == 404
        # 清除：字段置空 + 文件删除
        r2 = client.delete(f"/vtuber/{vid}/background")
        assert r2.status_code == 200
        assert r2.json()["background_path"] is None
        assert not (bg_dir / body["background_path"]).exists()
    finally:
        shutil.rmtree(bg_dir, ignore_errors=True)
        settings.DATA_DIR = old_dir


# ── Account 统计快照端点（P0，v0.5.0） ───────────────────────────────

def test_list_account_stat_snapshots(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    repo = AccountStatSnapshotRepo(db)
    repo.add(aid, 1000, 0, None, captured_at=datetime(2026, 8, 1, tzinfo=timezone.utc))
    repo.add(aid, 1100, 1, "开播了", captured_at=datetime(2026, 8, 2, tzinfo=timezone.utc))
    db.commit()
    db.close()

    resp = client.get(f"/account/{aid}/stat-snapshots")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert data[0]["followers_count"] == 1100           # 时间倒序：最新的在前
    assert data[0]["live_status"] == 1
    assert data[0]["live_title"] == "开播了"
    assert data[0]["captured_at"].endswith(("Z", "+00:00"))  # naive UTC 补时区，前端按本地解析不偏 8h
    assert data[1]["followers_count"] == 1000


def test_stat_snapshots_limit_and_404(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    repo = AccountStatSnapshotRepo(db)
    for i in range(5):
        repo.add(aid, i * 100, 0)
    db.commit()
    db.close()

    assert len(client.get(f"/account/{aid}/stat-snapshots?limit=3").json()) == 3
    # limit 超上限被 Query 约束拒绝（422）
    assert client.get(f"/account/{aid}/stat-snapshots?limit=99999").status_code == 422
    # 账号不存在 → 404
    assert client.get("/account/99999/stat-snapshots").status_code == 404


# ── 直播场次端点（v0.9.x 内容管道 M1） ───────────────────────────────

def test_live_sessions_endpoint_merged(client):
    vid = client.post("/vtuber", json={"name": "测试", "birthday": "09-07"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    repo = AccountStatSnapshotRepo(db)
    repo.add(aid, 1000, 1, "杂谈回", captured_at=datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc))
    repo.add(aid, 1000, 0, None, captured_at=datetime(2026, 9, 7, 13, 0, tzinfo=timezone.utc))
    # danmakus 表内场次（同窗口，live_id 匹配）
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-a",
                       title="深夜杂谈", start_at=datetime(2026, 9, 7, 12, 5),
                       end_at=None, area_name="虚拟日常", parent_area_name="虚拟主播",
                       total_income=88.5, max_online_count=777, danmakus_count=66))
    db.commit()
    db.close()

    resp = client.get(f"/account/{aid}/live-sessions")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1                                 # 合并为一场，不双份
    s = data[0]
    assert s["source"] == "danmakus+self"
    assert s["start_at"].endswith(("Z", "+00:00"))
    assert s["end_at"].endswith(("Z", "+00:00"))          # 快照补 end
    assert s["duration_minutes"] == 55
    assert s["live_title"] == "深夜杂谈"
    assert s["area_name"] == "虚拟日常"
    assert s["total_income"] == 88.5
    assert s["max_online_count"] == 777
    assert s["category"] == "chat"                        # 标题「深夜杂谈」→ 杂谈
    assert s["category_from"] == "title"
    # 账号不存在 → 404
    assert client.get("/account/99999/live-sessions").status_code == 404


# ── 直播分类校正（v0.9.x 类型引擎 v2 第⑦信号） ─────────────────────

def test_live_category_override_flow(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-a",
                       title="深夜杂谈", start_at=datetime(2026, 9, 7, 12, 5),
                       end_at=None, area_name="虚拟日常", parent_area_name="虚拟主播"))
    # 系列传播：同骨架「晚上好」×2（无标题信号）
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-b",
                       title="晚上好", start_at=datetime(2026, 9, 8, 20, 0),
                       end_at=None, area_name="虚拟日常", parent_area_name="虚拟主播"))
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-c",
                       title="晚上好", start_at=datetime(2026, 9, 9, 20, 0),
                       end_at=None, area_name="虚拟日常", parent_area_name="虚拟主播"))
    db.commit()
    db.close()

    # 校正 → override 源生效（并立即反哺系列投票）
    resp = client.put(f"/account/{aid}/live-sessions/uuid-a/category",
                      json={"category": "game"})
    assert resp.status_code == 200
    assert resp.json()["category_from"] == "override"
    resp = client.put(f"/account/{aid}/live-sessions/uuid-b/category",
                      json={"category": "watch"})
    assert resp.status_code == 200

    data = client.get(f"/account/{aid}/live-sessions").json()
    by_live = {s["live_id"]: s for s in data}
    assert by_live["uuid-a"]["category"] == "game"
    assert by_live["uuid-a"]["category_from"] == "override"
    # 同系列其他场次随校正传播（series 源）
    assert by_live["uuid-b"]["category_from"] == "override"
    assert by_live["uuid-c"]["category"] == "watch"
    assert by_live["uuid-c"]["category_from"] == "series"

    # 非法分类 → 422（不含 live 兜底）
    assert client.put(f"/account/{aid}/live-sessions/uuid-a/category",
                      json={"category": "nope"}).status_code == 422
    assert client.put(f"/account/{aid}/live-sessions/uuid-a/category",
                      json={"category": "live"}).status_code == 422

    # 撤除 → 恢复自动推断
    assert client.delete(f"/account/{aid}/live-sessions/uuid-a/category").status_code == 204
    data = client.get(f"/account/{aid}/live-sessions").json()
    by_live = {s["live_id"]: s for s in data}
    assert by_live["uuid-a"]["category"] == "chat"        # 标题「深夜杂谈」→ 杂谈
    assert by_live["uuid-a"]["category_from"] == "title"

    # 账号不存在 → 404；撤除无记录 → 404
    assert client.put("/account/99999/live-sessions/x/category",
                      json={"category": "game"}).status_code == 404
    assert client.delete(f"/account/{aid}/live-sessions/uuid-a/category").status_code == 404


# ── 单场次详情（点击日期格 → 独立弹窗） ──
#
# 2026-09-13（devlog/063）：上游取数（弹幕词云 / 场次指标 / 直播动态）已从详情端点
# 拆到 `…/upstream`。详情端点**不得**发起任何第三方请求 —— 否则上游慢会把整个弹窗
# （含只依赖本地库的时间/分区/收益/分类）一起拖住，最坏 3×30s 重试 ≈ 93s 才出结果。

_DETAIL_SUMMARY = {
    "total": 39316, "danmakus_count": 17931,
    "word_cloud": [("好耶", 3195), ("MELODY", 210)],
    "watch_count": 16216, "like_count": 163579, "pay_count": 542,
    "interaction_count": 1127, "online_rank": 250, "comment_count": 0,
    "is_full": True, "is_merged": True,
    "peaks": [{"ts": 1788609992428, "count": 366}],
    "versions": [{"user_name": "本站", "is_official": True}],
    "channel": {"fans_count": 133596},
}
_DETAIL_EVENTS = [{"type": 7, "send_date_ms": 1788628090562}]
_UNSET = object()


def _mk_detail_sessions(client) -> tuple[int, int]:
    """一个 danmakus 场次 + 一个纯 feed 场次（后者不该触发任何上游请求）。"""
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]
    db = TestingSession()
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-a",
                       title="深夜杂谈", start_at=datetime(2026, 9, 7, 12, 5),
                       end_at=datetime(2026, 9, 7, 13, 0),
                       area_name="虚拟日常", parent_area_name="虚拟主播",
                       total_income=88.5, max_online_count=777, danmakus_count=66))
    db.add(LiveSession(account_id=aid, source="feed", live_id="feed-1",
                       title="无限流游戏", start_at=datetime(2026, 9, 8, 20, 0),
                       end_at=None, area_name="主机游戏", parent_area_name="单机游戏"))
    db.commit()
    db.close()
    return vid, aid


def _patch_upstream(monkeypatch, summary=_UNSET, events=_UNSET) -> list[tuple]:
    """把 `/upstream` 背后的两个上游调用换成桩，返回调用记录（用于断言"打了几次"）。

    ⚠️ 必须清 `live_upstream` 的进程内缓存：不清会把上一支用例的结果带进来。
    """
    from app.services import live_upstream
    live_upstream.clear_cache()
    calls: list[tuple] = []
    sm = _DETAIL_SUMMARY if summary is _UNSET else summary
    ev = _DETAIL_EVENTS if events is _UNSET else events

    async def fake_summary(live_id: str):
        calls.append(("summary", live_id))
        return sm

    async def fake_events(live_id: str):
        calls.append(("events", live_id))
        return ev

    monkeypatch.setattr(live_upstream, "fetch_live_summary", fake_summary)
    monkeypatch.setattr(live_upstream, "fetch_live_events", fake_events)
    return calls


def test_live_session_detail_endpoint(client, monkeypatch):
    """详情只回本地库能推导的内容（含分类推断），且**一次上游请求都不发**。"""
    _vid, aid = _mk_detail_sessions(client)
    calls = _patch_upstream(monkeypatch)

    resp = client.get(f"/account/{aid}/live-sessions/uuid-a")
    assert resp.status_code == 200
    d = resp.json()
    assert d["live_id"] == "uuid-a"
    assert d["live_title"] == "深夜杂谈"
    assert d["duration_minutes"] == 55
    assert d["category"] == "chat"
    assert d["category_from"] == "title"
    assert d["segment_count"] == 1
    # analysis 仍为预留（内容分析服务未接入）
    assert d["analysis"] is None
    # 上游那三样已拆到 /upstream —— 若它们又出现在详情响应里，说明被挂回去了
    assert "danmaku" not in d and "metrics" not in d and "events" not in d
    assert calls == []                      # 详情端点不得打第三方

    # 未收录 live_id → 404；账号不存在 → 404
    assert client.get(f"/account/{aid}/live-sessions/nope").status_code == 404
    assert client.get("/account/99999/live-sessions/uuid-a").status_code == 404


def test_live_session_upstream_endpoint(client, monkeypatch):
    """/upstream：弹幕词云 + 场次指标 + 直播动态；第二次走进程内缓存，不再打上游。"""
    _vid, aid = _mk_detail_sessions(client)
    calls = _patch_upstream(monkeypatch)

    d = client.get(f"/account/{aid}/live-sessions/uuid-a/upstream").json()
    # 词云：词云 top 词按次数降序 + 带次数词条。
    # ⚠️ 这里刻意**不给桩填 `status`** —— 端点契约是"以实际拿到的词条为准"，
    # 所以有词云就必须报 upstream（曾经盲信 summary["status"] 而报出
    # `source='upstream'` + `wc_status='upstream_absent'` 的矛盾组合）。
    assert d["danmaku"] == {"total": 39316,
                            "top_keywords": ["好耶", "MELODY"],
                            "top_words": [{"text": "好耶", "count": 3195},
                                          {"text": "MELODY", "count": 210}],
                            "hot_segments": [],
                            "source": "upstream",
                            "wc_status": "upstream",
                            "text_count": None,
                            "engine": None}
    m = d["metrics"]
    assert m["watch_count"] == 16216 and m["like_count"] == 163579
    assert m["pay_count"] == 542 and m["interaction_count"] == 1127
    assert m["peaks"] == [{"ts": 1788609992428, "count": 366}]
    assert [e["type"] for e in d["events"]] == [7]
    assert d["events"][0]["send_date"].startswith("2026-09-05T17:08:10")  # naive UTC
    assert sorted(c[0] for c in calls) == ["events", "summary"]
    assert {c[1] for c in calls} == {"uuid-a"}      # 按对外 live_id 取数

    d2 = client.get(f"/account/{aid}/live-sessions/uuid-a/upstream").json()
    assert d2["danmaku"] == d["danmaku"] and d2["metrics"] == m
    assert len(calls) == 2                          # 缓存命中：没有新增上游请求


def test_live_session_upstream_reports_fetch_failed(client, monkeypatch):
    """上游没拿到 → `fetch_failed`（"没拉到"），**不能**报成"本场没弹幕"；且失败不写缓存。"""
    _vid, aid = _mk_detail_sessions(client)
    calls = _patch_upstream(monkeypatch, summary=None, events=[])

    d = client.get(f"/account/{aid}/live-sessions/uuid-a/upstream").json()
    assert d["danmaku"]["wc_status"] == "fetch_failed"
    assert d["danmaku"]["top_words"] == []
    assert d["metrics"] is None and d["events"] == []

    client.get(f"/account/{aid}/live-sessions/uuid-a/upstream")
    assert len(calls) == 4                          # 失败不缓存：重试要真的重试


def test_live_session_upstream_skips_non_danmakus(client, monkeypatch):
    """纯 feed 场次：上游无从查起 → `no_danmaku`，且不打网络。"""
    _vid, aid = _mk_detail_sessions(client)
    calls = _patch_upstream(monkeypatch)

    d = client.get(f"/account/{aid}/live-sessions/feed-1/upstream").json()
    assert d["danmaku"]["wc_status"] == "no_danmaku"
    assert d["danmaku"]["source"] is None
    assert d["metrics"] is None and d["events"] == []
    assert calls == []


def test_live_session_upstream_404s(client):
    _vid, aid = _mk_detail_sessions(client)
    assert client.get(f"/account/{aid}/live-sessions/nope/upstream").status_code == 404
    assert client.get("/account/99999/live-sessions/uuid-a/upstream").status_code == 404


# ── 词云自建端点（2026-09-13，devlog/061：上游 extra.wordCloud 断供后的方案 a） ──

def _mk_session_for_cloud(client) -> tuple[int, int]:
    vid = client.post("/vtuber", json={"name": "词云"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "555"},
    ).json()["id"]
    db = TestingSession()
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-wc",
                       title="发布会", start_at=datetime(2026, 9, 9, 12, 0),
                       end_at=datetime(2026, 9, 9, 14, 0)))
    db.add(LiveSession(account_id=aid, source="feed", live_id="feed-wc",
                       title="纯 feed 场次", start_at=datetime(2026, 9, 10, 12, 0)))
    db.commit()
    db.close()
    return vid, aid


def test_wordcloud_endpoint_self_builds(client, monkeypatch):
    """点按钮才拉：端点返回自建词云，并如实标注来源与统计口径。"""
    _vid, aid = _mk_session_for_cloud(client)

    async def fake_records(live_id: str, max_records: int = 0):
        assert live_id == "uuid-wc"           # 必须按对外 live_id 去拉
        return [{"payload": {"rawText": "苹果 苹果"}},
                {"payload": {"rawText": "苹果 华为"}},
                {"payload": {"rawText": "华为 华为"}},
                {"payload": None},             # 无文本记录
                {"payload": {"roomEmojiId": 1}}]

    monkeypatch.setattr("app.services.danmaku_cloud.fetch_raw_danmakus", fake_records)
    from app.services.danmaku_cloud import clear_cache
    clear_cache()

    d = client.get(f"/account/{aid}/live-sessions/uuid-wc/wordcloud").json()
    assert d["wc_status"] == "self_built"
    assert d["source"] == "self"
    assert d["total"] == 5                     # 原始记录条数（含无文本的）
    assert d["text_count"] == 3                # 参与统计的文本弹幕数
    assert d["engine"] == "jieba"
    words = {w["text"]: w["count"] for w in d["top_words"]}
    assert words["苹果"] == 3 and words["华为"] == 3
    assert d["top_keywords"] and set(d["top_keywords"]) == set(words)


def test_wordcloud_endpoint_passes_vtuber_words_to_tokenizer(client, monkeypatch):
    """接线（2026-09-13）：端点要把 **V 名 / 企划 / 昵称** 作为自定义词典传给分词层。

    这是"扩展点 2"真正被用上的那一环 —— 只实现 `build_extra_words` 而不接线，
    主播名照样会被 jieba 切碎（实测"喵喵机长"→`机长`）。所以在这里断死 kwargs。
    """
    vid = client.post("/vtuber", json={"name": "喵喵机长", "faction": "VirtuaReal"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "888"},
    ).json()["id"]
    db = TestingSession()
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-extra",
                       title="测试场", start_at=datetime(2026, 9, 11, 12, 0)))
    db.commit()
    db.close()

    seen: dict = {}

    async def fake_records(live_id: str, max_records: int = 0):
        return [{"payload": {"rawText": "喵喵机长真棒"}}]

    def fake_count(texts, **kw):
        seen["extra_words"] = kw.get("extra_words")
        return [("喵喵机长", 3)]

    monkeypatch.setattr("app.services.danmaku_cloud.fetch_raw_danmakus", fake_records)
    monkeypatch.setattr("app.services.danmaku_cloud.count_tokens", fake_count)
    from app.services.danmaku_cloud import clear_cache
    clear_cache()

    d = client.get(f"/account/{aid}/live-sessions/uuid-extra/wordcloud").json()
    assert d["wc_status"] == "self_built"
    assert set(seen["extra_words"]) == {"喵喵机长", "VirtuaReal"}
    # 顺序被服务层规范化成"去重 + 排序"——**这是缓存键稳定性要求的**（同一批词必须
    # 落到同一个缓存键，否则改一次昵称就换一份缓存）
    assert seen["extra_words"] == sorted(seen["extra_words"])
    assert d["top_words"] == [{"text": "喵喵机长", "count": 3}]


def test_wordcloud_endpoint_reports_no_danmaku(client, monkeypatch):
    """成功拉到记录但全是礼物/进场 → no_danmaku（与"拉取失败"区分）。"""
    _vid, aid = _mk_session_for_cloud(client)

    async def only_gifts(live_id: str, max_records: int = 0):
        return [{"payload": None}, {"payload": {"name": "礼物", "count": 1}}]

    monkeypatch.setattr("app.services.danmaku_cloud.fetch_raw_danmakus", only_gifts)
    from app.services.danmaku_cloud import clear_cache
    clear_cache()

    d = client.get(f"/account/{aid}/live-sessions/uuid-wc/wordcloud").json()
    assert d["wc_status"] == "no_danmaku"
    assert d["top_words"] == [] and d["source"] is None


def test_wordcloud_endpoint_reports_fetch_failed(client, monkeypatch):
    """上游不可达 → fetch_failed（前端据此给「重试」而不是「自建」）。"""
    _vid, aid = _mk_session_for_cloud(client)

    async def boom(live_id: str, max_records: int = 0):
        return None

    monkeypatch.setattr("app.services.danmaku_cloud.fetch_raw_danmakus", boom)

    d = client.get(f"/account/{aid}/live-sessions/uuid-wc/wordcloud").json()
    assert d["wc_status"] == "fetch_failed"
    assert d["top_words"] == []


def test_wordcloud_endpoint_rejects_non_danmakus_session(client, monkeypatch):
    """纯 feed 场次（live_id 是 B 站数字 id）没有可拉弹幕 → no_danmaku，且不打网络。"""
    _vid, aid = _mk_session_for_cloud(client)

    async def should_not_be_called(live_id: str, max_records: int = 0):
        raise AssertionError("非 danmakus 来源不应发起弹幕请求")

    monkeypatch.setattr("app.services.danmaku_cloud.fetch_raw_danmakus",
                        should_not_be_called)

    d = client.get(f"/account/{aid}/live-sessions/feed-wc/wordcloud").json()
    assert d["wc_status"] == "no_danmaku"
    assert d["source"] is None


def test_wordcloud_endpoint_404s(client):
    vid = client.post("/vtuber", json={"name": "404"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "777"},
    ).json()["id"]
    assert client.get(f"/account/{aid}/live-sessions/nope/wordcloud").status_code == 404
    assert client.get("/account/999999/live-sessions/x/wordcloud").status_code == 404
