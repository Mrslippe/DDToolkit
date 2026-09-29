# -*- coding: utf-8 -*-
"""头像多版本保留（R47，devlog/249）。

## 用户口径

2026-09-28：「发现账号更换了头像，新抓取下来的**不要直接覆盖以前的**，
而是把这些都作为**可选项**保留下来，标记当前用的是哪个就行」。

## 这条需求真正的难点（也是判据的由来）

"别覆盖 URL"是半件事 —— 本地缓存文件名**原先也是固定的**
（`static/avatars/{platform}_{uid}{ext}`），新图下载下来会把旧文件**覆盖掉**。
所以只记 URL 的话，选择器里那些旧选项全是**破图**。判据⑤专门钉这一点。

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | 抓取到新 URL ⇒ **追加**一行，旧行与旧文件都还在 | 旧头像永久丢失（本需求的反面） |
| ② | 同一个 URL 抓两次 ⇒ 仍是一行，只前移 `last_seen_at` | 历史被刷成一堆重复项 |
| ③ | URL 没变（升级后的老数据）也记一行 | 选择器对老用户是**空的**（比改之前更差） |
| ④ | 延后下载完成后把本地路径补进那一行 | 选择器只有远端 URL，离线时全破图 |
| ⑤ | 两个不同 URL ⇒ **两个文件**，旧文件内容不变 | "保留历次头像"名存实亡 |
| ⑥ | 超过上限 ⇒ 丢**最旧**的，但**不丢当前选中的那张** | 正在用的那张从列表里消失 |
| ⑦ | `current_url` = `vtubers.avatar` → B站账号 → 首个账号 | "当前"标错人（用户以为切换失败） |
| ⑧ | 账本为空 ⇒ 用账号现值兜底（`id=None`） | 升级后第一次打开选择器是空的 |
| ⑨ | 删账号 / 删 V 都清得掉（含 `account_id IS NULL` 的行） | `DELETE FROM vtubers` 被外键挡下 ⇒ 解除订阅 500 |
"""
from __future__ import annotations

import asyncio
import atexit
import json
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base, get_db
from app.main import app
from app.models.vtuber import Account, LocalAsset, VTuber, VtuberAvatarHistory
from app.services import assets as AS
from app.services import vtuber_avatars as VA

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-avatar-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'avatar.db').as_posix()}",
                        connect_args={"check_same_thread": False})
_Session = sessionmaker(bind=_engine, autoflush=False, autocommit=False)


def _override_get_db():
    db = _Session()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _test_db():
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    Base.metadata.create_all(bind=_engine)
    yield
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    Base.metadata.drop_all(bind=_engine)


@pytest.fixture
def db():
    s = _Session()
    yield s
    s.close()


@pytest.fixture
def client():
    return TestClient(app)


def _mk_v(db, name="头像V") -> VTuber:
    v = VTuber(name=name)
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _mk_acc(db, v, platform="weibo", uid="w1", url="https://wx1.sinaimg.cn/a.jpg",
            path=None) -> Account:
    a = Account(vtuber_id=v.id, platform=platform, platform_uid=uid,
                avatar_url=url, avatar_path=path, followers_count=0)
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


class _FakePf:
    """假平台抓取器：按调用次序吐出不同的头像 URL。"""

    def __init__(self, avatars: list[str]):
        self.avatars = avatars
        self.n = 0

    async def fetch_user_info(self, uid, client=None):
        url = self.avatars[min(self.n, len(self.avatars) - 1)]
        self.n += 1
        return {"name": "名字", "sign": "签名", "avatar": url, "followers_count": 1}


def _rows(db, v) -> list[VtuberAvatarHistory]:
    return (db.query(VtuberAvatarHistory)
            .filter(VtuberAvatarHistory.vtuber_id == v.id)
            .order_by(VtuberAvatarHistory.first_seen_at.desc(),
                      VtuberAvatarHistory.id.desc())
            .all())


# ── ①②③ 抓取侧记账 ─────────────────────────────────────────────────────

def test_new_avatar_appends_and_keeps_the_old_row(db, monkeypatch):
    """① 换头像 = 追加一行，旧行还在（本需求的核心）。"""
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = _mk_acc(db, v, url="https://wx1.sinaimg.cn/old.jpg", path="static/avatars/old.jpg")
    pf = _FakePf(["https://wx1.sinaimg.cn/old.jpg", "https://wx1.sinaimg.cn/new.jpg"])
    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: pf)

    async def fake_download(url, uid, client=None):
        return f"static/avatars/{uid}_{url.rsplit('/', 1)[-1]}"

    monkeypatch.setattr(sch, "_download_avatar", fake_download)

    assert asyncio.run(sch._fetch_one_account(acc, db)) is True
    db.commit()
    first_path = _rows(db, v)[0].avatar_path       # 头一次记下的本地文件
    assert asyncio.run(sch._fetch_one_account(acc, db)) is True
    db.commit()

    got = _rows(db, v)
    assert len(got) == 2, f"换一次头像应当两行（新旧各一行），实际 {len(got)}"
    assert got[0].avatar_url.endswith("new.jpg")
    assert got[1].avatar_url.endswith("old.jpg"), "旧头像的行被覆盖掉了（这正是用户要修的行为）"
    assert got[1].avatar_path == first_path, "旧行必须仍指着旧文件（不许被新图改写）"
    assert got[0].avatar_path != first_path, "新行应当是另一个文件（版本化命名）"
    assert acc.avatar_url.endswith("new.jpg") and acc.avatar_path
    assert got[0].platform == "weibo" and got[0].account_id == acc.id


def test_same_url_twice_touches_instead_of_duplicating(db, monkeypatch):
    """② 幂等：同一个 URL 抓两次仍是一行（只前移 last_seen_at）。"""
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = _mk_acc(db, v, url="https://wx1.sinaimg.cn/same.jpg",
                  path="static/avatars/same.jpg")
    monkeypatch.setattr(sch.registry, "get_fetcher",
                        lambda p: _FakePf(["https://wx1.sinaimg.cn/same.jpg"]))

    ticks = iter(["2026-09-28T10:00:00", "2026-09-28T11:00:00"])
    monkeypatch.setattr(VA, "_now", lambda: __import__("datetime").datetime.fromisoformat(
        next(ticks)))

    asyncio.run(sch._fetch_one_account(acc, db))
    db.commit()
    asyncio.run(sch._fetch_one_account(acc, db))
    db.commit()

    got = _rows(db, v)
    assert len(got) == 1, f"同一个 URL 记了两行（历史会被刷成噪声）：{len(got)}"
    assert got[0].first_seen_at.hour == 10, "first_seen_at 不该被后一次抓取改写"
    assert got[0].last_seen_at.hour == 11, "last_seen_at 应当前移到最近一次见到它"


def test_legacy_avatar_is_backfilled_on_next_fetch(db, monkeypatch):
    """③ 自愈：升级后第一次抓取就把**已有的**老头像补进账本。

    判据为什么必须有：记账若只在"URL 变了"时发生，老用户的选择器会先是**空的**
    —— 比改这个需求之前（列账号现值）更差。
    """
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = _mk_acc(db, v, url="https://wx1.sinaimg.cn/legacy.jpg",
                  path="static/avatars/legacy.jpg")
    assert _rows(db, v) == []          # 升级前抓的：账本里没有
    monkeypatch.setattr(sch.registry, "get_fetcher",
                        lambda p: _FakePf(["https://wx1.sinaimg.cn/legacy.jpg"]))
    monkeypatch.setattr(sch, "_avatar_missing", lambda a: False)   # 文件在本地，不必重下

    asyncio.run(sch._fetch_one_account(acc, db))
    db.commit()

    got = _rows(db, v)
    assert len(got) == 1 and got[0].avatar_url.endswith("legacy.jpg")
    assert got[0].avatar_path == "static/avatars/legacy.jpg", "应当带上已有的本地缓存路径"


def test_deferred_download_fills_the_local_path(db, monkeypatch):
    """④ 延后下载（收录/加账号的 fast 路径）：先落 URL，文件到位后再补路径。"""
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = _mk_acc(db, v, url=None, path=None)
    monkeypatch.setattr(sch.registry, "get_fetcher",
                        lambda p: _FakePf(["https://wx1.sinaimg.cn/deferred.jpg"]))
    monkeypatch.setattr(sch, "SessionLocal", _Session)
    pushed: list[int] = []
    monkeypatch.setattr(sch, "_push_account_snapshot", lambda a: pushed.append(a.id))

    pending: list[str] = []
    asyncio.run(sch._fetch_one_account(acc, db, pending_avatar=pending))
    db.commit()
    assert pending == ["https://wx1.sinaimg.cn/deferred.jpg"]
    row = _rows(db, v)[0]
    assert row.avatar_path is None, "文件还没下，路径必须留空（写成旧文件的路径会张冠李戴）"

    async def fake_download(url, uid, client=None):
        return f"static/avatars/{uid}_v2.jpg"

    monkeypatch.setattr(sch, "_download_avatar", fake_download)
    asyncio.run(sch._deferred_avatar(acc.id, "https://wx1.sinaimg.cn/deferred.jpg"))

    db.expire_all()
    row = _rows(db, v)[0]
    assert row.avatar_path == f"static/avatars/weibo_w1_v2.jpg"
    assert pushed == [acc.id]


# ── ⑤ 文件名版本化：旧文件不许被覆盖 ─────────────────────────────────────

def test_avatar_file_name_is_versioned(tmp_path, monkeypatch):
    """⑤ 两个不同 URL ⇒ 两个文件，且**旧文件内容不变**。

    这条是本需求最容易被漏掉的一半：只记 URL 不换文件名，本地那张图已经被新图
    覆盖了 ⇒ 选择器里的旧选项全是破图（用户看到的现象是"旧头像点不出来"）。

    ⚠️ L1（devlog/257）改了**落点与命名口径**（`static/assets/avatar/{uid}_{sha1(稳定键)[:8]}{ext}`，
    目录由 `assets.data_root()` 决定 = conftest 指到 tmp_path），判据本身不变；
    另加一条：**换了签名（同一张图）必须落到同一个文件**（R47 的 `sha1(URL)` 口径做不到这点，
    微博每 3 小时换一次签名 ⇒ 每次都造一个新文件）。
    """
    from app.services import scheduler as sch

    class _Resp:
        def __init__(self, body: bytes):
            self.status_code = 200
            self.content = body

    class _Client:
        def __init__(self, body: bytes):
            self.body = body

        async def get(self, url):
            return _Resp(self.body)

    p1 = asyncio.run(sch._download_avatar("https://wx1.sinaimg.cn/a.jpg", "weibo_w1",
                                          client=_Client(b"AAA")))
    p2 = asyncio.run(sch._download_avatar("https://wx1.sinaimg.cn/b.jpg", "weibo_w1",
                                          client=_Client(b"BBB")))
    assert p1 != p2, f"换了 URL 却写到同一个文件（旧图被覆盖）：{p1}"
    assert p1 and p2 and p1.startswith("static/assets/avatar/weibo_w1_")
    f1, f2 = tmp_path / p1, tmp_path / p2
    assert f1.read_bytes() == b"AAA", "旧头像文件被新图覆盖了"
    assert f2.read_bytes() == b"BBB"
    # 同一个 URL 再来一次 ⇒ 同一个文件（幂等，不留垃圾）
    p3 = asyncio.run(sch._download_avatar("https://wx1.sinaimg.cn/a.jpg", "weibo_w1",
                                          client=_Client(b"AAA")))
    assert p3 == p1
    # 换签名、同一张图 ⇒ **同一个文件**，而且一个请求都不发（L1 的核心收益）
    signed = asyncio.run(sch._download_avatar(NEW_URL, "weibo_7471118487",
                                              client=_Client(b"CCC")))
    rotated = asyncio.run(sch._download_avatar(OLD_URL, "weibo_7471118487",
                                               client=_Client(b"CCC")))
    assert signed == rotated, "换了签名就写到另一个文件 —— 同一张图被存了两份"
    assert (tmp_path / signed).read_bytes() == b"CCC"


# ── ⑥ 封顶淘汰 ─────────────────────────────────────────────────────────

def test_cap_evicts_oldest_but_never_the_selected_one(db):
    """⑥ 超过上限丢最旧的；被用户选中的那张（protect_url）不许丢。"""
    v = _mk_v(db)
    acc = _mk_acc(db, v, url="https://x/0.jpg")
    limit = 5
    # 最旧那张 = 用户当前选的
    selected = "https://x/0.jpg"
    for i in range(limit + 1):           # 记 6 张，上限 5
        VA.record_avatar_version(db, vtuber_id=v.id, account_id=acc.id, platform="weibo",
                                 url=f"https://x/{i}.jpg", path=f"static/avatars/{i}.jpg",
                                 protect_url=selected, limit=limit)
    db.commit()

    got = _rows(db, v)
    urls = [r.avatar_url for r in got]
    assert len(got) == limit, f"应当封顶在 {limit}，实际 {len(got)}"
    assert selected in urls, "当前选中的那张被淘汰了 —— 列表里就没有'当前'这一项了"
    assert "https://x/1.jpg" not in urls, "该丢的是最旧的那张（除受保护的那张以外）"
    assert urls[0] == f"https://x/{limit}.jpg", "列表应当新的在前"


def test_cap_evicts_plainly_when_nothing_is_protected(db):
    """⑥b 没有保护对象时就是纯粹丢最旧（防止"保护"把淘汰变成空转）。"""
    v = _mk_v(db)
    for i in range(4):
        VA.record_avatar_version(db, vtuber_id=v.id, account_id=None, platform="bilibili",
                                 url=f"https://y/{i}.jpg", limit=3)
    db.commit()
    urls = [r.avatar_url for r in _rows(db, v)]
    assert urls == ["https://y/3.jpg", "https://y/2.jpg", "https://y/1.jpg"]


# ── ⑦⑧ 当前用的是哪张 / 路由 ───────────────────────────────────────────

def test_current_avatar_url_chain(db):
    """⑦ 与前端 `resolveAvatar` 的 URL 侧同口径：自定义 → B站 → 首个账号。"""
    v = _mk_v(db)
    assert VA.current_avatar_url(v) is None
    a1 = _mk_acc(db, v, platform="weibo", uid="w1", url="https://w/a.jpg")
    assert VA.current_avatar_url(v) == "https://w/a.jpg"
    _mk_acc(db, v, platform="bilibili", uid="b1", url="https://b/b.jpg")
    db.refresh(v)
    assert VA.current_avatar_url(v) == "https://b/b.jpg", "有 B 站账号时以 B 站为准"
    v.avatar = "https://w/chosen.jpg"
    db.commit()
    db.refresh(v)
    assert VA.current_avatar_url(v) == "https://w/chosen.jpg", "档案设置选过的优先于一切"
    assert a1.id


def test_route_returns_versions_newest_first_with_current(db, client):
    """路由：历次头像（新的在前）+ 当前用的那张。"""
    v = _mk_v(db)
    acc = _mk_acc(db, v, url="https://x/2.jpg")
    for i in (1, 2):
        VA.record_avatar_version(db, vtuber_id=v.id, account_id=acc.id, platform="weibo",
                                 url=f"https://x/{i}.jpg", path=f"static/avatars/{i}.jpg")
    db.commit()
    v.avatar = "https://x/1.jpg"          # 用户回选了旧的那张
    db.commit()

    resp = client.get(f"/vtuber/{v.id}/avatars")
    assert resp.status_code == 200
    body = resp.json()
    assert body["current_url"] == "https://x/1.jpg"
    assert [x["url"] for x in body["versions"]] == ["https://x/2.jpg", "https://x/1.jpg"]
    assert body["versions"][1]["path"] == "static/avatars/1.jpg"
    assert body["versions"][0]["platform"] == "weibo"
    # naive datetime 必须补成带时区的 ISO（否则前端按本地时区解析、差 8 小时）
    from datetime import datetime, timedelta
    first = datetime.fromisoformat(body["versions"][0]["first_seen_at"])
    assert first.utcoffset() == timedelta(0), f"时间没带 UTC 时区：{body['versions'][0]}"


def test_route_falls_back_to_account_avatar_when_book_is_empty(db, client):
    """⑧ 账本还空着（升级后没抓过）⇒ 用账号现值兜底，别让选择器比旧版更差。"""
    v = _mk_v(db)
    _mk_acc(db, v, url="https://w/now.jpg", path="static/avatars/now.jpg")

    body = client.get(f"/vtuber/{v.id}/avatars").json()
    assert [x["url"] for x in body["versions"]] == ["https://w/now.jpg"]
    assert body["versions"][0]["id"] is None, "不是账本里的行（前端据此不显示'首次见到'）"
    assert body["versions"][0]["path"] == "static/avatars/now.jpg"
    assert body["current_url"] == "https://w/now.jpg"


def test_route_404_for_missing_vtuber(client):
    assert client.get("/vtuber/99999/avatars").status_code == 404


# ── A0（devlog/255）：`avatar_local` 派生 + 本地回落 ──────────────────────
#
# 起因（2026-09-29 真机实测）：用户选中的头像存的是**远端 URL**，而远端会死 ——
# V#16 那张微博头像的签名 `Expires` 已过期 21 小时，当时只靠 `/img-proxy` 缓存续命。
# A0 给 `VTuberOut` 加一个**只读派生**字段 `avatar_local`（当前选中那张的本地副本路径），
# 渲染侧就能在"直连 / 代理都失败"之后回落到盘上那份。

def test_avatar_local_from_history_row(db, client):
    """A0-1 账本行命中 ⇒ `avatar_local` = 该行的 `avatar_path`（账本最权威）。"""
    v = _mk_v(db)
    acc = _mk_acc(db, v, url="https://i2.hdslb.com/bfs/face/old.jpg",
                  path="static/avatars/bilibili_w1.jpg")
    VA.record_avatar_version(db, vtuber_id=v.id, account_id=acc.id, platform="weibo",
                             url="https://i2.hdslb.com/bfs/face/old.jpg",
                             path="static/avatars/bilibili_w1_ab12cd34.jpg")
    v.avatar = "https://i2.hdslb.com/bfs/face/old.jpg"
    db.commit()

    got = client.get(f"/vtuber/{v.id}").json()
    assert got["avatar"] == "https://i2.hdslb.com/bfs/face/old.jpg", "`avatar` 语义不许动"
    assert got["avatar_local"] == "static/avatars/bilibili_w1_ab12cd34.jpg", (
        "账本里明明记着这张图落在哪个文件，派生却没用它")


def test_avatar_local_falls_back_to_account(db, client):
    """A0-2 账本不认识它（升级前就选好的）⇒ 退一步用账号的 `avatar_path`；都没有 ⇒ null。"""
    v = _mk_v(db)
    _mk_acc(db, v, url="https://i2.hdslb.com/bfs/face/pre.jpg",
            path="static/avatars/bilibili_w1.jpg")
    v.avatar = "https://i2.hdslb.com/bfs/face/pre.jpg"
    db.commit()
    assert client.get(f"/vtuber/{v.id}").json()["avatar_local"] == "static/avatars/bilibili_w1.jpg"

    v.avatar = "https://i2.hdslb.com/bfs/face/never-seen.jpg"     # 两边都不认识
    db.commit()
    assert client.get(f"/vtuber/{v.id}").json()["avatar_local"] is None, (
        "查不到必须是 null —— 拿空串拼出来的假 URL 会让前端把占位当图")

    v.avatar = None                                            # 没选过 ⇒ 也不派生
    db.commit()
    assert client.get(f"/vtuber/{v.id}").json()["avatar_local"] is None


def test_avatar_local_batches_without_n_plus_1(db, client):
    """A0-3 `/vtuber/list` 的派生**一次查完**：V 数翻倍，SQL 语句数不变。

    判据为什么必须有：`/vtuber/list` 返回全部 V，逐 V 查就是 N 次往返（左栏首屏直接变慢）。
    """
    from sqlalchemy import event

    def _count_for(n: int) -> int:
        for i in range(n):
            v = _mk_v(db, name=f"批量V{n}-{i}")
            _mk_acc(db, v, platform="weibo", uid=f"w{n}-{i}",
                    url=f"https://x/{n}-{i}.jpg", path=f"static/avatars/w{n}-{i}.jpg")
            v.avatar = f"https://x/{n}-{i}.jpg"
        db.commit()

        stmts: list[str] = []
        eng = db.get_bind()

        def _rec(conn, cursor, statement, parameters, context, executemany):
            stmts.append(statement)

        event.listen(eng, "before_cursor_execute", _rec)
        try:
            assert client.get("/vtuber/list").status_code == 200
        finally:
            event.remove(eng, "before_cursor_execute", _rec)
        return len(stmts)

    one = _count_for(1)
    many = _count_for(3)          # 再加 3 个 V
    assert many <= one + 1, (
        f"派生字段把查询数从 {one} 涨到 {many} —— 这是 N+1（V 越多越慢）")


def test_avatar_local_shape_is_whitespace_tolerant(db, client):
    """A0-2′ 空白值不许当成"有本地文件"（`avatar` 是 `'  url  '` 时应当被 strip 掉）。"""
    v = _mk_v(db)
    _mk_acc(db, v, url="https://x/a.jpg", path="static/avatars/a.jpg")
    v.avatar = "  https://x/a.jpg  "
    db.commit()
    assert client.get(f"/vtuber/{v.id}").json()["avatar_local"] == "static/avatars/a.jpg"


# ── ⑨ purge：漏清会被外键挡下（解除订阅 500 的老事故形态） ─────────────────

def test_delete_account_clears_its_avatar_versions(db, client):
    """⑨a 删账号：该账号的头像版本行一并清掉（否则外键挡下 → 409）。"""
    v = _mk_v(db)
    acc = _mk_acc(db, v, url="https://w/a.jpg")
    VA.record_avatar_version(db, vtuber_id=v.id, account_id=acc.id, platform="weibo",
                             url="https://w/a.jpg")
    db.commit()

    assert client.delete(f"/account/{acc.id}").status_code == 204
    assert _rows(db, v) == []


def test_delete_vtuber_clears_orphan_avatar_rows(db, client):
    """⑨b 删 V：连 `account_id IS NULL` 的行也要清（只按 account 清会漏掉它们）。

    这是本仓已经出过一次的事故形态（posts 那次）：漏清一张子表 ⇒ `DELETE FROM vtubers`
    被外键挡下 ⇒ 整次回滚 ⇒ 用户侧「解除订阅失败、V 删不掉」。
    """
    v = _mk_v(db)
    acc = _mk_acc(db, v, url="https://w/a.jpg")
    db.add(VtuberAvatarHistory(vtuber_id=v.id, account_id=None, platform="weibo",
                               avatar_url="https://w/orphan.jpg",
                               avatar_path="static/avatars/orphan.jpg",
                               first_seen_at=VA._now()))
    VA.record_avatar_version(db, vtuber_id=v.id, account_id=acc.id, platform="weibo",
                             url="https://w/a.jpg")
    db.commit()
    assert len(_rows(db, v)) == 2

    assert client.delete(f"/vtuber/{v.id}").status_code == 204, (
        "解除订阅被外键挡下了 —— 说明 vtuber_avatar_history 没被 purge 清干净")
    assert db.query(VtuberAvatarHistory).count() == 0
    assert db.query(VTuber).filter(VTuber.id == v.id).first() is None


# ── L1（devlog/257）：轻资产模块接入头像这条链 ────────────────────────────
#
# 起因是 R47 只解决了"别覆盖"，没解决"远端会死"与"同一张图有多个 URL"：
#   · 真实样本（`tests/fixtures/light_assets.json`，取自真机库）：同一张图的两次抓取
#     只差 `Expires` / `ssig`（微博签名约 3 小时轮换）；而 `weibo_7471118487.jpg` 与
#     `weibo_7471118487_3d2b0b8a.jpg` **sha256 逐字节相同** —— 一张图被存了两遍；
#   · 本批把抓到的头像固化进 `static/assets/avatar/`，键 = **去掉签名参数的 URL**：
#     命中键 ⇒ 读盘（**一次图片请求都不发**），换签名也认得是同一张。
#
# ⚠️ "没发请求"这类断言**必须配正对照**（DEV-LOOP §0.7）：先证明第一次真的发了。

FIXTURE = Path(__file__).parent / "fixtures" / "light_assets.json"
FX = json.loads(FIXTURE.read_text(encoding="utf-8"))
_PAIR = FX["rotated_pairs"][0]
OLD_URL, NEW_URL = _PAIR["old"]["url"], _PAIR["new"]["url"]


class _Resp:
    def __init__(self, status: int = 200, body: bytes = b"IMG-BYTES"):
        self.status_code, self.content = status, body


class _CountingClient:
    """只记**图片请求**的假 HTTP 客户端（平台抓取走假 fetcher，不碰它）。

    ⚠️ 形状必须与真身一致：`_download_avatar` 用的是 `await client.get(url)` 与
    `resp.status_code / resp.content`（替身形状不对 ⇒ 真 bug 在替身那边照样全绿）。
    """

    def __init__(self, body: bytes = b"IMG-BYTES"):
        self.body, self.calls = body, []

    async def get(self, url: str) -> _Resp:
        self.calls.append(url)
        return _Resp(200, self.body)

    async def aclose(self) -> None:      # 与 httpx.AsyncClient 同名同形
        pass


def test_second_fetch_issues_no_image_request(db, monkeypatch):
    """判据①（本批的核心收益）：同一个 URL **第二次抓取 0 次图片请求**。"""
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = _mk_acc(db, v, url=None, path=None)
    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: _FakePf([NEW_URL]))
    client = _CountingClient()

    assert asyncio.run(sch._fetch_one_account(acc, db, client=client)) is True
    db.commit()
    assert len(client.calls) == 1, "正对照：第一次必须真的发一次图片请求"
    assert (acc.avatar_path or "").startswith("static/assets/avatar/"), (
        f"抓到的头像应当固化进 assets 目录（实际 {acc.avatar_path!r}）")
    first_path = acc.avatar_path

    assert asyncio.run(sch._fetch_one_account(acc, db, client=client)) is True
    db.commit()
    assert len(client.calls) == 1, (
        "同一个 URL 第二次抓取**又发了图片请求** —— 轻资产模块的主要收益没兑现")
    assert acc.avatar_path == first_path
    hit = AS.lookup(db, AS.KIND_AVATAR, NEW_URL)
    assert hit is not None and hit.path == first_path, "索引里应当登记着这份本地副本"
    assert db.query(LocalAsset).count() == 1


def test_rotated_signature_costs_no_request_and_stays_one_version(db, monkeypatch):
    """② 真实样本：平台换了签名（同一张图）⇒ 不发请求，账本也不许多出版本。"""
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = _mk_acc(db, v, url=None, path=None)
    # ⚠️ 假抓取器要**建一次**再交给 `get_fetcher`：写成 `lambda p: _FakePf([...])` 的话
    #    每次调用都新建一个实例 ⇒ 它的 `n` 永远停在 0，"第二轮换了签名"根本不会发生
    #    （本用例的第一版就是这么假绿的 —— 断言全绿而场景没跑）。
    pf = _FakePf([OLD_URL, NEW_URL])
    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: pf)
    client = _CountingClient()

    asyncio.run(sch._fetch_one_account(acc, db, client=client))
    db.commit()
    first = acc.avatar_path
    assert len(client.calls) == 1
    assert len(_rows(db, v)) == 1

    asyncio.run(sch._fetch_one_account(acc, db, client=client))
    db.commit()
    assert len(client.calls) == 1, "换了签名就重新下载 —— 稳定键没生效"
    rows = _rows(db, v)
    assert len(rows) == 1, f"同一张图被记成了 {len(rows)} 个版本（应当按稳定键归并）"
    assert rows[0].avatar_url == NEW_URL, "行要跟到最近一次见到的 URL（选择器才给得出活地址）"
    assert rows[0].avatar_path == first, "归并后仍指着同一份本地文件"
    assert acc.avatar_path == first


def test_preexisting_same_key_rows_do_not_break_the_merge(db):
    """升级前可能已经存在"同一张图的两个签名各一行"⇒ 再记一次必须**安全**（不许撞唯一键）。

    这种老数据是真实存在的：R47 按**完整 URL** 记账，而微博每 3 小时换一次签名。
    归并改成按稳定键之后，若让某一行改写成另一行已有的 URL，就会撞
    `uq_vtuber_avatar_url`；`SessionLocal` 是 `autoflush=False` ⇒ 到 commit 才炸、整批回滚。

    ⚠️ 造样本时**故意**让"旧签名那行"排在列表最前（`first_seen_at` 更晚）：账本顺序与
    "哪个签名更新"本来就不保证一致，归并不能依赖顺序 —— 判据正是"先撞上的那行不是精确命中的
    那行时，也不许改写它的 URL"。
    """
    from datetime import datetime

    v = _mk_v(db)
    acc = _mk_acc(db, v, url=NEW_URL, path="static/avatars/weibo_7471118487_3d2b0b8a.jpg")
    VA.record_avatar_version(db, vtuber_id=v.id, account_id=acc.id, platform="weibo",
                             url=NEW_URL,
                             path="static/avatars/weibo_7471118487_3d2b0b8a.jpg")
    db.commit()
    db.add(VtuberAvatarHistory(vtuber_id=v.id, account_id=acc.id, platform="weibo",
                               avatar_url=OLD_URL,
                               avatar_path="static/avatars/weibo_7471118487.jpg",
                               first_seen_at=datetime(2030, 1, 1)))    # L1 之前留下的那一行
    db.commit()
    assert [r.avatar_url for r in _rows(db, v)][0] == OLD_URL, "前提：旧签名那行排在列表最前"

    VA.record_avatar_version(db, vtuber_id=v.id, account_id=acc.id, platform="weibo",
                             url=NEW_URL,
                             path="static/avatars/weibo_7471118487_3d2b0b8a.jpg")
    db.commit()      # ← 撞唯一键的话这里就炸（整批抓取回滚的那种事故形态）

    rows = _rows(db, v)
    assert len(rows) == 2, "老数据本批不动（L4 才按 sha256 合并），但也不许多插一行"
    assert [r.avatar_url for r in rows].count(NEW_URL) == 1, "同一行 URL 出现两次（撞唯一键的前夜）"
    assert [r.avatar_url for r in rows].count(OLD_URL) == 1, "旧签名那行的 URL 被改写了"


def test_selected_avatar_version_keeps_its_own_url(db, monkeypatch):
    """归并时**当前选中的那条**不许被改 URL。

    为什么：`vtubers.avatar`（用户的选择）与账本行的 `avatar_url` 是"当前用的是哪张"的
    两侧真源，只有**字符串相等**才对得上。把行改成新签名 ⇒ 选择器里"当前"这一项会消失
    （而卡片还在用它）。过期 URL 的渲染由 `avatar_local` 兜底（A0 那条链）。
    """
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = _mk_acc(db, v, url=OLD_URL, path="static/avatars/weibo_7471118487.jpg")
    VA.record_avatar_version(db, vtuber_id=v.id, account_id=acc.id, platform="weibo",
                             url=OLD_URL, path="static/avatars/weibo_7471118487.jpg")
    v.avatar = OLD_URL                      # 用户已经选了这张
    db.commit()

    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: _FakePf([NEW_URL]))
    client = _CountingClient()
    asyncio.run(sch._fetch_one_account(acc, db, client=client))
    db.commit()

    rows = _rows(db, v)
    assert len(rows) == 1
    assert rows[0].avatar_url == OLD_URL, (
        "当前选中的那条被改成了新签名的 URL —— 账本与 `vtubers.avatar` 从此对不上")


def test_deleted_local_copy_is_downloaded_again(db, monkeypatch):
    """判据④ 端到端：索引说有、盘上没有 ⇒ 当未命中并**自动补下**（不许永远缺下去）。"""
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = _mk_acc(db, v, url=None, path=None)
    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: _FakePf([NEW_URL]))
    client = _CountingClient()

    asyncio.run(sch._fetch_one_account(acc, db, client=client))
    db.commit()
    assert len(client.calls) == 1
    local = Path(AS.abs_path(acc.avatar_path))       # Data_DIR 已被 conftest 指到 tmp
    local.unlink()

    asyncio.run(sch._fetch_one_account(acc, db, client=client))
    db.commit()
    assert len(client.calls) == 2, "盘上那份没了却没补下（用户会看到破图）"
    assert local.exists()
    assert db.query(LocalAsset).count() == 1, "补下不许留下两条索引"


def test_selecting_an_avatar_pins_its_asset(db, client):
    """③ 用户选过的那张 ⇒ `local_assets.pinned=1`（清理时永不动它）。"""
    v = _mk_v(db)
    row = AS.put(db, AS.KIND_AVATAR, NEW_URL, b"IMG-BYTES", hint="weibo_w1")
    db.commit()
    assert row.pinned is False

    resp = client.put(f"/vtuber/{v.id}", json={"avatar": NEW_URL})
    assert resp.status_code == 200
    assert resp.json()["avatar_local"] == row.path

    db.expire_all()
    assert db.get(LocalAsset, row.id).pinned is True, "用户选过的头像没有被打上 pin"


def test_avatar_local_is_derived_from_the_assets_index(db, client):
    """A0 的派生换了来源：先查**资产索引**（稳定键），账本/账号降为兜底。"""
    v = _mk_v(db)
    row = AS.put(db, AS.KIND_AVATAR, NEW_URL, b"IMG-BYTES", hint="weibo_w1")
    v.avatar = NEW_URL
    db.commit()

    got = client.get(f"/vtuber/{v.id}").json()
    assert got["avatar_local"] == row.path, (
        "资产索引里明明有这一份，派生却没用它")
    assert got["avatar"] == NEW_URL, "`avatar` 的语义不许动（仍是远端原文）"
    # 账本/账号都不认识它 ⇒ 说明这一条确实是索引给出来的
    assert db.query(VtuberAvatarHistory).count() == 0
