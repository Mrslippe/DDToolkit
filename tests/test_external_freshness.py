# -*- coding: utf-8 -*-
"""R43-B：第三方「粉丝历史」的**账号级新鲜度跳过**（devlog/163）。

**为什么有这一支**：2026-09-23 启动时第三方补抓花了 **4 分 15 秒**，其中
`zeroroku/fan_history` 占 **1 分 30 秒** —— 这个接口**一次返回全量**
（实测 197KB / 5~15s，单账号一次上千条），而历史数据本来就变得慢。

`scheduler.py` 的注释里写着「①账号级新鲜度跳过（<24h 不跑）」，**但代码里没有这个跳过** ✗
（`_sync_fan_history` 对每个账号每次都拉全量）⇒ 本批把它**实现出来**，窗口取 **7 天**
（用户口径「把窗口放宽到 7 天」）。

⚠️ 本仓没有 `pytest-asyncio`（异步测试用 `asyncio.run(...)` 包一层，见 `test_auth.py`）。
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, VTuber
from app.repositories.vtuber_repo import AppMetaRepo
from app.services.externals.zeroroku import ZerorokuSource, fan_history_marker_key


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _mk_account(db, uid="10086") -> Account:
    v = VTuber(name="测试V")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid)
    db.add(acc)
    db.commit()
    return acc


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class _Counter:
    """替身：记录被调了几次（**不看日志、不靠时间**，直接数调用）。"""

    def __init__(self, items=None):
        self.calls = 0
        self.items = items if items is not None else [
            {"createdAt": "2026-09-23T00:00:00", "fans": 1234}]

    async def __call__(self, mid, client):
        self.calls += 1
        return self.items


def _sync(db, monkeypatch, counter, account_ids):
    monkeypatch.setattr("app.services.externals.zeroroku.fetch_fan_history", counter)
    return asyncio.run(
        ZerorokuSource()._sync_fan_history(db, client=None, account_ids=account_ids))


def test_fresh_account_is_skipped(db, monkeypatch):
    """7 天内抓过的账号 ⇒ **一次请求都不发**。"""
    acc = _mk_account(db)
    AppMetaRepo(db).set_dt(fan_history_marker_key(acc.id), _now() - timedelta(days=1))
    counter = _Counter()
    summ = _sync(db, monkeypatch, counter, [acc.id])
    assert counter.calls == 0, "新鲜账号不该再打全量接口"
    assert summ.skipped == 1


def test_stale_account_is_fetched_and_marked(db, monkeypatch):
    """超过窗口 ⇒ 照常抓，并在**成功后**打上时间戳。"""
    acc = _mk_account(db, uid="20001")
    AppMetaRepo(db).set_dt(fan_history_marker_key(acc.id), _now() - timedelta(days=8))
    counter = _Counter()
    _sync(db, monkeypatch, counter, [acc.id])
    assert counter.calls == 1
    marked = AppMetaRepo(db).get_dt(fan_history_marker_key(acc.id))
    assert marked is not None and marked > _now() - timedelta(minutes=5)


def test_never_fetched_account_is_fetched(db, monkeypatch):
    """没有任何标记（第一次跑）⇒ 必须抓（不能因为"查不到时间"就跳过）。"""
    acc = _mk_account(db, uid="20002")
    counter = _Counter()
    _sync(db, monkeypatch, counter, [acc.id])
    assert counter.calls == 1


def test_failure_does_not_mark_fresh(db, monkeypatch):
    """**抓失败不许打时间戳** —— 否则一次网络抖动会让这个账号 7 天不再重试。"""
    acc = _mk_account(db, uid="20003")

    async def boom(mid, client):
        raise RuntimeError("上游挂了")

    _sync(db, monkeypatch, boom, [acc.id])
    assert AppMetaRepo(db).get_dt(fan_history_marker_key(acc.id)) is None


def test_mixed_accounts_only_fetch_the_stale_one(db, monkeypatch):
    """混合场景（本次启动的真实形态）：7 个账号里只有 1 个过期 ⇒ 只发 1 次请求。"""
    fresh = [_mk_account(db, uid=f"30{i:03d}") for i in range(6)]
    stale = _mk_account(db, uid="30999")
    for acc in fresh:
        AppMetaRepo(db).set_dt(fan_history_marker_key(acc.id), _now() - timedelta(days=2))
    AppMetaRepo(db).set_dt(fan_history_marker_key(stale.id), _now() - timedelta(days=9))
    counter = _Counter()
    summ = _sync(db, monkeypatch, counter, [a.id for a in fresh] + [stale.id])
    assert counter.calls == 1, "只有过期的那一个该被抓"
    assert summ.skipped == 6
