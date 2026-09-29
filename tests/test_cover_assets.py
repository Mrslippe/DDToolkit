# -*- coding: utf-8 -*-
"""未归档帖封面固化 + `cover_local`（L3，devlog/261）。

规格 `docs/design-light-assets.md` §3.3；执行方案 §L3。

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | 一轮固化的**新增**数量 ≤ `COVER_PIN_PER_ROUND` | 一轮抓取被"顺手做的小事"拖长（还可能惹上游） |
| ② | 同一帖**第二轮不再下载**（稳定键命中 ⇒ 零请求） | 每轮都把全部封面重下一遍 —— 收益归零 |
| ③ | 只固化 **`is_archived=0`** 的帖 | 归档帖占满磁盘上限，把有用的挤掉 |
| ④ | 设置项 `PIN_POST_COVERS=false` ⇒ **一个请求都不发**（正对照：开着时必须发） | 用户关不掉这个行为 |
| ⑤ | 列表端点 `cover_local` 与 `cover_url` **同时给出**，且**不产生逐帖查询** | 列表页 N+1（一页 200 帖 = 200 次往返） |
| ⑥ | 渲染口径：**本地优先**（与头像相反） | 远端被防盗链拦时列表一片空白 |

⚠️ "不再下载"/"零请求"这类断言一律配**正对照**（先证明本来会发，再证明这次没发）。
"""
from __future__ import annotations

import asyncio
import atexit
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, LocalAsset, Post, VTuber
from app.services import assets
from app.services import scheduler as sch

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-cover-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'cover.db').as_posix()}",
                        connect_args={"check_same_thread": False})
_Session = sessionmaker(bind=_engine, autoflush=False, autocommit=False)


@pytest.fixture
def db():
    Base.metadata.create_all(bind=_engine)
    s = _Session()
    yield s
    s.close()
    Base.metadata.drop_all(bind=_engine)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(assets, "data_root", lambda: tmp_path)
    return tmp_path


class _Resp:
    def __init__(self, status: int = 200, body: bytes = b"COVER"):
        self.status_code, self.content = status, body


class _CountingClient:
    """只记图片请求的假客户端（形状与真身一致：`await get(url)` / `status_code` / `content`）。"""

    def __init__(self, body: bytes = b"COVER"):
        self.body, self.calls = body, []

    async def get(self, url: str) -> _Resp:
        self.calls.append(url)
        return _Resp(200, self.body)

    async def aclose(self) -> None:
        pass


def _mk_acc(db, uid="11073") -> Account:
    v = VTuber(name="封面V")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid, followers_count=0)
    db.add(acc)
    db.commit()
    return acc


def _mk_post(db, acc, pid: str, cover: str | None, *, archived=False,
             published: datetime | None = None) -> Post:
    p = Post(platform=acc.platform, platform_uid=acc.platform_uid, platform_post_id=pid,
             type="video", title=f"帖{pid}", cover_url=cover, is_archived=archived,
             published_at=published or datetime(2026, 9, 29, 12, 0, 0))
    db.add(p)
    db.commit()
    return p


def _covers(data_dir: Path) -> list[Path]:
    root = data_dir / "static" / "assets" / assets.KIND_COVER
    return sorted(p for p in root.rglob("*") if p.is_file()) if root.exists() else []


# ── ①②③ 抓取侧 ────────────────────────────────────────────────────────

def test_pins_at_most_the_per_round_cap(db, data_dir):
    """① 一轮最多新增 `COVER_PIN_PER_ROUND` 张（正对照：这批确实该发请求）。"""
    acc = _mk_acc(db)
    for i in range(sch.COVER_PIN_PER_ROUND + 5):
        _mk_post(db, acc, f"p{i}", f"https://i0.hdslb.com/bfs/archive/c{i}.jpg")
    client = _CountingClient()

    added = asyncio.run(sch._pin_account_covers(db, acc, client=client))

    assert added == sch.COVER_PIN_PER_ROUND, f"应当固化到上限，实际 {added}"
    assert len(client.calls) == sch.COVER_PIN_PER_ROUND, "正对照：这批应当各发一次请求"
    assert len(_covers(data_dir)) == sch.COVER_PIN_PER_ROUND
    assert db.query(LocalAsset).filter(LocalAsset.kind == assets.KIND_COVER).count() == \
        sch.COVER_PIN_PER_ROUND


def test_second_round_downloads_nothing(db, data_dir):
    """② 已经固化过的**一个请求都不发**（正对照：第一轮必须发）。"""
    acc = _mk_acc(db)
    _mk_post(db, acc, "p1", "https://i0.hdslb.com/bfs/archive/a.jpg")
    client = _CountingClient()

    assert asyncio.run(sch._pin_account_covers(db, acc, client=client)) == 1
    assert len(client.calls) == 1, "正对照：第一次必须真的发一次"

    assert asyncio.run(sch._pin_account_covers(db, acc, client=client)) == 0
    assert len(client.calls) == 1, "第二轮又下载了一遍 —— 稳定键命中没生效"
    assert len(_covers(data_dir)) == 1, "同一张封面存了两份"


def test_round_stops_at_the_byte_cap(db, data_dir):
    """①′ 条数没到、字节先到 ⇒ 停（**实测**：B 站原图封面平均 1.1 MB，最坏单张 4.7 MB
    ⇒ 只按张数封顶的话一轮最坏能下 90+ MB）。"""
    acc = _mk_acc(db)
    for i in range(sch.COVER_PIN_PER_ROUND):
        _mk_post(db, acc, f"big{i}", f"https://i0.hdslb.com/bfs/archive/big{i}.jpg")
    body = b"x" * (9 * 1024 * 1024)          # 每张 9MB ⇒ 24MB 上限下最多 3 张
    client = _CountingClient(body)

    added = asyncio.run(sch._pin_account_covers(db, acc, client=client))

    assert added == 3, f"字节上限没生效（实际固化了 {added} 张 × 9MB）"
    assert len(client.calls) == 3, "超过字节上限之后还在发请求"


def test_only_unarchived_posts_are_pinned(db, data_dir):
    """③ 归档帖**不固化**（它不在列表里滚，没必要占地方）。"""
    acc = _mk_acc(db)
    _mk_post(db, acc, "arch", "https://i0.hdslb.com/bfs/archive/old.jpg", archived=True)
    _mk_post(db, acc, "live", "https://i0.hdslb.com/bfs/archive/new.jpg")
    client = _CountingClient()

    assert asyncio.run(sch._pin_account_covers(db, acc, client=client)) == 1
    assert client.calls == ["https://i0.hdslb.com/bfs/archive/new.jpg"]


def test_setting_off_sends_no_request(db, data_dir, monkeypatch):
    """④ 设置项关掉 ⇒ **一个请求都不发**（正对照：开着时必须发）。"""
    acc = _mk_acc(db)
    _mk_post(db, acc, "p1", "https://i0.hdslb.com/bfs/archive/a.jpg")
    client = _CountingClient()

    monkeypatch.setattr(sch.settings, "PIN_POST_COVERS", False, raising=False)
    assert asyncio.run(sch._pin_account_covers(db, acc, client=client)) == 0
    assert client.calls == [], "关掉了还在发请求"
    assert _covers(data_dir) == []

    # 正对照：同一份数据、开关打开 ⇒ 必须真的发
    monkeypatch.setattr(sch.settings, "PIN_POST_COVERS", True, raising=False)
    assert asyncio.run(sch._pin_account_covers(db, acc, client=client)) == 1
    assert len(client.calls) == 1


def test_download_failure_does_not_break_the_round(db, data_dir):
    """单张失败只跳过（固化是顺路的小事，不许把整轮抓取拖垮）。"""

    class _Flaky(_CountingClient):
        async def get(self, url: str) -> _Resp:
            self.calls.append(url)
            if url.endswith("bad.jpg"):
                raise RuntimeError("图床挂了")
            return _Resp(200, b"COVER")

    acc = _mk_acc(db)
    _mk_post(db, acc, "bad", "https://i0.hdslb.com/bfs/archive/bad.jpg",
             published=datetime(2026, 9, 29, 13, 0, 0))
    _mk_post(db, acc, "ok", "https://i0.hdslb.com/bfs/archive/ok.jpg")
    client = _Flaky()

    assert asyncio.run(sch._pin_account_covers(db, acc, client=client)) == 1
    assert len(_covers(data_dir)) == 1, "失败的那张不该留下半截文件"


# ── ⑤ 列表契约（一次批量派生）──────────────────────────────────────────

def test_post_outs_carry_cover_local_and_batch_the_lookup(db):
    """⑤ `cover_local` 与 `cover_url` 同时给出；查询数**与页大小无关**（不许 N+1）。"""
    from sqlalchemy import event

    from app.routers.vtuber import _post_outs

    acc = _mk_acc(db)

    def _seed(n: int) -> list[Post]:
        out = []
        for i in range(n):
            p = _mk_post(db, acc, f"n{n}-{i}", f"https://i0.hdslb.com/bfs/archive/n{n}-{i}.jpg")
            row = assets.put(db, assets.KIND_COVER, p.cover_url, b"COVER", hint=str(p.id))
            row.path = f"static/assets/cover/{p.id}_x.jpg"
            out.append(p)
        db.commit()
        return out

    def _count() -> int:
        stmts: list[str] = []
        eng = db.get_bind()

        def _rec(conn, cursor, statement, parameters, context, executemany):
            stmts.append(statement)

        event.listen(eng, "before_cursor_execute", _rec)
        try:
            outs = _post_outs(db, db.query(Post).all())
        finally:
            event.remove(eng, "before_cursor_execute", _rec)
        assert all(o.cover_url and o.cover_local for o in outs)
        return len(stmts)

    _seed(2)
    few = _count()
    _seed(6)                       # 再加 6 帖
    many = _count()
    assert many <= few + 1, f"派生把查询数从 {few} 涨到 {many} —— 这是 N+1（页越大越慢）"


def test_route_exposes_cover_local(db, client=None):
    """⑤′ 端点形状：`cover_local` 在回包里（前端按它决定"本地优先"）。"""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.core.database import get_db

    def _override():
        s = _Session()
        try:
            yield s
        finally:
            s.close()

    # ⚠️ **保存并还原**原来那个 override —— 不能 `pop` 掉！
    #    `tests/test_vtuber_api.py` 在**模块导入时**就把自己的 `override_get_db` 装进了
    #    `app.dependency_overrides`（跨用例的全局）。第一版这里直接 `pop(get_db)`，
    #    于是它被摘掉、后续 46 条用例的 TestClient 转去读**真实数据目录**的库
    #    （症状：`/vtuber/list` 返回 173 条真数据、`no such table: vtuber_avatar_history`）。
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override
    try:
        acc = _mk_acc(db, uid="777")
        p = _mk_post(db, acc, "r1", "https://i0.hdslb.com/bfs/archive/r1.jpg")
        assets.put(db, assets.KIND_COVER, p.cover_url, b"COVER", hint=str(p.id))
        db.commit()
        body = TestClient(app).get(f"/posts/{acc.platform}/{acc.platform_uid}").json()
        assert len(body) == 1
        assert body[0]["cover_url"] == p.cover_url, "`cover_url` 的语义不许动（仍是远端原文）"
        assert body[0]["cover_local"], "端点没给出本地副本路径 ⇒ 前端没法本地优先"
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous


# ── ⑥ prune 的引用保护（L3 补上的那一半）───────────────────────────────

def test_prune_protects_covers_of_unarchived_posts(db, data_dir):
    """未归档帖封面的副本**不许被清**（归档帖的可以）。"""
    acc = _mk_acc(db)
    keep = "https://i0.hdslb.com/bfs/archive/keep.jpg"
    drop = "https://i0.hdslb.com/bfs/archive/drop.jpg"
    assets.put(db, assets.KIND_COVER, keep, b"x" * 100, hint="1")
    assets.put(db, assets.KIND_COVER, drop, b"x" * 100, hint="2")
    db.commit()
    _mk_post(db, acc, "keep", keep)                          # 未归档 ⇒ 受保护
    _mk_post(db, acc, "drop", drop, archived=True)           # 归档 ⇒ 可清
    db.commit()

    report = assets.prune(db, assets.KIND_COVER, max_bytes=0, dry_run=False)
    left = {r.key for r in db.query(LocalAsset).filter(LocalAsset.kind == assets.KIND_COVER)}

    assert assets.key_of(keep) in left, "未归档帖的封面副本被清掉了（列表会破图）"
    assert assets.key_of(drop) not in left, "归档帖的封面副本该清却没清（引用保护过宽）"
    assert report["kinds"][assets.KIND_COVER]["evicted"], "报告里应当记下被清的那一份"
