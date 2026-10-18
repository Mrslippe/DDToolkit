# -*- coding: utf-8 -*-
"""录播批量填充的三条端点（B3/B4，`docs/plans/vod-autofill.md`）。

判据对着三条**会静默出错**的性质：

① **`vod-scan` 只读**（与 C1 的 `vod-candidates` 同一条纪律）—— 扫描顺手写库的话，
   用户会在"我还没确认"的情况下丢掉"手动补录播"这件事；
② **`vod-apply` 只写传进来的 items**，且**逐条独立**：一条地址不合格不能让别的白写、
   也不能静默吞掉（结果里逐条给原因）；
③ **已有 `vod_url` 的场次既不进匹配、也不进"漏配"列表**（不变量 39 的用户手填字段）。

④ **`vod-clear` 硬清**（2026-10-15 第三版，用户口径「硬性清除所有已匹配项」）：
   只要 `vod_url` 非空就清、不分类；但**不扫描**（纯数据库、一个上游请求都不发）、
   **只清地址不删场次**。回执的 `auto`/`manual`/`untracked` 只是分类报数。

## ⚠️ 为什么本文件自带引擎与夹具（2026-10-15 踩过一次）

第一版是 `from tests.test_vtuber_api import client, setup_db` **借**那边的夹具。结果：
**单独跑全绿、与别的文件合跑 13 条全红**（`no such table: vtubers`）——
`setup_db` 在那边是 `autouse`，import 过来**不会自动生效**，而 `client` 走的又是那一边的
引擎，两个模块的建表/清表时机一错位就是这种"取决于谁先跑"的红。

仓里的既有做法是**每个测试模块自带引擎**（见 `tests/test_notices.py`：自己
`create_engine` + `dependency_overrides` + `create_all/drop_all`）。本文件照那个来，
并且**显式断言自己拿到的是本模块的引擎**（下面那条用例）。
"""
import tempfile
import shutil
import atexit
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

# 本模块自己的测试库（进程内唯一临时目录；理由同 `test_vtuber_api.py` 头部那段）
_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-vod-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)

test_engine = create_engine(f"sqlite:///{(_TMPDIR / 'test_vod.db').as_posix()}",
                            connect_args={"check_same_thread": False})


@event.listens_for(test_engine, "connect")
def _fk_on(dbapi_connection, _record):
    """与生产同口径：SQLite 默认不校验外键，只有开 PRAGMA 才测得出"子表没清干净"。"""
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


TestingSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

from app.core.database import Base, get_db                              # noqa: E402
from app.main import app                                                # noqa: E402
from app.models.vtuber import (Account, AccountStatSnapshot, LiveCategoryOverride,  # noqa: E402
                               LiveGiftDay, LiveSession, Post, VTuber, VtuberEvent)


def override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


_CLIENT_HEADERS: dict[str, str] = {}


@pytest.fixture(autouse=True)
def _isolate_app(monkeypatch):
    """把路由依赖、后台会话、请求头都钉到**本模块的引擎**上，用完还原。

    ⚠️ 后台会话那一份不能省：`app.dependency_overrides` 只管路由，而抓取类端点
    在**后台线程**里用的是 `scheduler.SessionLocal`（指向真实数据目录）。
    """
    from app.core import api_auth
    from app.services import scheduler as _sch

    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(_sch, "SessionLocal", TestingSession)

    token = "pytest-session-token"
    monkeypatch.setattr(api_auth.settings, "API_TOKEN", token, raising=False)
    monkeypatch.setattr(api_auth.settings, "DEV_API_TOKEN", "", raising=False)
    _CLIENT_HEADERS.clear()
    _CLIENT_HEADERS[api_auth.TOKEN_HEADER] = token

    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous


@pytest.fixture
def client():
    return TestClient(app, headers=dict(_CLIENT_HEADERS))


def test_client_uses_this_modules_engine(client):
    """**回归**：本模块的用例必须跑在自己的库上。

    起因见文件头 —— 借用另一个测试文件的夹具时是"单独绿、合跑红"，而红的样子
    （`no such table: vtubers`）看不出是谁的引擎。
    """
    assert client.post("/vtuber", json={"name": "探针"}).status_code == 201
    db = TestingSession()
    try:
        assert db.query(VTuber).count() == 1, "路由没写进本模块的引擎"
    finally:
        db.close()


#: 与 `_mk_detail_sessions` 的 uuid-a 同一时刻。库里是**朴素 UTC**，
#: 而录播标题写的是**北京**墙上时间 ⇒ 12:05Z = 20:05 北京（这正是那条时区口径）。
SESSION_START_UTC = datetime(2026, 9, 7, 12, 5)
SESSION_START_BEIJING = datetime(2026, 9, 7, 20, 5)

#: ⚠️ 真 BV 号是 `BV` + **10 位**（`app/domain/live_manual.py::BV_RE`）；
#:    短一位长一位都会被 `normalize_vod` **正确**拒掉（写这条用例时踩了两次）
BV_A = "BV1abc123456"
BV_GOOD = "BV1good12345"
BV_X = "BV1xxxx12345"


def _mk(client) -> tuple[int, int]:
    """一个 V + 一个 B 站账号 + 两条场次（danmakus 一条、纯 feed 一条）。

    ⚠️ 直接在**本模块引擎**上种（不借 `test_vtuber_api._mk_detail_sessions`：
    那个函数用的是**那边的** `TestingSession`，跨模块借正是文件头记的那个坑）。
    """
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": "123"}).json()["id"]
    db = TestingSession()
    try:
        db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-a",
                           title="深夜杂谈", start_at=SESSION_START_UTC,
                           end_at=datetime(2026, 9, 7, 13, 0)))
        db.add(LiveSession(account_id=aid, source="feed", live_id="feed-1",
                           title="无限流游戏", start_at=datetime(2026, 9, 8, 20, 0)))
        db.commit()
    finally:
        db.close()
    return vid, aid


def _patch_scan(monkeypatch, *, items, sources=None, name="直播回放"):
    """把三条取数路径**全**换成桩（**一个请求都不发**）。

    ⚠️ 投稿流也必须桩住：`ordered_mids` 会把 V 自己的号（"123"）放在最后当兜底，
    不桩它就会去**打真上游**（本仓 `.env` 里有登录态）⇒ 断言会随网络变化。
    """
    import app.routers.vtuber as router_mod

    async def fake_list(mid, **_kw):
        return sources if sources is not None else [
            {"kind": "series", "id": "2484684", "name": name, "total": 942,
             "cover": "", "mtime": None},
            {"kind": "uploads", "id": "", "name": "投稿", "total": None,
             "cover": "", "mtime": None},
        ]

    async def fake_series(mid, series_id, **_kw):
        return items

    async def fake_uploads(mid, **_kw):
        return []

    monkeypatch.setattr(router_mod.vod_source_svc, "list_sources", fake_list)
    monkeypatch.setattr(router_mod.vod_source_svc, "fetch_series_archives", fake_series)
    monkeypatch.setattr(router_mod.vod_source_svc, "fetch_uploads", fake_uploads)


def _replay_item(hint_at, bvid="BVreplay1234", duration=18000):
    from app.domain.vod_source import TimeHint

    return {
        "bvid": bvid, "title": f"【直播回放】某场 {hint_at:%Y年%m月%d日%H点场}",
        "duration_seconds": duration, "published_at": SESSION_START_UTC,
        "permalink": f"https://www.bilibili.com/video/{bvid}", "cover_url": "",
        "mid": "999888", "source_name": "直播回放", "tier": "replay",
        "hint": TimeHint(at=hint_at, year_from_title=True),
    }


# ── ① vod-sources：列来源 + 自动挑 ────────────────────────────────────

def test_vod_sources_lists_sources_and_marks_the_picked_one(client, monkeypatch):
    """自动挑中的来源要**标出来**（`picked_id`）—— 界面上必须能看出"它选了哪个、能改"。"""
    vid, aid = _mk(client)
    assert client.put(f"/vtuber/{vid}", json={"vod_account_uid": "999888"}).status_code == 200
    _patch_scan(monkeypatch, items=[])

    body = client.get(f"/account/{aid}/vod-sources").json()
    assert body["mid"] == "999888", "没传 mid ⇒ 用该 V 记住的录播号（左 = 高优先）"
    kinds = [s["kind"] for s in body["sources"]]
    assert "series" in kinds and "uploads" in kinds, "投稿那条恒要在（唯一什么都能装的来源）"
    picked = [s for s in body["sources"] if s["picked"]]
    assert len(picked) == 1 and picked[0]["name"] == "直播回放"
    assert body["picked_id"] == "2484684"
    assert body["error"] is None


# ── ①b 录播号资料卡（小窗那一行 `| 昵称 mid 投稿数 |`） ────────────────

def test_vod_accounts_resolve_names_and_upload_counts(client, monkeypatch):
    """`GET /vtuber/vod-accounts/resolve?mids=…` ⇒ 一行一项，**顺序与请求一致**。"""
    import app.routers.vtuber as router_mod

    async def fake_profiles(mids):
        return [{"mid": m, "name": f"号{m}", "avatar": f"https://i0.hdslb.com/{m}.jpg",
                 "uploads": 900 + int(m), "last_published_at": None,
                 "name_error": None, "uploads_error": None} for m in mids]

    monkeypatch.setattr(router_mod.vod_source_svc, "resolve_account_profiles", fake_profiles)
    body = client.get("/vtuber/vod-accounts/resolve?mids=111,222").json()
    assert [i["mid"] for i in body["items"]] == ["111", "222"]
    assert body["items"][0]["name"] == "号111"
    assert body["items"][0]["uploads"] == 1011
    assert body["items"][0]["avatar"].startswith("https://")


def test_vod_accounts_accepts_chinese_comma_and_blank(client, monkeypatch):
    """中文逗号 / 空格 / 空串都要认（用户手输的常见形态），空 ⇒ 一个上游请求都不发。"""
    import app.routers.vtuber as router_mod

    seen: list[list[str]] = []

    async def fake_profiles(mids):
        seen.append(list(mids))
        return []

    monkeypatch.setattr(router_mod.vod_source_svc, "resolve_account_profiles", fake_profiles)
    # ⚠️ 顺手断言**状态码 200**：这条路径撞过一次 `/vtuber/{vtuber_id}/accounts`
    #    （422 int_parsing，路由根本没进来）—— 只断言"服务层被调用"会漏掉那一类。
    assert client.get("/vtuber/vod-accounts/resolve?mids=111，222 ,, 333").status_code == 200
    assert client.get("/vtuber/vod-accounts/resolve").status_code == 200
    assert seen == [["111", "222", "333"], []], seen


def test_vod_accounts_keeps_half_failures_separate(client, monkeypatch):
    """★ 昵称与投稿数**分开失败**：号有效但昵称没取到 ⇒ 界面标黄、仍然允许保存。

    合成一个 error 的话，"号不存在"与"这次没问到名字"就分不开了 ——
    前者不该存，后者该存（用户 2026-10-15 拍板「允许」）。
    """
    import app.routers.vtuber as router_mod

    async def fake_profiles(mids):
        return [{"mid": mids[0], "name": "", "avatar": "", "uploads": None,
                 "last_published_at": None,
                 "name_error": "没查到昵称（code=-400）",
                 "uploads_error": "没取到投稿数（未登录 / 风控 / 网络）"}]

    monkeypatch.setattr(router_mod.vod_source_svc, "resolve_account_profiles", fake_profiles)
    item = client.get("/vtuber/vod-accounts/resolve?mids=000").json()["items"][0]
    assert item["name"] == "" and item["uploads"] is None
    assert item["name_error"] and item["uploads_error"]
    assert item["uploads"] is None, "取不到是 None，**不是 0**（0 会被界面显示成「0 条投稿」）"


def test_vod_sources_without_a_vod_account_falls_back_to_the_vtuber_own_channel(        client, monkeypatch):
    """⚠️ **没填录播号 ≠ 没有可扫的号**：V 自己的 B 站号是恒定兜底那一档。

    真正"一个号都没有"的情形见 `test_vod_scan_without_any_scannable_account_is_422`
    （要造的是"连 B 站账号都没有"的 V）。
    """
    _vid, aid = _mk(client)
    _patch_scan(monkeypatch, items=[])
    out = client.get(f"/account/{aid}/vod-sources").json()
    assert out["mid"] == "123", out
    assert out["error"] is None


def test_vod_sources_reports_fetch_failure_instead_of_empty(client, monkeypatch):
    """⚠️ 取数失败**不能**看起来像"这个号没有合集" —— 两者补救动作不同。"""
    import app.routers.vtuber as router_mod

    async def boom(mid, **_kw):
        raise RuntimeError("上游炸了")

    monkeypatch.setattr(router_mod.vod_source_svc, "list_sources", boom)
    _vid, aid = _mk(client)
    body = client.get(f"/account/{aid}/vod-sources?mid=777").json()
    assert body["sources"] == [] and body["error"] and "上游炸了" in body["error"]


# ── ② vod-scan：只读 + 结果形态 ───────────────────────────────────────

def test_vod_scan_matches_by_title_time_and_reports_why(client, monkeypatch):
    """配上的每一条都要带 `confidence` / `auto_ok` / `minutes_delta` + 场次标题。"""
    vid, aid = _mk(client)
    assert client.put(f"/vtuber/{vid}", json={"vod_account_uid": "999888"}).status_code == 200
    _patch_scan(monkeypatch, items=[_replay_item(SESSION_START_BEIJING)])

    body = client.post(f"/account/{aid}/vod-scan", json={}).json()
    assert body["mids"] == ["999888", "123"], "录播号在前、V 自己的号兜底在后"
    assert len(body["matches"]) == 1
    m = body["matches"][0]
    assert m["live_id"] == "uuid-a"
    assert m["live_title"] == "深夜杂谈", "审查表要显示这是哪一场（只有 id 人认不出来）"
    assert m["bvid"] == "BVreplay1234"
    assert m["confidence"] == 0 and m["auto_ok"] is True
    assert m["minutes_delta"] == 0.0
    assert m["source_name"] == "直播回放"
    assert body["accounts"][0]["ok"] is True and body["accounts"][0]["matched"] == 1
    # ⚠️ `items_total` 是**两个号加起来的候选数**（每号各 1 条桩数据），不是"配上了几条"
    assert body["items_total"] == 2, body["items_total"]


def test_vod_scan_never_writes_anything(client, monkeypatch):
    """★ 扫描是**只读**的：没点确认之前，库里一个录播地址都不该多出来。"""
    vid, aid = _mk(client)
    assert client.put(f"/vtuber/{vid}", json={"vod_account_uid": "999888"}).status_code == 200
    _patch_scan(monkeypatch, items=[_replay_item(SESSION_START_BEIJING)])
    before = client.get(f"/account/{aid}/live-sessions/uuid-a").json()["vod_url"]

    body = client.post(f"/account/{aid}/vod-scan", json={}).json()
    assert body["matches"], "桩数据是要能配上的（否则这条用例会在空集上空转）"
    after = client.get(f"/account/{aid}/live-sessions/uuid-a").json()["vod_url"]
    assert after == before, "vod-scan **不许**自己把地址写进去"


def test_vod_scan_excludes_sessions_that_already_have_a_vod(client, monkeypatch):
    """⚠️ 不变量 39：用户手填的 `vod_url` 是不可再生的 —— 既不进匹配，也不算"漏配"。"""
    vid, aid = _mk(client)
    assert client.put(f"/vtuber/{vid}", json={"vod_account_uid": "999888"}).status_code == 200
    # ⚠️ BV 号是 `BV` + **10 位**：`BV1manual` 会被 `normalize_vod` **正确**拒掉（422）
    assert client.patch(f"/account/{aid}/live-sessions/uuid-a",
                        json={"vod_url": BV_A}).status_code == 200
    _patch_scan(monkeypatch, items=[_replay_item(SESSION_START_BEIJING)])

    body = client.post(f"/account/{aid}/vod-scan", json={}).json()
    assert body["matches"] == []
    assert "uuid-a" not in [u["live_id"] for u in body["unmatched"]], \
        "手填了录播的场次既不进匹配、也不算漏配"


def test_vod_scan_lists_the_gaps_it_could_not_fill(client, monkeypatch):
    """配不上的场次如实进 `unmatched`（**这就是"手动补"那一列**）。"""
    vid, aid = _mk(client)
    assert client.put(f"/vtuber/{vid}", json={"vod_account_uid": "999888"}).status_code == 200
    _patch_scan(monkeypatch, items=[])          # 该号一条都没有

    body = client.post(f"/account/{aid}/vod-scan", json={}).json()
    assert body["matches"] == []
    ids = {u["live_id"] for u in body["unmatched"]}
    assert ids == {"uuid-a", "feed-1"}          # feed-1 是纯 feed 行，同样没有录播
    assert all(u["start_at"] for u in body["unmatched"])


def test_vod_scan_without_any_scannable_account_is_422(client, monkeypatch):
    """一个号都扫不了 ⇒ 422 + 人话（不是静默返回空结果）。

    ⚠️ **要造的是"连 B 站账号都没有"的 V**，不是"没填录播号" —— 后者照样能扫 V 自己的
    那 123（见 `..._falls_back_to_the_vtuber_own_channel`）。
    """
    _vid, aid = _mk(client)
    _patch_scan(monkeypatch, items=[])
    db = TestingSession()
    try:
        acc = db.query(Account).filter(Account.id == aid).one()
        acc.platform, acc.platform_uid = "weibo", "w1"
        db.commit()
    finally:
        db.close()
    r = client.post(f"/account/{aid}/vod-scan", json={"mids": []})
    assert r.status_code == 422 and "录播号" in r.json()["detail"], r.text


def test_vod_scan_honours_an_explicit_source_choice(client, monkeypatch):
    """用户改过来源要**照办**（自动挑的结果必须能改）。"""
    import app.routers.vtuber as router_mod

    seen: list[tuple] = []

    async def fake_series(mid, series_id, **kw):
        seen.append((mid, series_id))
        return []

    async def fake_season(mid, season_id, **kw):
        seen.append((mid, season_id))
        return []

    async def fake_list(mid, **_kw):        # pragma: no cover - 显式给来源时不该被调
        raise AssertionError("显式指定了来源就不该再去列清单")

    monkeypatch.setattr(router_mod.vod_source_svc, "fetch_series_archives", fake_series)
    monkeypatch.setattr(router_mod.vod_source_svc, "fetch_season_archives", fake_season)
    monkeypatch.setattr(router_mod.vod_source_svc, "list_sources", fake_list)
    _vid, aid = _mk(client)
    client.post(f"/account/{aid}/vod-scan",
                json={"mids": ["555"], "sources": {"555": {"kind": "season", "id": "777"}}})
    assert seen == [("555", "777")]


# ── ③ vod-apply：只写显式项、逐条独立 ─────────────────────────────────

def test_vod_apply_writes_only_the_given_items(client, monkeypatch):
    _vid, aid = _mk(client)
    r = client.post(f"/account/{aid}/vod-apply",
                    json={"items": [{"live_id": "uuid-a", "vod_url": BV_A}]})
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] == 1 and body["failed"] == 0, body
    assert body["results"][0]["vod_url"] == f"https://www.bilibili.com/video/{BV_A}"
    # 写进去了（走的是与手动填同一条规范化）
    assert client.get(f"/account/{aid}/live-sessions/uuid-a").json()["vod_url"] \
        == f"https://www.bilibili.com/video/{BV_A}"
    # 没传的另一场**不许**被顺手写上
    assert client.get(f"/account/{aid}/live-sessions/feed-1").json()["vod_url"] is None


def test_vod_apply_is_per_item_independent(client, monkeypatch):
    """一条不合格不能让别的白写，也不能静默 —— 结果里逐条给原因。"""
    _vid, aid = _mk(client)
    body = client.post(f"/account/{aid}/vod-apply", json={"items": [
        {"live_id": "uuid-a", "vod_url": BV_GOOD},
        {"live_id": "feed-1", "vod_url": "https://example.com/not-bilibili"},
        {"live_id": "不存在的场次", "vod_url": BV_X},
        {"live_id": "feed-1", "vod_url": ""},
    ]}).json()
    assert body["applied"] == 1 and body["failed"] == 3, body
    # ⚠️ **按位置断言**：同一个 `live_id` 可以出现两次（两个坏条目都是 feed-1），
    #    按 live_id 建字典会把前一条覆盖掉
    ok_r, bad1, bad2, bad3 = body["results"]
    assert ok_r["live_id"] == "uuid-a" and ok_r["ok"] is True and ok_r["error"] is None
    assert "这个主机不支持" in (bad1["error"] or ""), bad1
    assert "不在表内" in (bad2["error"] or ""), bad2
    assert "空的" in (bad3["error"] or ""), bad3
    assert client.get(f"/account/{aid}/live-sessions/feed-1").json()["vod_url"] is None


def test_vod_apply_empty_items_is_a_422(client):
    """没有条目 ⇒ 422（不是"成功写入 0 条"那种看着像成功的回执）。"""
    _vid, aid = _mk(client)
    r = client.post(f"/account/{aid}/vod-apply", json={"items": []})
    assert r.status_code == 422 and "没有要写入" in r.json()["detail"]


def test_vod_apply_unknown_account_is_404(client):
    r = client.post("/account/99999/vod-apply",
                    json={"items": [{"live_id": "x", "vod_url": BV_X}]})
    assert r.status_code == 404


# ── ④ vod-clear：**硬清这个账号下所有已匹配的地址** ──────────────────
#
# 2026-10-15 第三版（用户口径「硬性清除所有已匹配项」）：只要 `vod_url` 非空就清，
# **不分类**。上一版只清 `vod_source='match'`，用户库里 693 条有地址的一条都没清掉，
# 回执只能说"这些清不掉" ⇒ 看着像功能坏了（那正是报回来的症状）。
# 回执里的 `auto`/`manual`/`untracked` 只是**分类报数**，用来在确认窗里说清范围。
#
# 仍然保留的两条纪律：**不扫描**（纯数据库、一个上游请求都不发）、
# **只清地址不删场次**。

def _auto_then_manual_setup(client, monkeypatch):
    """造出"一条是自动匹配写的、一条是用户手填的"，返回 `aid`。"""
    vid, aid = _mk(client)
    assert client.put(f"/vtuber/{vid}", json={"vod_account_uid": "999888"}).status_code == 200
    item = _replay_item(SESSION_START_BEIJING)          # 配到 uuid-a
    _patch_scan(monkeypatch, items=[item])
    body = client.post(f"/account/{aid}/vod-scan", json={}).json()
    assert len(body["matches"]) == 1
    scanned = body["matches"][0]["permalink"]
    # ① 走**真端点**让服务端记账（手改行不会写 vod_source，测出来的就不是真实路径）
    assert client.post(f"/account/{aid}/vod-apply",
                       json={"items": [{"live_id": "uuid-a", "vod_url": scanned}]}
                       ).json()["applied"] == 1
    # ② 用户**手填**的一条（feed-1）
    assert client.patch(f"/account/{aid}/live-sessions/feed-1",
                        json={"vod_url": BV_GOOD}).status_code == 200
    return aid


def test_vod_clear_removes_everything_matched(client, monkeypatch):
    """★ 全清：自动匹配写的**和**手填的一起清（用户：「硬性清除所有已匹配项」）。"""
    aid = _auto_then_manual_setup(client, monkeypatch)

    out = client.post(f"/account/{aid}/vod-clear", json={}).json()
    assert out["cleared"] == 2, out
    assert (out["auto"], out["manual"], out["untracked"]) == (1, 1, 0), out
    assert client.get(f"/account/{aid}/live-sessions/uuid-a").json()["vod_url"] is None
    assert client.get(f"/account/{aid}/live-sessions/feed-1").json()["vod_url"] is None
    # ★ 只清地址，**场次还在**
    assert client.get(f"/account/{aid}/live-sessions/uuid-a").status_code == 200


def test_vod_clear_clears_a_url_the_user_edited_by_hand(client, monkeypatch):
    """★ 用户把自动写的那条**改成了别的**（记账号转 `manual`）⇒ 这一版照样清。"""
    aid = _auto_then_manual_setup(client, monkeypatch)
    assert client.patch(f"/account/{aid}/live-sessions/uuid-a",
                        json={"vod_url": BV_X}).status_code == 200

    out = client.post(f"/account/{aid}/vod-clear", json={}).json()
    assert out["cleared"] == 2 and out["manual"] == 2, out
    assert client.get(f"/account/{aid}/live-sessions/uuid-a").json()["vod_url"] is None


def test_vod_clear_dry_run_counts_without_writing(client, monkeypatch):
    """`dry_run=true` **只数不写** —— 界面上先给用户看"会清掉几条"再确认。"""
    aid = _auto_then_manual_setup(client, monkeypatch)
    before = client.get(f"/account/{aid}/live-sessions/uuid-a").json()["vod_url"]

    out = client.post(f"/account/{aid}/vod-clear", json={"dry_run": True}).json()
    assert out["dry_run"] is True and out["cleared"] == 2, out
    assert client.get(f"/account/{aid}/live-sessions/uuid-a").json()["vod_url"] == before, \
        "dry-run 绝不许写"
    assert client.get(f"/account/{aid}/live-sessions/feed-1").json()["vod_url"] is not None


def test_vod_clear_also_clears_untracked_history(client):
    """★ **历史行（`vod_source IS NULL`）也清得掉了**（上一版清不掉，用户就是报这个）。

    f018 **不回填**是对的（猜错会误伤），但"清不掉"不该是终局 ——
    硬清按 `vod_url IS NOT NULL` 走，记账与否不影响。
    """
    _vid, aid = _mk(client)
    db = TestingSession()
    try:
        row = db.query(LiveSession).filter(LiveSession.live_id == "uuid-a").one()
        row.vod_url = f"https://www.bilibili.com/video/{BV_A}"
        row.vod_source = None                       # 模拟历史行：有地址、没记账
        db.commit()
    finally:
        db.close()

    out = client.post(f"/account/{aid}/vod-clear", json={}).json()
    assert out["cleared"] == 1 and out["untracked"] == 1, out
    assert client.get(f"/account/{aid}/live-sessions/uuid-a").json()["vod_url"] is None


def test_vod_clear_sends_no_upstream_request(client, monkeypatch):
    """★ **一个上游请求都不发**（第一版最大的毛病：清空里又跑了一次真扫描）。"""
    import app.routers.vtuber as router_mod

    async def boom(*_a, **_kw):                                          # pragma: no cover
        raise AssertionError("清空路径不许打上游")

    monkeypatch.setattr(router_mod.vod_source_svc, "list_sources", boom)
    monkeypatch.setattr(router_mod.vod_source_svc, "fetch_series_archives", boom)
    monkeypatch.setattr(router_mod.vod_source_svc, "fetch_uploads", boom)
    # 造一条已记账的即可（不经过扫描 ⇒ 也就不会碰到上面那些桩）
    _vid, aid = _mk(client)
    db = TestingSession()
    try:
        row = db.query(LiveSession).filter(LiveSession.live_id == "uuid-a").one()
        row.vod_url = f"https://www.bilibili.com/video/{BV_A}"
        row.vod_source = "match"
        db.commit()
    finally:
        db.close()
    out = client.post(f"/account/{aid}/vod-clear", json={}).json()
    assert out["cleared"] == 1, out


def test_vod_clear_unknown_account_is_404(client):
    r = client.post("/account/99999/vod-clear", json={})
    assert r.status_code == 404
