# -*- coding: utf-8 -*-
"""帖子媒体固化 + 归档自动清理（2026-10-04，devlog/319）。

方案 `docs/plans/media-pinning-execution.md` 批次 1。用户口径：「不论什么平台，未归档的帖子
都可以作为轻资产固定下来，已归档的部分就自动移除」。

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | 未归档帖的正文图固化到 `static/assets/post_image/` + 索引行 | 图床签名过期后详情页一片灰（这才是做它的理由） |
| ② | 已经固化过的**第二轮零请求** | 每轮重下全部媒体 —— 收益归零（照抄封面那条） |
| ③ | 只固化**时间窗内**的未归档帖；窗 = 0 表示不限 | 几万条老帖把磁盘吃满（用户要的"未归档时长"就是它） |
| ④ | **视频默认不固化**；开了才固化，且只认单文件直链 | 默认就把几十上百 MB/条的视频拖下来 |
| ⑤ | 帖子归档后 `clean_archived` **删行 + 删文件**；开关关掉则一条不删 | 用户口径里的"已归档的部分自动移除"没实现 / 用户关不掉 |
| ⑥ | **未归档**帖引用的媒体即使没 pin 也**不许**被清 | 清理误删用户正看着的图（不可接受） |
| ⑦ | `PostOut.images_local` 与 `body_json.images` **同序同长**，且批量派生 | 前端按索引对不上 / 列表页 N+1 |

⚠️ "零请求"这类断言一律配**正对照**（先证明本来会发，再证明这次没发）。
"""
from __future__ import annotations

import asyncio
import atexit
import json
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
from app.services import media_pin as mp

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-media-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'media.db').as_posix()}",
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


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    """每个用例都从"默认设置"出发（开关/窗口/视频都要能单独改）。"""
    monkeypatch.setattr(mp.settings, "MEDIA_PIN_ENABLED", True, raising=False)
    monkeypatch.setattr(mp.settings, "MEDIA_PIN_MAX_AGE_DAYS", 30.0, raising=False)
    monkeypatch.setattr(mp.settings, "MEDIA_PIN_VIDEO", False, raising=False)
    monkeypatch.setattr(mp.settings, "MEDIA_PIN_CLEAN_ARCHIVED", True, raising=False)


class _Resp:
    def __init__(self, status: int = 200, body: bytes = b"IMG"):
        self.status_code, self.content = status, body


class _CountingClient:
    def __init__(self, body: bytes = b"IMG"):
        self.body, self.calls = body, []

    async def get(self, url: str) -> _Resp:
        self.calls.append(url)
        return _Resp(200, self.body)

    async def aclose(self) -> None:
        pass


def _mk_acc(db, uid="11073") -> Account:
    v = VTuber(name="媒体V")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="xiaohongshu", platform_uid=uid, followers_count=0)
    db.add(acc)
    db.commit()
    return acc


def _body(images=(), video: str | None = None) -> str:
    d: dict = {"text": "正文"}
    if images:
        d["images"] = [{"url": u} for u in images]
    if video:
        d["video"] = {"url": video, "fallbacks": [video + "?bak=1"]}
    return json.dumps(d, ensure_ascii=False)


def _mk_post(db, acc, pid: str, *, images=(), video: str | None = None,
             archived=False, published: datetime | None = None) -> Post:
    p = Post(platform=acc.platform, platform_uid=acc.platform_uid, platform_post_id=pid,
             type="note", title=f"帖{pid}", is_archived=archived,
             body_json=_body(images, video),
             published_at=published or assets._now())
    db.add(p)
    db.commit()
    return p


def _files(data_dir: Path, kind: str) -> list[Path]:
    root = data_dir / "static" / "assets" / kind
    return sorted(p for p in root.rglob("*") if p.is_file()) if root.exists() else []


# ── ①②③④ 固化侧 ──────────────────────────────────────────────────────

def test_pins_images_of_unarchived_posts(db, data_dir):
    """① 未归档帖的正文图落盘 + 入索引（正对照：确实发了请求）。"""
    acc = _mk_acc(db)
    _mk_post(db, acc, "p1", images=["https://sns-webpic-qc.xhscdn.com/20261003/a/1.webp",
                                    "https://sns-webpic-qc.xhscdn.com/20261003/b/2.webp"])
    client = _CountingClient()

    out = asyncio.run(mp.pin_account_media(db, acc, client=client))

    assert out["images"] == 2, out
    assert len(client.calls) == 2
    assert len(_files(data_dir, assets.KIND_POST_IMAGE)) == 2
    assert db.query(LocalAsset).filter(LocalAsset.kind == assets.KIND_POST_IMAGE).count() == 2


def test_second_round_sends_no_request(db, data_dir):
    """② 固化过的一律命中稳定键 ⇒ 第二轮**一个请求都不发**（正对照：第一轮发）。"""
    acc = _mk_acc(db)
    _mk_post(db, acc, "p1", images=["https://sns-webpic-qc.xhscdn.com/20261003/a/1.webp"])
    client = _CountingClient()

    assert asyncio.run(mp.pin_account_media(db, acc, client=client))["images"] == 1
    assert len(client.calls) == 1, "正对照：第一次必须真的发一次"

    out = asyncio.run(mp.pin_account_media(db, acc, client=client))
    assert out["images"] == 0 and out["skipped"] == 1
    assert len(client.calls) == 1, "第二轮又下载了一遍 —— 稳定键命中没生效"


def test_only_unarchived_posts_are_pinned(db, data_dir):
    """归档帖不固化（它不在列表里滚）。"""
    acc = _mk_acc(db)
    _mk_post(db, acc, "arch", images=["https://x.hdslb.com/a.jpg"], archived=True)
    _mk_post(db, acc, "live", images=["https://x.hdslb.com/b.jpg"])
    client = _CountingClient()

    assert asyncio.run(mp.pin_account_media(db, acc, client=client))["images"] == 1
    assert client.calls == ["https://x.hdslb.com/b.jpg"]


def test_age_window_limits_what_gets_pinned(db, data_dir, monkeypatch):
    """③ "未归档时长"：窗口外的老帖不固化；窗口 = 0 表示**不限**。"""
    acc = _mk_acc(db)
    _mk_post(db, acc, "new", images=["https://x.hdslb.com/new.jpg"])
    _mk_post(db, acc, "old", images=["https://x.hdslb.com/old.jpg"],
             published=assets._now().replace(year=2020))
    client = _CountingClient()

    monkeypatch.setattr(mp.settings, "MEDIA_PIN_MAX_AGE_DAYS", 30.0, raising=False)
    assert asyncio.run(mp.pin_account_media(db, acc, client=client))["images"] == 1
    assert client.calls == ["https://x.hdslb.com/new.jpg"]

    client.calls.clear()
    monkeypatch.setattr(mp.settings, "MEDIA_PIN_MAX_AGE_DAYS", 0.0, raising=False)
    assert asyncio.run(mp.pin_account_media(db, acc, client=client))["images"] == 1
    assert client.calls == ["https://x.hdslb.com/old.jpg"], "0 = 不限，老帖也该固化"


def test_setting_off_sends_no_request(db, data_dir, monkeypatch):
    """④′ 总开关关掉 ⇒ 一个请求都不发（正对照：开着时必须发）。"""
    acc = _mk_acc(db)
    _mk_post(db, acc, "p1", images=["https://x.hdslb.com/a.jpg"])
    client = _CountingClient()

    monkeypatch.setattr(mp.settings, "MEDIA_PIN_ENABLED", False, raising=False)
    out = asyncio.run(mp.pin_account_media(db, acc, client=client))
    assert out["images"] == 0 and out["reason"]
    assert client.calls == []
    assert _files(data_dir, assets.KIND_POST_IMAGE) == []

    monkeypatch.setattr(mp.settings, "MEDIA_PIN_ENABLED", True, raising=False)
    assert asyncio.run(mp.pin_account_media(db, acc, client=client))["images"] == 1


def test_video_is_opt_in_and_capped(db, data_dir, monkeypatch):
    """④ 视频**默认不固化**；开了才固化，且超过单文件上限就跳过（不落半截）。"""
    acc = _mk_acc(db)
    vid = "https://sns-video-qc.xhscdn.com/20261003/v.mp4"
    _mk_post(db, acc, "p1", images=["https://x.hdslb.com/a.jpg"], video=vid)
    client = _CountingClient()

    out = asyncio.run(mp.pin_account_media(db, acc, client=client))
    assert out["images"] == 1 and out["videos"] == 0
    assert client.calls == ["https://x.hdslb.com/a.jpg"], "默认不该去碰视频"

    client.calls.clear()
    monkeypatch.setattr(mp.settings, "MEDIA_PIN_VIDEO", True, raising=False)
    out = asyncio.run(mp.pin_account_media(db, acc, client=client))
    assert out["videos"] == 1, out
    assert client.calls == [vid], "打开后应当只取 video.url 那一条（fallback 链不重复下）"
    assert len(_files(data_dir, assets.KIND_POST_VIDEO)) == 1

    # 超大视频：跳过并记账，不留半截文件
    monkeypatch.setattr(assets, "MAX_VIDEO_BYTES", 4, raising=False)
    client.calls.clear()
    acc2 = _mk_acc(db, uid="999")
    _mk_post(db, acc2, "big", video="https://sns-video-qc.xhscdn.com/20261003/big.mp4")
    out = asyncio.run(mp.pin_account_media(db, acc2, client=_CountingClient(b"x" * 64)))
    assert out["videos"] == 0 and out["skipped"] == 1
    assert _files(data_dir, assets.KIND_POST_VIDEO) == [] or \
        len(_files(data_dir, assets.KIND_POST_VIDEO)) == 1     # 只有前一个用例那份


# ── ⑤⑥ 归档清理与保护 ─────────────────────────────────────────────────

def test_clean_archived_removes_only_archived(db, data_dir):
    """⑤ 帖子归档后：**它的**副本被删（行 + 文件），未归档那条留着（⑥）。"""
    acc = _mk_acc(db)
    live = _mk_post(db, acc, "live", images=["https://x.hdslb.com/keep.jpg"])
    gone = _mk_post(db, acc, "gone", images=["https://x.hdslb.com/drop.jpg"])
    client = _CountingClient()
    assert asyncio.run(mp.pin_account_media(db, acc, client=client))["images"] == 2
    assert len(_files(data_dir, assets.KIND_POST_IMAGE)) == 2

    # 归档其中一条 ⇒ 下一次清理应当只删它
    gone.is_archived = True
    db.commit()
    report = mp.clean_archived(db, dry_run=False)
    db.commit()

    left = {r.key for r in db.query(LocalAsset).filter(
        LocalAsset.kind == assets.KIND_POST_IMAGE)}
    assert assets.key_of("https://x.hdslb.com/keep.jpg") in left, \
        "未归档帖的媒体被清掉了（用户正看着的图会破）"
    assert assets.key_of("https://x.hdslb.com/drop.jpg") not in left, "归档帖的副本该清却没清"
    assert report["kinds"][assets.KIND_POST_IMAGE]["evicted"], "报告里要记下删了什么"
    assert len(_files(data_dir, assets.KIND_POST_IMAGE)) == 1, "文件也要跟着删（只删行会只增不减）"
    assert live.id


def test_clean_archived_can_be_switched_off(db, data_dir, monkeypatch):
    """⑤′ 关掉开关 ⇒ **一条都不删**（正对照：开着时必须删）。"""
    acc = _mk_acc(db)
    p = _mk_post(db, acc, "gone", images=["https://x.hdslb.com/drop.jpg"], archived=True)
    asyncio.run(mp.pin_account_media(db, acc, client=_CountingClient()))
    # 归档帖不固化 ⇒ 手工造一份"归档帖的副本"（模拟它归档之前固化的那份）
    assets.put(db, assets.KIND_POST_IMAGE, "https://x.hdslb.com/drop.jpg", b"IMG", hint=str(p.id))
    db.commit()

    monkeypatch.setattr(mp.settings, "MEDIA_PIN_CLEAN_ARCHIVED", False, raising=False)
    out = mp.clean_archived(db)
    assert out.get("skipped"), out
    assert db.query(LocalAsset).filter(LocalAsset.kind == assets.KIND_POST_IMAGE).count() == 1

    monkeypatch.setattr(mp.settings, "MEDIA_PIN_CLEAN_ARCHIVED", True, raising=False)
    mp.clean_archived(db, dry_run=False)
    db.commit()
    assert db.query(LocalAsset).filter(LocalAsset.kind == assets.KIND_POST_IMAGE).count() == 0


def test_dry_run_reports_without_deleting(db, data_dir):
    """设置页的"将要清理"必须与真删**同一个集合**（dry-run 不删东西）。"""
    acc = _mk_acc(db)
    p = _mk_post(db, acc, "gone", images=["https://x.hdslb.com/drop.jpg"], archived=True)
    assets.put(db, assets.KIND_POST_IMAGE, "https://x.hdslb.com/drop.jpg", b"IMG", hint=str(p.id))
    db.commit()

    report = mp.clean_archived(db, dry_run=True)
    assert report["kinds"][assets.KIND_POST_IMAGE]["evicted"]
    assert db.query(LocalAsset).filter(LocalAsset.kind == assets.KIND_POST_IMAGE).count() == 1
    assert len(_files(data_dir, assets.KIND_POST_IMAGE)) == 1


def test_download_failure_does_not_break_the_round(db, data_dir):
    """单张失败只跳过（固化是顺路做的事，不许拖垮整轮抓取）。"""

    class _Flaky(_CountingClient):
        async def get(self, url: str) -> _Resp:
            self.calls.append(url)
            if url.endswith("bad.jpg"):
                raise RuntimeError("图床挂了")
            return _Resp(200, b"IMG")

    acc = _mk_acc(db)
    _mk_post(db, acc, "p", images=["https://x.hdslb.com/bad.jpg", "https://x.hdslb.com/ok.jpg"])

    out = asyncio.run(mp.pin_account_media(db, acc, client=_Flaky()))
    assert out["images"] == 1 and out["skipped"] == 1
    assert len(_files(data_dir, assets.KIND_POST_IMAGE)) == 1


def test_pin_post_media_pins_only_that_post(db, data_dir):
    """单帖固化（重取之后顺手做的那一步）：只碰这一帖，且**命中就零请求**。"""
    acc = _mk_acc(db)
    p1 = _mk_post(db, acc, "p1", images=["https://x.hdslb.com/1.jpg"])
    _mk_post(db, acc, "p2", images=["https://x.hdslb.com/2.jpg"])
    client = _CountingClient()

    out = asyncio.run(mp.pin_post_media(db, p1, client=client))
    assert out["images"] == 1
    assert client.calls == ["https://x.hdslb.com/1.jpg"], "只该碰这一帖的媒体"

    client.calls.clear()
    assert asyncio.run(mp.pin_post_media(db, p1, client=client))["images"] == 0
    assert client.calls == [], "已经固化过还发请求 = 稳定键命中没生效"


def test_pin_post_media_skips_archived_posts(db, data_dir):
    """已归档的帖**一个请求都不发**：保护名单只认未归档帖 ⇒ 下了也会被下次清理删掉。

    重取本身照常（用户正开着这一帖，新地址照样能画出来），只是不落盘。
    """
    acc = _mk_acc(db)
    p = _mk_post(db, acc, "p-arch", images=["https://x.hdslb.com/old.jpg"], archived=True)
    client = _CountingClient()

    out = asyncio.run(mp.pin_post_media(db, p, client=client))
    assert client.calls == [], "归档帖不该下载（下完就被归档清理删掉，纯属白跑）"
    assert out["images"] == 0 and "归档" in out["reason"]
    assert _files(data_dir, assets.KIND_POST_IMAGE) == []


def test_post_outs_carry_images_local_in_order(db):
    """⑦ `images_local` 与 `body_json.images` **同序同长**（没有副本的位置是空串）。"""
    from app.routers.vtuber import _post_outs

    acc = _mk_acc(db)
    a, b, c = ("https://x.hdslb.com/a.jpg", "https://x.hdslb.com/b.jpg",
               "https://x.hdslb.com/c.jpg")
    p = _mk_post(db, acc, "p1", images=[a, b, c])
    assets.put(db, assets.KIND_POST_IMAGE, b, b"IMG", hint=str(p.id))   # 只有中间那张有副本
    db.commit()

    out = _post_outs(db, db.query(Post).all())[0]
    assert len(out.images_local) == 3, "长度必须与 images 一致（前端按索引对齐）"
    assert out.images_local[0] == "" and out.images_local[2] == ""
    assert out.images_local[1], "有副本的那一张要给出路径"
    assert out.images_local[1].startswith(assets.REL_ROOT)


def test_images_local_lookup_is_batched(db):
    """⑦′ 派生**不许 N+1**：页大小翻倍而查询数不变（照抄封面那条判据）。"""
    from sqlalchemy import event

    from app.routers.vtuber import _post_outs

    acc = _mk_acc(db)

    def _seed(n: int) -> None:
        for i in range(n):
            _mk_post(db, acc, f"n{n}-{i}", images=[f"https://x.hdslb.com/n{n}-{i}.jpg"])

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
        assert all(len(o.images_local) == 1 for o in outs)
        return len(stmts)

    _seed(2)
    few = _count()
    _seed(6)
    many = _count()
    assert many <= few + 2, f"派生把查询数从 {few} 涨到 {many} —— 这是 N+1（页越大越慢）"
