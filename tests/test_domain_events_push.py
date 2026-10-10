# -*- coding: utf-8 -*-
"""领域事件改推送（M3，devlog/246；方案 §M3）—— **逐个换**，本文件是第一个：账号快照。

## 为什么先换这一个

方案 §M3 说"三类事件逐个来，不要一次全换"，并点名 `domain.vtuber.updated` 风险最高
（它碰的是 **R33 那条事故路径**：右栏改了签名要通知左栏）。账号快照的风险最低，因为：

- 后端**已经有**那条快照（`_push_account_snapshot` 本来就在喂状态通道的 `recent` 环）；
- 前端**已经在听**同一个事件（`EVENTS.accountProgress`，载荷形状也一样：数组）
  ⇒ **消费侧一行不动**（这正是本方案的关键好处：换的只是触发源）。

## 判据

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | 账号抓取提交后 ⇒ 一条 `domain.account.snapshot`，payload 就是那七个字段 | 左右栏还得等 3–10s 轮询 |
| ② | **失败/回滚**的那一次不发（发布点在 `db.commit()` 之后） | 收到"从未发生过"的字段 |
| ③ | 一次抓取**恰好一条**（不是每个字段一条） | 前端被刷屏 |
| ④ | `platform_uid` 一律**字符串**（与 `accounts.platform_uid` 口径一致） | 侧栏按 uid 匹配不上 ⇒ 静默不合并 |

⚠️ ③ 的对照在 `tests/test_messages.py` 那一侧（消息进的是 hub 的环形缓冲，不是日志）。
"""
from __future__ import annotations

import asyncio
import atexit
import shutil
import tempfile
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, VTuber
from app.services import messages as M

ROOT = Path(__file__).resolve().parent.parent

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-snap-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'snap.db').as_posix()}",
                        connect_args={"check_same_thread": False})
_Session = sessionmaker(bind=_engine, autoflush=False, autocommit=False)


@pytest.fixture(autouse=True)
def _schema():
    Base.metadata.create_all(bind=_engine)
    yield
    Base.metadata.drop_all(bind=_engine)


@pytest.fixture
def db():
    s = _Session()
    yield s
    s.close()


@pytest.fixture(autouse=True)
def _fresh_hub(monkeypatch):
    hub = M.MessageHub()
    monkeypatch.setattr(M, "HUB", hub)
    return hub


def _mk_account(db, *, uid="11073", name="快照V", followers=7) -> Account:
    v = VTuber(name=name)
    db.add(v)
    db.commit()
    db.refresh(v)
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid,
                  display_name=name, followers_count=followers)
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return acc


def _snaps(hub) -> list[M.Message]:
    return [m for m in hub.replay_since(0) if m.type == M.MSG_ACCOUNT_SNAPSHOT]


# ── ① 摘出来的那条快照就是前端要的载荷 ────────────────────────────────────

def test_snapshot_is_published_with_the_frontend_payload(db, _fresh_hub):
    from app.services import scheduler as sch
    acc = _mk_account(db, followers=12345)
    acc.live_status = 1
    acc.live_title = "今晚八点"
    db.commit()

    sch._push_account_snapshot(acc)

    got = _snaps(_fresh_hub)
    assert len(got) == 1, f"应当恰好一条，实际 {len(got)}"
    p = got[0].payload
    # 与 `frontend/src/api/types.ts::AccountSnapshot` 逐字对应（前端 `parseSnapshot` 会校验）
    assert set(p) == {"platform", "platform_uid", "display_name", "sign", "followers_count",
                      "live_status", "live_title", "avatar_path"}, sorted(p)
    assert p["platform"] == "bilibili", "身份是 `platform:platform_uid` 两半，缺一半就认错人"
    assert p["platform_uid"] == "11073"
    assert p["followers_count"] == 12345
    assert p["live_status"] == 1 and p["live_title"] == "今晚八点"


def test_snapshot_fields_match_the_frontend_list(db, _fresh_hub):
    """payload 的键必须与前端 `messageBus.ts::SNAPSHOT_FIELDS` **逐字一致**（跨语言契约）。

    为什么这条比"类型对不对"重要：前端 `parseSnapshot` 缺一个键就**整条丢弃**
    （不发半个事件）⇒ 两边漂了的症状是"推送静默失效"，而那看起来像"后端根本没推"。
    反向验证：从前端那份列表里删掉一个字段 ⇒ 本用例红。
    """
    import re

    from app.services import scheduler as sch

    acc = _mk_account(db)
    sch._push_account_snapshot(acc)
    backend_keys = set(_snaps(_fresh_hub)[0].payload)

    ts = (ROOT / "frontend/src/utils/messageBus.ts").read_text(encoding="utf-8")
    head = ts.index("const SNAPSHOT_FIELDS")
    block = ts[head:ts.index("] as const", head)]
    front_keys = set(re.findall(r"'([a-z_]+)'", block))
    assert front_keys, "没从前端源码里解析出 SNAPSHOT_FIELDS（正则漂了？）"
    assert backend_keys == front_keys, (
        f"两边字段漂了：后端多 {backend_keys - front_keys} / 前端多 {front_keys - backend_keys}"
        f"（前端会因此**整条丢弃**推送来的快照）"
    )


def test_snapshot_and_status_ring_are_the_same_object(db, _fresh_hub):
    """两条通道（推送 / 轮询 `recent`）发的必须是**同一份**内容 —— 否则"并存"会打架。"""
    from app.services import scheduler as sch
    acc = _mk_account(db)
    sch._push_account_snapshot(acc)
    sch._status["account"]["recent"] = []          # 清掉，避免上一个用例的残留干扰
    sch._push_account_snapshot(acc)
    recent = sch._status["account"]["recent"]
    assert recent and recent[-1] == _snaps(_fresh_hub)[-1].payload


# ── ② 失败的那次不发 ─────────────────────────────────────────────────────

def test_posts_round_publishes_one_message_with_the_same_payload(db, _fresh_hub):
    """一轮帖子抓取收尾 ⇒ 一条 `domain.posts.changed`，与状态通道**同一份内容**（含轮次 `seq`）。

    两条通道发同一份、带同一个 `seq` ⇒ 前端能凭它认出"这是同一轮"（`withoutAlreadyPushedPosts`），
    于是"推送与轮询并存"不会刷两次。
    """
    from app.services import scheduler as sch

    sch._set_post_last_result(7, "quick", "某V", 3, 5, 8, 1, [], None)

    got = [m for m in _fresh_hub.replay_since(0) if m.type == M.MSG_POSTS_CHANGED]
    assert len(got) == 1, f"一轮应当恰好一条，实际 {len(got)}"
    assert got[0].payload == sch._status["post"]["last_result"], \
        "推送与轮询发的必须是同一份内容（否则前端没法按 seq 去重）"
    assert got[0].payload["seq"] == 7 and got[0].payload["stored"] == 8


def test_no_posts_message_when_the_fetch_fails(db, monkeypatch, _fresh_hub):
    """抓取失败（结果对象为 None）⇒ 不写 `last_result` ⇒ **没有消息**。"""
    from app.services import scheduler as sch

    async def _fake_core(**kwargs):
        return None

    monkeypatch.setattr(sch, "_fetch_posts_core", _fake_core, raising=False)
    monkeypatch.setattr(sch, "archive_old_posts", lambda **kw: 0, raising=False)

    asyncio.run(sch.async_fetch_posts("bilibili", "11073", 1, 1))

    assert [m for m in _fresh_hub.replay_since(0)
            if m.type == M.MSG_POSTS_CHANGED] == []


def test_no_snapshot_when_the_account_fetch_fails(db, monkeypatch, _fresh_hub):
    """上游失败 ⇒ 不写快照 ⇒ **没有消息**（发布点在提交之后，失败路径根本到不了它）。"""
    from app.services import scheduler as sch

    async def _fail(acc, db_, *, client=None, pending_avatar=None):
        return False                      # 抓取失败：拿不到字段，也就不该发快照

    monkeypatch.setattr(sch, "_fetch_one_account", _fail)
    # ⚠️ `async_fetch_accounts` 会**自己开 `SessionLocal()`**（走真实数据目录）——
    #    本地开发库恰好有表、CI 干净克隆没有 ⇒ 症状是 "no such table: accounts"
    #    （devlog/240 同一个坑：**本地绿、CI 红不一定是版本差异，也可能是本地恰好有状态**）。
    monkeypatch.setattr(sch, "SessionLocal", lambda: db)
    acc = _mk_account(db)

    asyncio.run(sch.async_fetch_accounts([acc.id], label="单测"))

    assert _snaps(_fresh_hub) == [], "失败的那次不该发快照（否则前端会显示一个没发生过的字段）"


# ── ③④ 一次抓取恰好一条 + uid 一律字符串 ────────────────────────────────

def test_one_snapshot_per_account_with_string_uid(db, monkeypatch, _fresh_hub):
    """成功抓一个账号 ⇒ **恰好一条**快照，`platform_uid` 是字符串。"""
    from app.services import scheduler as sch

    class _Fresh:
        platform_uid = "11073"
        display_name = "抓到的名字"
        sign = "新签名"
        followers_count = 999
        live_status = 0
        live_title = None
        avatar_path = None

    async def _fake_fetch(acc, db_, *, client=None, pending_avatar=None):
        for k, v in vars(_Fresh).items():
            if not k.startswith("_"):
                setattr(acc, k, v)
        return True

    monkeypatch.setattr(sch, "_fetch_one_account", _fake_fetch, raising=False)
    monkeypatch.setattr(sch, "SessionLocal", lambda: db)   # 同上：别让它开真实数据目录的会话
    acc = _mk_account(db)
    asyncio.run(sch.async_fetch_accounts([acc.id], label="单测"))

    got = _snaps(_fresh_hub)
    assert len(got) == 1, f"一个账号应当恰好一条快照，实际 {len(got)}"
    assert got[0].payload["display_name"] == "抓到的名字"
    assert isinstance(got[0].payload["platform_uid"], str)
