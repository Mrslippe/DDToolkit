# -*- coding: utf-8 -*-
"""开播边沿的**面向用户出口**（M1，devlog/243；方案 `docs/design/notices/message-hub-execution.md` §M1）。

## 这一批不是"新造检测"，是"给它一个出口"

T0 早就分出了"开播"方向（`scheduler.py`：`edge = acc.live_status != prev_status`、
`started = bool(acc.live_status) and not prev_status`），但它的唯一消费者是
`note_dynamics_activity()`（把动态流恢复满速）⇒ **用户什么都看不到**。

## 四条判据（方案 §M1 的"先补的失败用例"）

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | `live_status` 0→1 ⇒ **一条** `domain.live.edge`，payload 是实体口径 | 开播没有通知 |
| ② | 非边沿（连着两轮都 1）⇒ **没有**消息 | 每轮 T0（60s）都播报一次 |
| ③ | 1→0（下播）⇒ 不产生"开播"消息 | 下播被播成开播 |
| ④ | **事务回滚时没有消息**（方案 §2.2 的必测） | 订阅者收到一条"从未发生过"的事件 |

另有两条随本批一起钉住：`note_dynamics_activity` 的既有行为不变（回归），
以及"同一轮多个账号开播 ⇒ 每个一条"（T0 是批量接口，一轮里可能好几个）。
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
from app.services.platforms import bilibili as bili_mod

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-liveedge-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'live.db').as_posix()}",
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
    """每个用例一个干净 hub（模块级单例是**生产**用的）。

    ⚠️ 判据取"hub 里有没有这条消息"，而**不**去插桩 `HUB.publish` ——
    插桩只能证明"有人调了函数"，证明不了"消息真的进了通道"（那正是 M0 的判据范围）。
    """
    hub = M.MessageHub()
    monkeypatch.setattr(M, "HUB", hub)
    return hub


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    """T0 的批间等待压到 0（真值 5–15s；不压本文件要跑几十秒）。"""
    from app.services import scheduler as sch
    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MIN", 0.0)
    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MAX", 0.0)
    return sch


def _stub_batch(monkeypatch, live_status: int, title: str = "今晚开播"):
    """把平台适配器底下的批量接口换成替身（走的是真适配器 → 真核心）。"""
    async def fake_batch(mids, client=None):
        return {str(m): {"live_status": live_status, "live_title": title,
                         "room_id": "123", "live_url": "https://live.bilibili.com/123"}
                for m in mids}

    monkeypatch.setattr(bili_mod, "fetch_bilibili_live_batch", fake_batch)


def _mk_account(db, *, uid: str = "11073", live_status: int = 0, title: str = "旧标题") -> Account:
    v = VTuber(name="开播V")
    db.add(v)
    db.commit()
    db.refresh(v)
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid,
                  display_name="开播V", followers_count=7,
                  live_status=live_status, live_title=title)
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return acc


def _edges(hub) -> list[M.Message]:
    return [m for m in hub.replay_since(0) if m.type == M.MSG_LIVE_EDGE]


# ── ① 开播 ⇒ 一条消息 ────────────────────────────────────────────────────

def test_live_start_publishes_one_message(db, monkeypatch, _no_pacing, _fresh_hub):
    """0→1 ⇒ 恰好一条 `domain.live.edge`，payload 是**实体口径**（snake_case）。"""
    sch = _no_pacing
    _stub_batch(monkeypatch, live_status=1)
    acc = _mk_account(db, live_status=0)

    result = asyncio.run(sch.live_sweep_core(db))
    assert result.success == 1, f"前提不成立（T0 没成功处理这个账号）：{result.details}"

    got = _edges(_fresh_hub)
    assert len(got) == 1, f"开播应当产生**恰好一条**消息，实际 {len(got)}"
    msg = got[0]
    assert msg.seq == 1, "序号要能当 Last-Event-ID 用"
    p = msg.payload
    assert p["vtuber_id"] == acc.vtuber_id
    assert p["account_id"] == acc.id
    assert p["platform"] == "bilibili"
    assert p["platform_uid"] == "11073", "uid 一律字符串（devlog/236 的口径）"
    assert p["name"] == "开播V"
    assert p["live_title"] == "今晚开播"
    assert p["live_url"] == "https://live.bilibili.com/123"


def test_live_start_is_not_replayed_on_the_next_round(db, monkeypatch, _no_pacing, _fresh_hub):
    """② 非边沿：下一轮上游还是"直播中" ⇒ **没有**新消息（否则每 60s 播报一次）。"""
    sch = _no_pacing
    _stub_batch(monkeypatch, live_status=1)
    _mk_account(db, live_status=0)

    asyncio.run(sch.live_sweep_core(db))          # 第 1 轮：0→1（这条边沿）
    assert len(_edges(_fresh_hub)) == 1
    asyncio.run(sch.live_sweep_core(db))          # 第 2 轮：1→1（不是边沿）
    assert len(_edges(_fresh_hub)) == 1, "非边沿不该再产生消息"


def test_stream_end_does_not_publish_a_start(db, monkeypatch, _no_pacing, _fresh_hub):
    """③ 1→0 是**下播**边沿，不该被播成"开播"。"""
    sch = _no_pacing
    _mk_account(db, live_status=1)
    _stub_batch(monkeypatch, live_status=0)

    asyncio.run(sch.live_sweep_core(db))
    assert _edges(_fresh_hub) == [], "下播边沿不该发开播消息"


# ── ④ §2.2：事务回滚时**不许**有消息 ─────────────────────────────────────

def test_no_message_when_the_transaction_rolls_back(db, monkeypatch, _no_pacing, _fresh_hub):
    """快照写失败 ⇒ live 字段与快照一起回滚 ⇒ **消息一条都不许发**。

    为什么这是"最容易写错的一处"（方案 §2.2）：把 `publish` 放在 `db.commit()` **之前**，
    消息已经发出去、而事务回滚了 ⇒ 订阅者收到一条"从未发生过"的开播通知，
    而库里 `live_status` 还是 0。反向验证就是把这句挪到 commit 之前 ⇒ 本用例红。
    """
    sch = _no_pacing
    _stub_batch(monkeypatch, live_status=1)
    _mk_account(db, live_status=0)

    def _boom(_db, _acc):
        raise RuntimeError("模拟快照写失败")

    monkeypatch.setattr(sch, "_record_stat_snapshot", _boom)
    asyncio.run(sch.live_sweep_core(db))

    db.expire_all()
    assert db.query(Account).one().live_status == 0, "前提不成立：事务没回滚"
    assert _edges(_fresh_hub) == [], \
        "事务回滚了却发了消息 —— 订阅者会收到一条『从未发生过』的开播"


# ── 回归 + 一轮多账号 ────────────────────────────────────────────────────

def test_existing_speedup_behavior_is_unchanged(db, monkeypatch, _no_pacing, _fresh_hub):
    """回归：开播仍要把动态流恢复满速（R28②）—— 这是这条边沿**原来唯一**的消费者。"""
    sch = _no_pacing
    _stub_batch(monkeypatch, live_status=1)
    _mk_account(db, live_status=0)

    calls: list[str] = []
    monkeypatch.setattr(sch, "note_dynamics_activity", lambda why="": calls.append(why))

    asyncio.run(sch.live_sweep_core(db))
    assert len(calls) == 1 and "开播" in calls[0], f"动态流满速恢复被改了：{calls}"


def test_two_accounts_going_live_in_one_round_publish_two_messages(
        db, monkeypatch, _no_pacing, _fresh_hub):
    """T0 是**批量**接口（一批 100 个）⇒ 一轮里可能好几个同时开播，各发各的。"""
    sch = _no_pacing
    _stub_batch(monkeypatch, live_status=1)
    _mk_account(db, uid="11073", live_status=0)
    _mk_account(db, uid="11074", live_status=0)

    asyncio.run(sch.live_sweep_core(db))
    got = _edges(_fresh_hub)
    assert sorted(m.payload["platform_uid"] for m in got) == ["11073", "11074"]
