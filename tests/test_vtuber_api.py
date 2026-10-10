import atexit
import json
import shutil
import tempfile

import pytest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

# 独立测试库，避免污染开发数据库。
#
# ⚠️ **路径必须是"每个进程独有"的临时目录，不能是仓库里的固定文件名**
#    （2026-09-25 修；原先写 `sqlite:///./test_vtuber.db`）：
#      · 两个 pytest 进程**同时跑**会互相 `create_all` / `drop_all` 同一张库 ——
#        实测报 `sqlite3.OperationalError: no such table: live_sessions`，
#        而且**两次的失败清单还不一样**（并发污染的特征）；
#      · 那个文件名还会在**仓库根**堆出一个 119 MB 的 `test_vtuber.db`。
#    `tempfile.mkdtemp()` 每个进程一个目录 + `atexit` 清理 ⇒ 两个毛病一起没了。
#    （这条修好之后，`DEV-LOOP.md` 里"门禁不能并发跑"那条规矩**整条退役**——
#      把规矩修成代码，比留着一条要人记的规矩便宜。）
_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-vtuber-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)

test_engine = create_engine(f"sqlite:///{(_TMPDIR / 'test_vtuber.db').as_posix()}",
                            connect_args={"check_same_thread": False})


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
from app.repositories.vtuber_repo import AccountStatSnapshotRepo, LiveSessionRepo


def override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(autouse=True)
def _scheduler_uses_the_test_db(monkeypatch):
    """**把后台任务的会话也钉到测试库**（2026-09-25，CI 首跑抓到的真问题）。

    `app.dependency_overrides[get_db]` 只覆盖**路由**的依赖注入；而抓取类端点在后台跑时，
    `app/services/scheduler.py` 用的是**它自己 import 的 `SessionLocal`**
    （`scheduler.py:20` 的 `from app.core.database import SessionLocal`）
    ⇒ 那些会话连的是 `settings.DATA_DIR/vtuber.db`，也就是**真实数据目录**。

    症状（CI 首次真跑，两个 Python 版本 + Windows 三处一起红）：
        raise OperationalError: no such table: accounts
    而**本地一直是绿的** —— 因为开发机上的 `vtuber.db` 恰好有 `accounts` 表。
    这正是本仓反复记过的"本地残留环境恰好满足条件"（`docs/DEV-LOOP.md 不变量 21），
    只是这次残留的不是"登录态"而是"库里有表"。

    修法：把 `scheduler.SessionLocal` 也指到测试引擎。改了之后这些端点在**空数据目录**
    下的行为才等于 CI 的行为 —— 也就是"用户第一次装"的行为。
    """
    from app.services import scheduler as _sch
    monkeypatch.setattr(_sch, "SessionLocal", TestingSession)


def test_scheduler_sessions_never_point_at_the_real_data_dir():
    """**回归**：后台任务的会话不许指向真实数据目录（2026-09-25，CI 首跑抓到）。

    这是上面那条 autouse 夹具自身的守卫。手法：**在夹具已生效的上下文里**读
    `scheduler.SessionLocal` 实际绑在哪个引擎上，与 `app.core.database` 的引擎对比。

    ⚠️ 第一版写成"直接调用夹具体再断言"，跑出来是红的 —— 因为 monkeypatch 在**夹具函数返回**
    时就回滚了（teardown 由 pytest 管）。这个坑本身说明"机器判据"也会写错，
    所以下面只在**已生效**的状态上断言，不自己去触发它。

    判据为什么用"引擎 URL"而不是"跑一遍抓取再断言"：后者要打网络、还依赖库里恰好有什么，
    属于**凭据型**判据（`DEV-LOOP` §6.3 的"跳过等于把断言删了"）。URL 一眼可判，
    而且正好是这次踩的那个点：`settings.DATA_DIR/vtuber.db` 与测试库是**两个引擎**。
    """
    from app.core import database as _db
    from app.services import scheduler as _sch

    bound = str(_sch.SessionLocal.kw["bind"].url)
    assert "ddtoolkit-test-vtuber-" in bound, f"后台会话没被钉到测试库：{bound}"
    assert "test_vtuber.db" in bound
    assert bound != str(_db.engine.url), "后台会话仍指向 app.core.database 的引擎（= 真实数据目录）"


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
def client(monkeypatch):
    """测试客户端：**默认把「建账号后自动抓取」挡掉**（2026-09-25，CI 首跑抓到的真问题）。

    `POST /vtuber/{id}/accounts` 会 `background.add_task(_adopt_background, …)` ——
    也就是**真的去打 B 站/微博**并写库。这在测试里有三种坏结果，而且都不报错、只是"有时不对"：
      · **竞态**：后台任务与本用例的断言抢同一张表。实测
        `test_list_account_stat_snapshots` 手工塞 2 条快照、断言 `len(data) == 2`，
        而后台抓取会**再插一条** ⇒ 变成 3；
      · **覆盖数据**：抓到真昵称会**覆盖**用例手工设的值。实测
        `test_wordcloud_endpoint_passes_vtuber_words_to_tokenizer` 断言的 `extra_words`
        里因此多出一个真昵称（它期望恰好 `{名字, 企划}`）；
      · **打真网络**：慢（本文件从 14s 涨到 74s），而且在没网的环境里行为不同。

    ⚠️ 为什么以前没暴露：那时后台任务的会话连的是**开发库**（另一条 bug，见上面那个夹具），
    于是它在本机"默默地失败"或写到别处去了。修好那条之后，这里必须一起收口 ——
    否则测试的行为取决于"开发库里恰好有什么"和"上游此刻返回什么"。

    需要真跑后台的用例**显式覆盖**它（本文件里 `noop_background` 的既有写法：
    `monkeypatch.setattr(router_mod, "_adopt_background", fake)`）。
    """
    import app.routers.vtuber as _router_mod

    async def _noop_background(*_a, **_kw):
        return None

    monkeypatch.setattr(_router_mod, "_adopt_background", _noop_background)
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


def test_capabilities_endpoint_reports_limits(monkeypatch, client):
    """`GET /capabilities`（devlog/086）：未登录态下如实报出受限项与原因。"""
    import app.services.capabilities as cap
    from app.services.auth import auth_manager

    monkeypatch.setattr(auth_manager, "sessdata", "")
    monkeypatch.setattr(auth_manager, "bili_jct", "")
    r = client.get("/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert body["bilibili_logged_in"] is False
    assert body["measured_at"], "矩阵必须带实测日期（平台策略会变）"
    limited = {x["id"]: x for x in body["limited"]}
    assert "fetch_posts" in limited and limited["fetch_posts"]["state"] == cap.REQUIRES_LOGIN
    assert "登录" in limited["fetch_posts"]["note"]
    # 未登录**不该**限制本地浏览（那是零上游的）
    assert "browse_local" not in limited
    # 每项都带三态与说明，前端直接可用
    for row in body["features"]:
        assert row["state"] in cap.STATES and row["note"]


def test_content_fetch_endpoints_refuse_without_login(monkeypatch, client):
    """未登录时**内容类**端点一律 403 + 原因（不发无谓请求；devlog/086）。

    实测依据：匿名打 B 站空间接口回 `412 request was banned`（IP 级、会持续），
    "试了再失败"既白耗配额又让用户困惑，所以在入口就挡。
    """
    from app.services.auth import auth_manager

    monkeypatch.setattr(auth_manager, "sessdata", "")
    monkeypatch.setattr(auth_manager, "bili_jct", "")

    calls = [
        ("post", "/vtuber/fetch-posts?name=x", None),
        ("post", "/vtuber/fetch-all-posts", None),
        ("post", "/vtuber/update-posts", None),
        ("post", "/vtuber/batch/fetch-all-posts", None),
        ("post", "/vtuber/batch/update-unarchived", None),
    ]
    for method, url, payload in calls:
        r = client.request(method, url, json=payload)
        assert r.status_code == 403, f"{url} 未登录时应 403，实得 {r.status_code}"
        detail = r.json()["detail"]
        assert "登录" in detail and ("412" in detail or "风控" in detail), \
            f"{url} 的拒绝原因要讲清楚，实得：{detail}"


def test_account_info_endpoints_stay_available_without_login(monkeypatch, client):
    """未登录**不该**挡账号信息类端点（实测匿名可用，只有内容接口被平台封）。"""
    from app.services.auth import auth_manager

    monkeypatch.setattr(auth_manager, "sessdata", "")
    monkeypatch.setattr(auth_manager, "bili_jct", "")

    vid = client.post("/vtuber", json={"name": "匿名可读V"}).json()["id"]
    r = client.post(f"/vtuber/{vid}/accounts",
                    json={"platform": "bilibili", "platform_uid": "123"})
    assert r.status_code == 201, "建账号不该被登录态拦住"
    # /vtuber/{id}/fetch 走账号信息（匿名可用）→ 不该 403
    r2 = client.post(f"/vtuber/{vid}/fetch")
    assert r2.status_code != 403, "账号信息抓取匿名可用，不该 403"


def test_future_reservations_endpoint_contract(client):
    """`GET /vtuber/{id}/future-reservations`（R13 起前端日历依赖它）。

    仓库层已有 6 条解析用例（`test_vtuber_events.py`），但**路由契约**没有——
    前端要的是：标题已去掉「直播预约|」前缀、时刻已解析成 naive wall-clock、
    预约人数可空、未知 V 给 404（前端据此不渲染预约块）。
    """
    import json as _json
    from datetime import datetime, timedelta

    vid = client.post("/vtuber", json={"name": "预约契约V"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts",
                json={"platform": "bilibili", "platform_uid": "778899"})
    start = datetime.now() + timedelta(days=1)
    db = TestingSession()
    try:
        db.add(Post(
            platform="bilibili", platform_uid="778899", platform_post_id="RESV-1",
            type="text", published_at=datetime.now(),
            body_json=_json.dumps({"reservation": {
                "button_text": "预约", "title": "直播预约|明晚歌回",
                "desc1": start.strftime("%Y-%m-%d %H:%M 直播"),
                "reserve_total": 42, "rid": "21452505",
            }}),
        ))
        db.commit()
    finally:
        db.close()

    rows = client.get(f"/vtuber/{vid}/future-reservations").json()
    assert len(rows) == 1, f"应解析出 1 条未来预约，实得 {rows}"
    row = rows[0]
    assert row["title"] == "明晚歌回", "「直播预约|」前缀应被规范掉"
    assert row["reserve_total"] == 42
    assert row["rid"] == "21452505"
    # 时刻：naive wall-clock，日期与造的数据一致（**不补时区** —— 前端按本地解析）
    assert row["start_at"].startswith(start.strftime("%Y-%m-%d")), row["start_at"]
    assert "+00:00" not in row["start_at"] and "Z" not in row["start_at"]

    assert client.get("/vtuber/999999/future-reservations").status_code == 404


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


def test_vtuber_order_endpoint_full_and_subset(client):
    """需求 4/5（f010，`devlog/413`）：左栏拖拽重排落库 —— **给全量**与**给一部分**都走同一条路。

    ⚠️ 这里钉的是本批唯一需要想清楚的口径（用户 2026-10-07 拍板）：
    **筛选下拖动只换可见那几条的相对位置，没显示的原地不动** ——
    即"把传进来的 id 按新顺序**填回它们原本占的那些位置**"。
    拿账号那套"未列出的排在其后"来做，第 ② 段会红（那正是它要防的）。
    """
    ids = [client.post("/vtuber", json={"name": f"排序V{i}"}).json()["id"]
           for i in range(5)]
    assert [v["id"] for v in client.get("/vtuber/list").json()] == ids

    # ① 全量：按新顺序整体重排
    r = client.put("/vtuber-order",
                   json={"vtuber_ids": [ids[4], ids[0], ids[2], ids[1], ids[3]]})
    assert r.status_code == 200
    assert [v["id"] for v in r.json()] == [ids[4], ids[0], ids[2], ids[1], ids[3]]
    assert [v["sort_order"] for v in r.json()] == [0, 1, 2, 3, 4]

    # ② ★ 子集（= 带筛选拖动）：只动 ids[1..3]（它们原本占第 3/4/5 位），
    #    ids[4] 与 ids[0] 必须**原地不动**
    r = client.put("/vtuber-order", json={"vtuber_ids": [ids[3], ids[1], ids[2]]})
    assert r.status_code == 200
    got = [v["id"] for v in r.json()]
    assert got == [ids[4], ids[0], ids[3], ids[1], ids[2]], \
        "没传进来的必须原地不动 —— 这一条就是「筛选下拖动」的口径（推到队尾就错了）"
    assert [v["id"] for v in client.get("/vtuber/list").json()] == got


def test_vtuber_order_rejects_bad_payload(client):
    """重复 id / 不存在的 id ⇒ 400：这是一次**口径错误**的提交，不猜语义静默乱序。"""
    ids = [client.post("/vtuber", json={"name": f"坏序V{i}"}).json()["id"] for i in range(2)]
    assert client.put("/vtuber-order",
                      json={"vtuber_ids": [ids[0], ids[0]]}).status_code == 400
    assert client.put("/vtuber-order",
                      json={"vtuber_ids": [ids[0], 999999]}).status_code == 400
    # ⚠️ 空数组**合法**：带筛选且筛完为空时前端不该为此报错（什么都不动）
    assert client.put("/vtuber-order", json={"vtuber_ids": []}).status_code == 200


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

    # 内容抓取要过登录闸门（未登录 → 403，见 devlog/086）。本用例只管端点契约，
    # 所以显式声明"已登录" —— 别依赖开发机上恰好有凭据（2026-09-16 实测踩到）。
    monkeypatch.setattr(vrouter.capabilities, "content_fetch_allowed", lambda platform="bilibili": (True, ""))

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


# ── 手动记录场次（B2，devlog/454：需求 2 / 2.1） ─────────────────────

_VOD = "https://www.bilibili.com/video/BV1xx411c7mD"


def _mk_vtuber_account(client, uid="123"):
    vid = client.post("/vtuber", json={"name": "测试", "birthday": "09-07"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": uid}).json()["id"]
    return vid, aid


def _add_row(aid, live_id="uuid-a", *, source="danmakus", title="深夜杂谈",
             start=datetime(2026, 10, 8, 12, 0), end=datetime(2026, 10, 8, 14, 0),
             **kw):
    """直接塞一条表内场次（naive UTC，与库内口径一致）。"""
    db = TestingSession()
    db.add(LiveSession(account_id=aid, source=source, live_id=live_id, title=title,
                       start_at=start, end_at=end, **kw))
    db.commit()
    db.close()


def test_manual_live_session_create_and_list(client):
    """① 手动补一场：进日历列表、带 `manual` 标记、录播地址是**规范形态**、时间是 UTC。"""
    _, aid = _mk_vtuber_account(client)
    resp = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T20:30:00+08:00",
        "end_at": "2026-10-08T22:00:00+08:00",
        "title": " 深夜歌回 ",
        "vod_url": "BV1xx411c7mD",
    })
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["source"] == "manual" and d["manual"] is True
    assert d["live_id"].startswith("manual-")
    assert d["live_title"] == "深夜歌回"                      # 首尾空白清掉
    assert d["vod_url"] == _VOD                               # 裸 BV 号 → 可点开的外链
    assert d["start_at"].startswith("2026-10-08T12:30:00")    # +08:00 → UTC
    assert d["duration_minutes"] == 90
    assert d["category_from"] != ""                           # 走的是同一条推断链路

    lst = client.get(f"/account/{aid}/live-sessions").json()
    assert len(lst) == 1
    assert lst[0]["manual"] is True and lst[0]["vod_url"] == _VOD
    assert lst[0]["live_id"] == d["live_id"]

    db = TestingSession()
    row = db.query(LiveSession).filter(LiveSession.account_id == aid).one()
    db.close()
    assert row.start_at == datetime(2026, 10, 8, 12, 30)      # 库里是 naive UTC
    assert row.source == "manual" and row.vod_url == _VOD


def test_manual_live_session_conflict_with_existing_row(client):
    """② 表内已有记录占着的时段 → 409，原因里**点名撞上哪一场**，且什么都没写进去。"""
    _, aid = _mk_vtuber_account(client)
    _add_row(aid, "uuid-a", title="深夜杂谈",
             start=datetime(2026, 10, 8, 12, 0), end=datetime(2026, 10, 8, 14, 0))

    resp = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T21:00:00+08:00",       # = 13:00Z，落在 12:00–14:00Z 里
        "end_at": "2026-10-08T23:00:00+08:00",
    })
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "深夜杂谈" in detail and "live_id=uuid-a" in detail
    assert "编辑它" in detail                                  # 说清下一步怎么做

    db = TestingSession()
    assert db.query(LiveSession).filter(LiveSession.account_id == aid).count() == 1
    db.close()

    # 相邻但**不**重叠 → 放行（端点相等才算撞，见 sessions_overlap 的口径）
    ok = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T18:00:00+08:00",       # = 10:00–11:00Z
        "end_at": "2026-10-08T19:00:00+08:00"})
    assert ok.status_code == 201, ok.text


def test_manual_over_self_snapshot_merges_into_one(client):
    """③ 只有 self 快照（本工具观测到）的时段**不算冲突**：手填的那条会与它并成一条。

    这条路径的存在理由：self 场次没有 id，改不了也删不掉 —— 这是"给自动观测到的场次
    补上标题/录播地址"唯一做得到的入口。若把 self 重叠也判成冲突，这件事就做不成了。
    """
    _, aid = _mk_vtuber_account(client)
    db = TestingSession()
    repo = AccountStatSnapshotRepo(db)
    repo.add(aid, 1000, 1, "深夜歌回", captured_at=datetime(2026, 10, 8, 12, 0))
    repo.add(aid, 1000, 0, None, captured_at=datetime(2026, 10, 8, 14, 0))
    db.commit()          # ⚠️ `add` 只 flush 前不 commit（调用方收口）—— 漏了这行快照会被回滚掉
    db.close()

    resp = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T20:00:00+08:00", "end_at": "2026-10-08T22:00:00+08:00",
        "title": "深夜歌回", "vod_url": "BV1xx411c7mD"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["live_id"].startswith("manual-")

    lst = client.get(f"/account/{aid}/live-sessions").json()
    assert len(lst) == 1                                       # 并成一条，日历上不重复
    assert lst[0]["source"] == "manual+self"
    assert lst[0]["manual"] is True and lst[0]["vod_url"] == _VOD
    assert lst[0]["live_title"] == "深夜歌回"


def test_manual_vod_survives_room_merge(client):
    """④ 手动行与自动行**并成一条**时，用户填的录播地址不许被冲掉。

    动机（真会发生的静默数据丢失）：合并的高优分支是 `g.update(_row_dict(row))`，
    而自动行的 `vod_url` 是 None —— 整体替换会把用户手填的地址抹成空。
    这条用 `room` 分支（同 room_id 的双源同场）触发 `_merge_row_into_group`。
    """
    _, aid = _mk_vtuber_account(client)
    r = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T20:00:00+08:00", "end_at": "2026-10-08T22:00:00+08:00",
        "title": "歌回", "vod_url": "BV1xx411c7mD"})
    assert r.status_code == 201, r.text
    db = TestingSession()
    row = db.query(LiveSession).filter(LiveSession.account_id == aid).one()
    row.room_id = "12345"                                      # 手动入口不收 room_id，测试补上
    db.commit()
    LiveSessionRepo(db).upsert_feed(aid, "999", {
        "title": "歌回", "room_id": "12345",
        "start_at": datetime(2026, 10, 8, 12, 5), "end_at": datetime(2026, 10, 8, 14, 0),
        "danmakus_count": 500})
    db.commit()
    db.close()

    lst = client.get(f"/account/{aid}/live-sessions").json()
    assert len(lst) == 1
    assert lst[0]["source"] == "feed+manual"                   # feed 优先级更高（对外 id 用真 id）
    assert lst[0]["manual"] is True
    assert lst[0]["vod_url"] == _VOD                           # ← 反例：None（被合并冲掉）


def test_manual_vod_survives_dup_merge(client):
    """④b 同上，但走 `dup` 分支（时间重叠 + 同标题骨架）——另一处 `g.update(_row_dict)`。"""
    _, aid = _mk_vtuber_account(client)
    r = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T20:00:00+08:00", "end_at": "2026-10-08T22:00:00+08:00",
        "title": "歌回", "vod_url": "BV1xx411c7mD"})
    assert r.status_code == 201, r.text
    db = TestingSession()
    LiveSessionRepo(db).upsert_feed(aid, "999", {
        "title": "歌回",                                  # 同骨架 + 时间重叠 ⇒ dup
        "start_at": datetime(2026, 10, 8, 12, 5), "end_at": datetime(2026, 10, 8, 14, 0),
        "danmakus_count": 500})
    db.commit()
    db.close()

    lst = client.get(f"/account/{aid}/live-sessions").json()
    assert len(lst) == 1 and lst[0]["manual"] is True
    assert lst[0]["vod_url"] == _VOD


def test_update_manual_session_fields(client):
    """⑤ 手动场次可改标题/录播地址、可清空录播；空 body → 422；改到冲突时段 → 409。"""
    _, aid = _mk_vtuber_account(client)
    live_id = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T20:00:00+08:00", "end_at": "2026-10-08T22:00:00+08:00",
        "title": "歌回", "vod_url": "BV1xx411c7mD"}).json()["live_id"]

    d = client.patch(f"/account/{aid}/live-sessions/{live_id}",
                     json={"title": " 改过的标题 ", "vod_url": ""}).json()
    assert d["live_title"] == "改过的标题" and d["vod_url"] is None     # "" = 清空
    assert d["manual"] is True

    db = TestingSession()
    assert db.query(LiveSession).filter(LiveSession.account_id == aid).one().vod_url is None
    db.close()

    assert client.patch(f"/account/{aid}/live-sessions/{live_id}", json={}).status_code == 422
    # 改结束时间：显式 null = 改回"进行中"
    d = client.patch(f"/account/{aid}/live-sessions/{live_id}",
                     json={"end_at": None}).json()
    assert d["end_at"] is None and d["duration_minutes"] is None

    _add_row(aid, "uuid-b", start=datetime(2026, 10, 9, 12, 0),
             end=datetime(2026, 10, 9, 14, 0))
    hit = client.patch(f"/account/{aid}/live-sessions/{live_id}",
                       json={"start_at": "2026-10-09T20:00:00+08:00",
                             "end_at": "2026-10-09T22:00:00+08:00"})
    assert hit.status_code == 409 and "uuid-b" in hit.json()["detail"]


def test_update_auto_row_only_allows_vod(client):
    """⑥ 自动抓来的场次：改标题/时间 → 400（下次同步会被覆盖回去）；补录播地址 → 200。"""
    _, aid = _mk_vtuber_account(client)
    _add_row(aid, "uuid-a")

    bad = client.patch(f"/account/{aid}/live-sessions/uuid-a", json={"title": "我改的"})
    assert bad.status_code == 400 and "只能补录播地址" in bad.json()["detail"]

    ok = client.patch(f"/account/{aid}/live-sessions/uuid-a",
                      json={"vod_url": "https://www.bilibili.com/video/BV1xx411c7mD?p=2"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["vod_url"] == _VOD + "?p=2"
    assert ok.json()["manual"] is False                        # 没变成手动场次

    db = TestingSession()
    assert db.query(LiveSession).filter(LiveSession.account_id == aid).one().vod_url == _VOD + "?p=2"
    db.close()


def test_delete_manual_session(client):
    """⑦ 删除只对手动场次开放，并级联清掉分类校正；自动行 400、虚拟场次 404。"""
    _, aid = _mk_vtuber_account(client)
    live_id = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T20:00:00+08:00", "end_at": "2026-10-08T22:00:00+08:00",
        "title": "歌回"}).json()["live_id"]
    assert client.put(f"/account/{aid}/live-sessions/{live_id}/category",
                      json={"category": "song"}).status_code in (200, 204)

    r = client.delete(f"/account/{aid}/live-sessions/{live_id}")
    assert r.status_code == 200 and r.json() == {"deleted": True, "live_id": live_id}
    assert client.get(f"/account/{aid}/live-sessions").json() == []

    db = TestingSession()
    assert db.query(LiveSession).filter(LiveSession.account_id == aid).count() == 0
    assert db.query(LiveCategoryOverride).filter(
        LiveCategoryOverride.account_id == aid).count() == 0   # 不留悬空校正
    db.close()

    _add_row(aid, "uuid-a")
    assert client.delete(f"/account/{aid}/live-sessions/uuid-a").status_code == 400
    # 虚拟场次（self 推导的）在表里没有行 → 404（不是 500，也不是静默成功）
    assert client.delete(f"/account/{aid}/live-sessions/self-xyz").status_code == 404
    assert client.delete("/account/99999/live-sessions/x").status_code == 404


def test_manual_session_rejects_bad_input(client):
    """⑧ 不合格输入给**一句中文 422**（不是 500，也不是给机器看的结构）。"""
    _, aid = _mk_vtuber_account(client)
    base = {"start_at": "2026-10-08T20:00:00+08:00"}

    bad = client.post(f"/account/{aid}/live-sessions",
                      json={**base, "vod_url": "https://b23.tv/abc123"})
    assert bad.status_code == 422 and "短链" in bad.json()["detail"]

    span = client.post(f"/account/{aid}/live-sessions", json={
        "start_at": "2026-10-08T20:00:00+08:00", "end_at": "2026-10-08T19:00:00+08:00"})
    assert span.status_code == 422 and "结束时间" in span.json()["detail"]

    long_title = client.post(f"/account/{aid}/live-sessions",
                             json={**base, "title": "标" * 81})
    assert long_title.status_code == 422 and "80 字" in long_title.json()["detail"]

    assert client.post("/account/99999/live-sessions", json=base).status_code == 404
    # 什么都没写进去（失败不留半条记录）
    db = TestingSession()
    assert db.query(LiveSession).filter(LiveSession.account_id == aid).count() == 0
    db.close()


def test_manual_naive_datetime_is_read_as_local_wall_clock(client):
    """⑨ 不带偏移的时间（`datetime-local` 的产物）按**本地时区**解释并原样显示回来。

    ⚠️ 本条的强度取决于运行机器的时区：在 UTC 机器上它**恒真**（真空）。
    所以"当成 UTC 存"这个具体错法由 `tests/test_live_manual.py` 里那条
    **注入 +08:00** 的用例杀死（与时区无关）；这里守的是"这条链路确实调了那个函数"。
    """
    _, aid = _mk_vtuber_account(client)
    d = client.post(f"/account/{aid}/live-sessions",
                    json={"start_at": "2026-10-08T20:30", "end_at": "2026-10-08T22:00"}
                    ).json()
    shown = datetime.fromisoformat(d["start_at"]).astimezone()   # 前端就是这样显示的
    assert (shown.year, shown.month, shown.day, shown.hour, shown.minute) == \
        (2026, 10, 8, 20, 30)


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


# ── 弹幕取数的两条新路径：直播中 / 按需现查（2026-10-02，devlog/275）──
#
# 用户口径：「每一场直播详情都能够看到弹幕记录；还在直播中的详情页就显示正在直播中
# 而不是'本场没有可用于统计的文本弹幕记录'」。于是后端多了两条路径：
#   ① 直播中（`end_at` 为空）→ `live`，不出网（danmakus 要等本场结束才收录）；
#   ② 本地只有 feed/self 行且已结束 → **现去 danmakus 查一次**。
# 为什么 ② 必须存在：每日同步会被上游 WAF 拦（302），本地缺行 ≠ 上游没有这一场；
# 实测弥月 09-25 起 11 场全因此缺席，直到手动跑一次同步才补回来。

def _patch_channel(monkeypatch, *, lives=None, reason=None) -> list[str]:
    """把「现查」背后的 channel 拉取换成桩，返回被问到的 uid 列表。"""
    from app.services import live_upstream
    live_upstream.clear_lookup_state()
    calls: list[str] = []

    async def fake(mid, client, *, attempts=2):
        calls.append(str(mid))
        if reason is not None:
            return None, reason
        return {"channel": {}, "lives": list(lives or []), "fansHistory": []}, None

    monkeypatch.setattr("app.services.externals.danmakus.fetch_channel_checked", fake)
    return calls


def _mk_recent_feed_session(client, *, hours_ago: float = 3.0) -> tuple[int, str]:
    """建一个**近期**、已结束、只有 feed 行的场次（按需现查那一路的输入形态）。

    起点用相对时间：现查有 14 天新鲜度闸门（老场次不为它出网），写死日期会随
    时间推移把这条用例从"能查"变成"不查"。
    """
    start = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours_ago)
    vid = client.post("/vtuber", json={"name": "现查"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]
    db = TestingSession()
    db.add(LiveSession(account_id=aid, source="feed", live_id="feed-new",
                       title="刚结束的一场", start_at=start,
                       end_at=start + timedelta(hours=2)))
    db.commit()
    db.close()
    return aid, "feed-new"


def _ms_of(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


def test_live_session_upstream_reports_live_without_network(client, monkeypatch):
    """直播中：报 `live`（"正在直播中"），**不请求任何上游**。

    原先这里显示"本场没有可用于统计的文本弹幕记录" —— 把"还没到时候"说成了"没有"。
    """
    _vid, aid = _mk_detail_sessions(client)          # feed-1 的 end_at 为空 = 直播中
    calls = _patch_upstream(monkeypatch)
    chan = _patch_channel(monkeypatch, lives=[{"liveId": "u-x", "startDate": 1}])

    d = client.get(f"/account/{aid}/live-sessions/feed-1/upstream").json()
    assert d["danmaku"]["wc_status"] == "live"
    assert d["danmaku"]["top_words"] == []
    assert calls == [] and chan == []                # 两条上游路径都不该被碰


def test_live_session_upstream_looks_up_danmakus_on_demand(client, monkeypatch):
    """本地只有 feed 行 → 现去 danmakus 查一次；命中就补库并用 uuid 取上游词云。"""
    aid, live_id = _mk_recent_feed_session(client)
    calls = _patch_upstream(monkeypatch)             # 摘要里有词云
    db = TestingSession()
    start = db.query(LiveSession).filter(LiveSession.live_id == live_id).one().start_at
    db.close()
    chan = _patch_channel(monkeypatch, lives=[{
        "liveId": "uuid-ondemand", "title": "刚结束的一场",
        "startDate": _ms_of(start), "stopDate": _ms_of(start + timedelta(hours=2)),
        "danmakusCount": 42,
    }])

    d = client.get(f"/account/{aid}/live-sessions/{live_id}/upstream").json()
    assert chan == ["123"]                           # 真的按平台 uid 问了上游
    assert d["danmaku"]["wc_status"] == "upstream"   # 补到行之后走正常取数
    assert d["session_changed"] is True              # 前端据此重取详情（弹幕数/收益也变了）
    assert [w["text"] for w in d["danmaku"]["top_words"]] == ["好耶", "MELODY"]
    assert len(calls) == 2                           # 一轮 = 摘要 + 事件
    db = TestingSession()
    row = db.query(LiveSession).filter(LiveSession.live_id == "uuid-ondemand").one()
    assert row.source == "danmakus" and row.danmakus_count == 42
    db.close()


def test_live_session_upstream_no_danmaku_only_after_asking(client, monkeypatch):
    """问过上游、人家确实没有 → `no_danmaku`；且不白取摘要/事件。"""
    aid, live_id = _mk_recent_feed_session(client)
    calls = _patch_upstream(monkeypatch)
    chan = _patch_channel(monkeypatch, lives=[])     # 上游 200，但这一场不在里面

    d = client.get(f"/account/{aid}/live-sessions/{live_id}/upstream").json()
    assert chan == ["123"]
    assert d["danmaku"]["wc_status"] == "no_danmaku"
    assert d["danmaku"]["source"] is None
    assert calls == []


def test_live_session_upstream_lookup_blocked_is_fetch_failed(client, monkeypatch):
    """现查被 WAF 拦 → `fetch_failed`（"没问到"），**不能**说成"上游没有"。"""
    aid, live_id = _mk_recent_feed_session(client)
    calls = _patch_upstream(monkeypatch)
    chan = _patch_channel(monkeypatch, reason="HTTP 302")

    d = client.get(f"/account/{aid}/live-sessions/{live_id}/upstream").json()
    assert chan == ["123"]
    assert d["danmaku"]["wc_status"] == "fetch_failed"
    assert calls == []


def test_live_session_lookup_is_throttled_but_refresh_forces(client, monkeypatch):
    """同账号 10 分钟只现查一次；`?refresh=true`（用户点「查一次」）绕过节流。"""
    aid, live_id = _mk_recent_feed_session(client)
    _patch_upstream(monkeypatch)
    chan = _patch_channel(monkeypatch, lives=[])
    url = f"/account/{aid}/live-sessions/{live_id}/upstream"

    assert client.get(url).json()["danmaku"]["wc_status"] == "no_danmaku"
    assert len(chan) == 1                            # 第一次：问了上游
    assert client.get(url).json()["danmaku"]["wc_status"] == "no_danmaku"
    assert len(chan) == 1                            # 节流：沿用上次结论，不再打上游
    assert client.get(f"{url}?refresh=true").json()["danmaku"]["wc_status"] == "no_danmaku"
    assert len(chan) == 2                            # 显式重试：真的再问一次


def test_live_session_lookup_skips_old_sessions(client, monkeypatch):
    """很久以前的纯 feed 场次：不为它出网（上游早该收录，没有就是没有）。"""
    aid, live_id = _mk_recent_feed_session(client, hours_ago=24 * 40)
    _patch_upstream(monkeypatch)
    chan = _patch_channel(monkeypatch, lives=[])

    d = client.get(f"/account/{aid}/live-sessions/{live_id}/upstream").json()
    assert d["danmaku"]["wc_status"] == "no_danmaku"
    assert chan == []


def test_wordcloud_endpoint_resolves_session_after_on_demand_merge(client, monkeypatch):
    """现查补进 danmakus 行之后，前端手里仍是**旧的 feed id** —— 自建词云要能找回同一场次，
    并且拿**定权后的 uuid** 去拉原始弹幕（danmakus v3 只认自己的 uuid）。

    这条钉的是自己的坑：合并会把对外 id 换成最高优先级源，按需现查又发生在弹窗已经打开
    之后 ⇒ 只按 `live_id` 精确匹配会让「用弹幕自建」404，而界面会把它显示成"拉取失败"。
    """
    aid, live_id = _mk_recent_feed_session(client)
    _patch_upstream(monkeypatch)
    db = TestingSession()
    start = db.query(LiveSession).filter(LiveSession.live_id == live_id).one().start_at
    db.close()
    _patch_channel(monkeypatch, lives=[{
        "liveId": "uuid-ondemand", "title": "刚结束的一场",
        "startDate": _ms_of(start), "stopDate": _ms_of(start + timedelta(hours=2)),
        "danmakusCount": 42,
    }])
    # 先触发一次现查（补进 danmakus 行 ⇒ 合并后对外 id 变成 uuid）
    assert client.get(f"/account/{aid}/live-sessions/{live_id}/upstream").status_code == 200

    seen: list[str] = []

    async def fake_records(lid: str, max_records: int = 0):
        seen.append(lid)
        return [{"payload": {"rawText": "苹果 苹果"}}, {"payload": {"rawText": "苹果 华为"}}]

    monkeypatch.setattr("app.services.danmaku_cloud.fetch_raw_danmakus", fake_records)
    from app.services.danmaku_cloud import clear_cache
    clear_cache()

    # ⚠️ 仍然用**旧的 feed id** 调自建端点（就是弹窗手里那份）
    d = client.get(f"/account/{aid}/live-sessions/{live_id}/wordcloud").json()
    assert seen == ["uuid-ondemand"], "必须用定权后的 uuid 去拉原始弹幕"
    assert d["wc_status"] == "self_built"
    assert d["source"] == "self"


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


# ── B站取流端点（C1+C2，devlog/289/292）────────────────────────────────────────

def _bili_video_post(platform="bilibili", bvid="BV1TEST"):
    """造一条带 `body_json.bvid` 的帖子，返回 post id。"""
    db = TestingSession()
    try:
        p = Post(platform=platform, platform_uid="88001", platform_post_id="P-BV",
                 type="video", published_at=datetime.now(),
                 body_json=json.dumps({"bvid": bvid} if bvid else {}))
        db.add(p)
        db.commit()
        db.refresh(p)
        return p.id
    finally:
        db.close()


@pytest.mark.parametrize("qs,expect", [
    ("", {"qn": None, "durl_fallback": False, "cid": None}),
    ("?qn=80", {"qn": 80, "durl_fallback": False, "cid": None}),
    ("?fallback=true", {"qn": None, "durl_fallback": True, "cid": None}),
    ("?qn=64&fallback=true", {"qn": 64, "durl_fallback": True, "cid": None}),
    # 分P（devlog/329）：`cid` 也必须**原样接到**服务层 —— 漏接的表现是"点了 P2、播的还是 P1"
    ("?cid=222", {"qn": None, "durl_fallback": False, "cid": 222}),
    ("?qn=64&cid=333", {"qn": 64, "durl_fallback": False, "cid": 333}),
])
def test_bili_play_route_forwards_qn_and_fallback(monkeypatch, client, qs, expect):
    """`/bili/play/{id}` 把 `qn` / `fallback` / `cid` **原样接到** `bili_play.play_info` 上。

    为什么这条必须打在**路由层**：`?fallback=true` 曾被漏接 —— 前端发了，路由签名里没这个
    参数，而 **FastAPI 对未知查询参数默认静默忽略** ⇒ 用户点"播不动"后回落重取，取回来的
    还是 DASH。当时的服务层用例直接调 `play_info(durl_fallback=True)`，**绕过了路由**，
    所以全绿（devlog/292）。这一层的价值就是"接线接上了没有"。

    反向验证：把路由签名里的 `fallback`（或 `cid`）参数删掉 ⇒ 对应用例红。
    """
    import app.services.bili_play as play_svc

    seen: dict = {}

    async def _fake(bvid, **kw):
        seen["bvid"] = bvid
        seen.update(kw)
        return {"quality": 80, "accept": [], "dash": {"video": [], "audio": []},
                "durl": [], "expires_in": 120,
                "kernel": "durl" if kw.get("durl_fallback") else "dash"}

    monkeypatch.setattr(play_svc, "play_info", _fake)
    pid = _bili_video_post()

    r = client.get(f"/bili/play/{pid}{qs}")
    assert r.status_code == 200, r.text
    assert seen.get("bvid") == "BV1TEST"
    assert {k: v for k, v in seen.items() if k != "bvid"} == expect, \
        f"{qs or '(无参数)'} 没接到服务上：{seen}"
    assert r.json()["kernel"] == ("durl" if expect.get("durl_fallback") else "dash")


def test_bili_segments_route_forwards_cid(monkeypatch, client):
    """`/bili/segments/{id}` 的 `cid` 也要接到服务层（`devlog/329`）。

    判据挑这里：段表与播放地址**必须是同一条流** —— 段表按 P1 取、地址按 P2 取的话，
    内核会拿着 P1 的字节表去 P2 的文件里取段（现象与 `devlog/327` 那类"取回来落不下"同形）。
    """
    import app.services.bili_play as play_svc
    import app.services.bili_segments as seg_svc

    seen: dict = {}

    async def _fake_play(bvid, **kw):
        seen.update(kw)
        return {"quality": 80, "dash": {"video": [], "audio": []}, "durl": [],
                "expires_in": 120, "kernel": "dash"}

    async def _fake_tables(play):
        return {"video": {"mime": "video/mp4; codecs=\"x\"", "init": {"start": 0, "end": 1},
                          "segments": [], "duration_s": 1, "urls": ["u"]},
                "audio": {"mime": "audio/mp4; codecs=\"x\"", "init": {"start": 0, "end": 1},
                          "segments": [], "duration_s": 1, "urls": ["u"]},
                "duration_s": 1}

    monkeypatch.setattr(play_svc, "play_info", _fake_play)
    monkeypatch.setattr(seg_svc, "stream_tables", _fake_tables)
    pid = _bili_video_post()

    r = client.get(f"/bili/segments/{pid}?qn=64&cid=222")
    assert r.status_code == 200, r.text
    assert seen.get("qn") == 64 and seen.get("cid") == 222, f"cid 没接到服务上：{seen}"


def test_bili_play_route_rejects_non_video_posts(client):
    """非 B站帖 400、没有 bvid 400、帖子不存在 404（**别把三类混成一句"取不到"**）。"""
    assert client.get("/bili/play/999999").status_code == 404
    assert client.get(f"/bili/play/{_bili_video_post(platform='weibo', bvid='BV1')}"
                      ).status_code == 400
    assert client.get(f"/bili/play/{_bili_video_post(bvid='')}").status_code == 400


# ── 打开时重取媒体（批次 3，devlog/320）─────────────────────────────────────

def _install_fake_fetcher(monkeypatch, *, platform="xiaohongshu", enrich=None):
    """把注册表里的平台 fetcher 换成可控替身（判据打在**注册表**这条路上，见 DEV-LOOP §6）。"""
    from app.services.platforms import registry

    class _Fake:
        last_error = None

        async def enrich(self, item, client=None):
            return await enrich(item) if enrich else False

    fake = _Fake()
    monkeypatch.setattr(registry, "get_fetcher", lambda pf: fake if pf == platform else None)
    return fake


def test_refresh_media_route_updates_urls_and_pins(monkeypatch, client):
    """重取成功后：**库里换成新地址** + 顺手固化 + 回包带新的 `images_local`。

    为什么判据要连"库里也换了"一起看：只返回不落库 ⇒ 下次打开还是旧地址；
    只落库不返回 ⇒ 详情页手里那份还是旧的，用户看不到变化。
    """
    import json
    import tempfile
    from pathlib import Path

    from app.routers.vtuber import _refresh_at
    from app.services import assets, capabilities

    _refresh_at.clear()
    monkeypatch.setattr(capabilities, "content_fetch_allowed", lambda pf="x": (True, ""))
    monkeypatch.setattr(assets, "data_root", lambda: Path(tempfile.mkdtemp(prefix="ddtk-rf-")))

    old_img = "https://sns-webpic-qc.xhscdn.com/202610030051/old/notes_pre_post/o!nd_dft.webp"
    new_img = "https://sns-webpic-qc.xhscdn.com/202610041200/new/notes_pre_post/n!nd_dft.webp"

    async def _enrich(item):
        item["body_json"] = json.dumps({"text": "正文", "images": [{"url": new_img}]},
                                       ensure_ascii=False)
        item["cover_url"] = new_img
        # 平台顺手带回来的**非媒体**字段：写回时不许动（列表顺序不因重取而变）
        item["title"] = "重取之后的标题"
        item["published_at"] = datetime(2030, 1, 1)
        return True

    _install_fake_fetcher(monkeypatch, enrich=_enrich)

    # 固化那一步会**真的**去下图（重取拿到的又是限时地址）⇒ 这里换成假客户端，
    # 否则用例的结果取决于外网（图床过期就 403，判据变成"看运气"）。
    class _FakeImgClient:
        def __init__(self):
            self.calls: list[str] = []

        async def get(self, url: str):
            self.calls.append(url)
            return type("R", (), {"status_code": 200, "content": b"IMG"})()

        async def aclose(self) -> None:
            pass

    fake_img = _FakeImgClient()
    import app.core.http as core_http
    monkeypatch.setattr(core_http, "new_async_client", lambda *a, **k: fake_img)

    db = TestingSession()
    try:
        p = Post(platform="xiaohongshu", platform_uid="u-rf", platform_post_id="n1",
                 type="note", title="原标题", published_at=datetime(2026, 10, 3, 12, 0),
                 cover_url=old_img,
                 body_json=json.dumps({"text": "正文", "images": [{"url": old_img}]},
                                      ensure_ascii=False))
        db.add(p)
        db.commit()
        pid = p.id
    finally:
        db.close()

    r = client.post(f"/posts/{pid}/refresh-media")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["pinned"]["images"] == 1
    assert body["post"]["cover_url"] == new_img
    assert new_img in body["post"]["body_json"]
    assert body["post"]["images_local"] and body["post"]["images_local"][0], \
        "重取之后没固化 ⇒ 几小时后又过期，用户下次打开还是灰的"

    db = TestingSession()
    try:
        row = db.query(Post).filter(Post.id == pid).one()
        assert new_img in (row.body_json or ""), "库里没换 ⇒ 下次打开还是灰的"
        assert row.title == "原标题", "重取顺手把标题也改了 —— 列表顺序/显示会莫名其妙地变"
        assert row.published_at == datetime(2026, 10, 3, 12, 0), \
            "重取改了发布时间 ⇒ 列表排序会跳"
    finally:
        db.close()
    # 节流闸门：紧接着再来一次 ⇒ 429（并说明"为什么"）
    r2 = client.post(f"/posts/{pid}/refresh-media")
    assert r2.status_code == 429, r2.text
    assert "秒后再试" in r2.json()["detail"]


def test_refresh_media_gate_knows_xiaohongshu(monkeypatch, client):
    """真实事故（2026-10-04，devlog/320）：小红书帖的重取被闸门当成**未知平台** ⇒ 永远 403。

    真机日志（14:58:16 / 14:58:30）：`前端 [media] 重取媒体失败 post#4992：未知平台：…显式决定
    匿名能不能抓` —— 用户点了两帖，两次都是这句话。

    判据：缺 Cookie ⇒ 403 **且理由照着能做**（说清去哪配、缺哪两个键）；配齐 ⇒ 不再是 403
    （走到平台层，成败由上游决定）。
    """
    from app.routers.vtuber import _refresh_at
    from app.services.xhs_auth import xhs_auth_manager

    _refresh_at.clear()
    db = TestingSession()
    try:
        p = Post(platform="xiaohongshu", platform_uid="u-gate", platform_post_id="g1",
                 type="note", body_json='{"text": "正文", "images": []}')
        db.add(p)
        db.commit()
        pid = p.id
    finally:
        db.close()

    monkeypatch.setattr(xhs_auth_manager, "cookie", "")
    r = client.post(f"/posts/{pid}/refresh-media")
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert "未知平台" not in detail, "又退回那句给开发者看的话了"
    assert "a1" in detail and "设置" in detail, f"拒绝理由要能照着做：{detail}"

    # 配齐 Cookie（a1 + web_session）⇒ 闸门放行；平台层拿到的是假 fetcher，如实 502
    _install_fake_fetcher(monkeypatch, enrich=None)
    monkeypatch.setattr(xhs_auth_manager, "cookie", "a1=1900abcdef; web_session=xyz")
    _refresh_at.clear()
    r2 = client.post(f"/posts/{pid}/refresh-media")
    assert r2.status_code == 502, r2.text
    assert "没能取到新的媒体地址" in r2.json()["detail"]


def test_refresh_media_waits_out_our_own_throttle(monkeypatch, client):
    """撞上**我们自己的令牌桶**时要排队等，而不是立刻 502（`devlog/366`，真机现场）。

    2026-10-06 的真机日志：`前端 [media] 重取媒体失败 post#5100：没能取到新的媒体地址：
    identity_throttled` —— 用户连着点开两条抖音视频，第二条撞上 `aweme_detail` 的
    0.12/s（≈8.3s 一发）⇒ 以前直接失败，而其实**再等几秒就成**；失败还被前端记成
    "这一帖试过了" ⇒ 关掉再打开也不重试，视频就永久废了。

    判据三条：① 说"还需 3s"就等它、再试一次（**第二次成功 ⇒ 200**）；
    ② 上游真出错（风控/网络）**不重试**（只发一次）；③ 等不完（预算用尽）⇒ 502 且
    说清"这是我们自己的限速"，别让用户去查 cookie。
    """
    import asyncio
    import json

    from app.routers import vtuber as vt
    from app.routers.vtuber import _refresh_at
    from app.services import capabilities

    monkeypatch.setattr(capabilities, "content_fetch_allowed", lambda pf="x": (True, ""))

    db = TestingSession()
    try:
        p = Post(platform="douyin", platform_uid="u-thr", platform_post_id="v1",
                 type="video", body_json='{"video": {"url": "https://old/1.mp4"}}')
        db.add(p)
        db.commit()
        pid = p.id
    finally:
        db.close()

    # ① 第一次"没排上"（说还需 1s），第二次成功 ⇒ 端点自己排队，最后 200
    calls = {"n": 0}
    fake = _install_fake_fetcher(monkeypatch, platform="douyin")

    async def _enrich(item):
        calls["n"] += 1
        if calls["n"] == 1:
            fake.last_error = {"kind": "identity_throttled", "retry_after": 0.01,
                               "msg": "本轮没发（自己的节奏：bucket，还需 0.0s）"}
            return False
        fake.last_error = None
        item["body_json"] = json.dumps({"video": {"url": "https://new/2.mp4"}})
        return True

    monkeypatch.setattr(fake, "enrich", _enrich)
    _refresh_at.clear()
    r = client.post(f"/posts/{pid}/refresh-media")
    assert r.status_code == 200, r.text
    assert calls["n"] == 2, "没为重取排队（撞上自己的令牌桶就放弃了）"
    assert "https://new/2.mp4" in r.json()["post"]["body_json"]

    # ② 上游真出错（风控）⇒ 不重试（只发一次，立刻 502）
    calls["n"] = 0
    fake2 = _install_fake_fetcher(monkeypatch, platform="douyin")

    async def _risk(item):
        calls["n"] += 1
        fake2.last_error = {"kind": "risk_control", "msg": "验证码挑战"}
        return False

    monkeypatch.setattr(fake2, "enrich", _risk)
    _refresh_at.clear()
    r2 = client.post(f"/posts/{pid}/refresh-media")
    assert r2.status_code == 502 and calls["n"] == 1, "风控属于「等也没用」，重试只是更慢地失败"

    # ③ 一直排不上 ⇒ 502，且**说清是我们自己的限速**（别让用户去查 cookie/开关）
    fake3 = _install_fake_fetcher(monkeypatch, platform="douyin")

    async def _always(item):
        fake3.last_error = {"kind": "identity_throttled", "retry_after": 99.0,
                            "msg": "本轮没发（自己的节奏：bucket，还需 99.0s）"}
        return False

    monkeypatch.setattr(fake3, "enrich", _always)
    _refresh_at.clear()
    r3 = client.post(f"/posts/{pid}/refresh-media")
    assert r3.status_code == 502, r3.text
    assert "自己的限速" in r3.json()["detail"], r3.json()["detail"]


def test_refresh_media_route_is_honest_about_what_it_cannot_do(monkeypatch, client):
    """三类如实拒绝：帖不存在 **404** / 未登录 **403** / 平台没有详情补全 **409**。"""
    from app.routers.vtuber import _refresh_at
    from app.services import capabilities

    _refresh_at.clear()
    assert client.post("/posts/999999/refresh-media").status_code == 404

    monkeypatch.setattr(capabilities, "content_fetch_allowed",
                        lambda pf="x": (False, "未登录：内容接口需要登录"))
    db = TestingSession()
    try:
        p = Post(platform="xiaohongshu", platform_uid="u-rf2", platform_post_id="n2",
                 type="note", published_at=datetime.now())
        db.add(p)
        db.commit()
        pid = p.id
    finally:
        db.close()
    r = client.post(f"/posts/{pid}/refresh-media")
    assert r.status_code == 403 and "未登录" in r.json()["detail"]

    monkeypatch.setattr(capabilities, "content_fetch_allowed", lambda pf="x": (True, ""))
    _install_fake_fetcher(monkeypatch, platform="bilibili")   # 替身没重写 enrich ⇒ 走基类默认
    db = TestingSession()
    try:
        p2 = Post(platform="bilibili", platform_uid="u-rf3", platform_post_id="BV1",
                  type="video", published_at=datetime.now())
        db.add(p2)
        db.commit()
        pid2 = p2.id
    finally:
        db.close()
    r2 = client.post(f"/posts/{pid2}/refresh-media")
    assert r2.status_code in (409, 502), r2.text
    assert "可重取" in r2.json()["detail"] or "没能取到" in r2.json()["detail"]


# ── B站段表端点（S2，devlog/312）──────────────────────────────────────────────

def test_bili_segments_route_forwards_qn_and_returns_both_tables(monkeypatch, client):
    """`/bili/segments/{id}`：**qn 原样接到取流上**，返回音视频两张表。

    为什么要打在路由层：这一层的价值是"接线接上了没有"（`?fallback` 漏接那次，
    服务层用例全绿而真机上回落取回来的还是 DASH，devlog/292）。
    """
    import app.services.bili_play as play_svc
    import app.services.bili_segments as seg_svc

    seen: dict = {}

    async def _fake_play(bvid, **kw):
        seen["bvid"] = bvid
        seen.update(kw)
        return {"quality": 64, "dash": {"video": [], "audio": []}}

    async def _fake_tables(play, **kw):
        seen["quality_from_play"] = play.get("quality")
        return {"video": {"url": "https://cn-x.bilivideo.com/v.m4s",
                          "mime": 'video/mp4; codecs="avc1"', "init": {"start": 0, "end": 947},
                          "segments": [{"i": 0, "start": 948, "end": 1000, "dur_s": 5.0,
                                        "sap": True}],
                          "duration_s": 5.0, "urls": ["https://cn-x.bilivideo.com/v.m4s"]},
                "audio": {"url": "https://cn-x.bilivideo.com/a.m4s",
                          "mime": 'audio/mp4; codecs="mp4a.40.2"', "init": {"start": 0, "end": 700},
                          "segments": [{"i": 0, "start": 700, "end": 900, "dur_s": 5.1, "sap": True}],
                          "duration_s": 5.1, "urls": ["https://cn-x.bilivideo.com/a.m4s"]},
                "duration_s": 5.1}

    monkeypatch.setattr(play_svc, "play_info", _fake_play)
    monkeypatch.setattr(seg_svc, "stream_tables", _fake_tables)
    pid = _bili_video_post(bvid="BVSEG")

    r = client.get(f"/bili/segments/{pid}?qn=64")
    assert r.status_code == 200, r.text
    body = r.json()
    assert seen == {"bvid": "BVSEG", "qn": 64, "cid": None, "quality_from_play": 64}, \
        f"qn 没原样接到取流上：{seen}"
    assert body["bvid"] == "BVSEG" and body["quality"] == 64
    assert body["video"]["segments"][0]["start"] == 948
    assert body["audio"]["mime"] == 'audio/mp4; codecs="mp4a.40.2"'
    assert body["duration_s"] == 5.1, "两条流时长不同时取**长的**（短的会截尾）"


def test_bili_segments_route_maps_segments_error_to_502(monkeypatch, client):
    """拿不到段表 ⇒ **502 + 如实原因**（前端拿它当"这条路不成立"，静默退渐进式）。"""
    import app.services.bili_play as play_svc
    import app.services.bili_segments as seg_svc

    async def _fake_play(bvid, **kw):
        return {"quality": 80, "dash": {"video": [], "audio": []}}

    async def _no_sidx(play, **kw):
        raise seg_svc.SegmentsError("这条流没有 sidx", kind="no_sidx")

    monkeypatch.setattr(play_svc, "play_info", _fake_play)
    monkeypatch.setattr(seg_svc, "stream_tables", _no_sidx)
    pid = _bili_video_post(bvid="BVNOSIDX")

    r = client.get(f"/bili/segments/{pid}")
    assert r.status_code == 502
    assert "sidx" in r.json()["detail"]


def test_bili_segments_route_rejects_non_video_posts(client):
    """与 `/bili/play` **同一套分类**（两条路由共用 `_bili_bvid_of`，别各写一遍）。"""
    assert client.get("/bili/segments/999999").status_code == 404
    assert client.get(f"/bili/segments/{_bili_video_post(platform='weibo', bvid='BV1')}"
                      ).status_code == 400
    assert client.get(f"/bili/segments/{_bili_video_post(bvid='')}").status_code == 400


# ── 企划归属（需求 6，B3，devlog/457） ────────────────────────────────

def test_adopt_fills_group_from_the_pool_snapshot(client):
    """收录当场就把企划填上（吃**真实快照**里那条带企划的行）。

    ⚠️ 为什么要吃真实数据：造一条假池子的话，"新列没从快照接进来"这种错法照样绿
    （`vtubers.group_name` 一直是 NULL，而断言只看"没报错"）。
    """
    import csv
    from pathlib import Path

    from app.core.config import PROJECT_ROOT

    rows = list(csv.DictReader((Path(PROJECT_ROOT) / "vtubers.csv")
                               .open(newline="", encoding="utf-8")))
    sample = next(r for r in rows if r["group_name"] and r["platform"] == "bilibili")

    r = client.post("/vtuber/adopt", json={"platform": "bilibili",
                                           "platform_uid": sample["platform_uid"],
                                           "source": "pool"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == sample["vtuber_name"]
    assert body["group_name"] == sample["group_name"], "收录时没把企划填上（池内路径手边就有）"
    assert body["group_uuid"] == sample["group_uuid"]

    # 列表端点也要带（左栏徽章读的是它）
    listed = next(v for v in client.get("/vtuber/list").json() if v["id"] == body["id"])
    assert listed["group_name"] == sample["group_name"]


def test_vtuber_without_group_keeps_null(client):
    """没有企划的 V **两个字段都是 null**（界面据此不渲染空壳）。"""
    vid = client.post("/vtuber", json={"name": "无企划"}).json()["id"]
    body = next(v for v in client.get("/vtuber/list").json() if v["id"] == vid)
    assert body["group_name"] is None and body["group_uuid"] is None