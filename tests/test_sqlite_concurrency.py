# -*- coding: utf-8 -*-
"""真实文件 SQLite 的**并发面**（Q3，批次 15，devlog/215）。

`tests/test_db_maintenance.py` 已经用真库验了 PRAGMA / VACUUM / checkpoint；
本文件补的是**竞争与并发**那一半 —— 计划明确要求"**不得用内存库宣称验证 WAL**"：
内存库每个连接一份空库，连"两个连接看见同一份数据"这件事都不成立。

| # | 判据 | 为什么值得一条用例 |
|---|---|---|
| ① | 生产那套 PRAGMA（WAL / busy_timeout / foreign_keys）真的生效 | 调度线程与 HTTP 线程并发写同一张库全靠它 |
| ② | 多 session 竞争写：全成功、无 `database is locked`、计数正确 | 抓取线程 + 手动任务 + T0 同时写是常态 |
| ③ | WAL 读写并行：写事务未提交时读得到**旧值**且不被阻塞 | 这是"选 WAL 而不是 rollback journal"的全部理由 |
| ④ | 写冲突被 `busy_timeout` **排队**而不是报错（短超时才会抛） | `busy_timeout=30s` 是产品参数，不是装饰 |
| ⑤ | T0 直播轮询 ∥ 帖子写入（两条真路径并发） | T0 是独立线程且**不占抓取锁**（§1 表） |
| ⑥ | checkpoint 后**重开**新引擎仍读得到数据 | 与 `checkpoint_wal` 的配合 |
| ⑦ | `engine.dispose()` 之后文件**改得动名**（Windows 上"不 dispose 就改不动"那半条带平台守卫） | §6 第 28 条：隔离坏库前必须 dispose，否则 Windows 上撞"另一个程序正在使用此文件" |
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from app.core.database import Base, _set_sqlite_pragma
from app.models.vtuber import Account, LiveSession, Post, VTuber
from app.repositories.vtuber_repo import PostRepo
from app.services import db_maintenance as m


def _file_engine(path: Path, *, timeout: float = 0.0):
    """与生产**同一套 PRAGMA 监听器**（直接复用 `app/core/database.py` 的那个函数）——
    否则测的是"测试库的并发行为"，不是产品的。

    ⚠️ **驱动超时刻意设成 0**（生产是 pysqlite 默认的 5s，而它和 `busy_timeout` 是**同一个
    旋钮**）：0 = 一撞锁就抛，于是容忍度**只可能**来自生产那套 PRAGMA —— 拿掉监听器
    或那行 `busy_timeout`，并发写立刻变红（反向验证实测过）。
    ⚠️ 试过 0.05s：**不够**（360 笔微事务每笔亚毫秒，50ms 的等待绰绰有余）⇒ 判据咬不住。
    """
    eng = create_engine(f"sqlite:///{path.as_posix()}",
                        connect_args={"check_same_thread": False, "timeout": timeout})
    event.listens_for(eng, "connect")(_set_sqlite_pragma)
    return eng


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "vtuber.db"
    eng = _file_engine(path)
    Base.metadata.create_all(bind=eng)
    Session = sessionmaker(bind=eng, autoflush=False, autocommit=False)
    yield type("Env", (), {"engine": eng, "Session": Session, "path": path})()
    eng.dispose()


def _seed_v(env, name="并发V") -> int:
    db = env.Session()
    try:
        v = VTuber(name=name)
        db.add(v)
        db.commit()
        db.refresh(v)
        return v.id
    finally:
        db.close()


# ── ① 生产那套 PRAGMA 真的生效 ─────────────────────────────────────────

def test_production_pragmas_are_applied(env):
    """两层都要：**函数内容对**（下面四条 PRAGMA）**且生产引擎真的挂上了它**。

    ⚠️ 只测前者是假绿：把 `app/core/database.py` 上的
    `@event.listens_for(engine, "connect")` 去掉，PRAGMA 全都不生效，
    而"在测试自己的引擎上挂一下监听器"照样绿。所以这里对**生产那个 engine**
    断言监听器登记在册（`event.contains`，不连真库）。
    """
    from app.core import database as db

    assert event.contains(db.engine, "connect", _set_sqlite_pragma), \
        "生产引擎没挂 PRAGMA 监听器 —— WAL / busy_timeout / foreign_keys 全都不会生效"

    with env.engine.connect() as c:
        assert c.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        assert c.execute(text("PRAGMA busy_timeout")).scalar() == 30000
        assert c.execute(text("PRAGMA foreign_keys")).scalar() == 1
        assert c.execute(text("PRAGMA synchronous")).scalar() == 1      # NORMAL


# ── ② 多 session 竞争写 ───────────────────────────────────────────────

def test_concurrent_writers_do_not_fail_and_land_every_row(env):
    """6 个 session × 60 笔写，全部并发提交同一张表：**一次 locked 都不许有**。

    这是 T0 + 综合档 + 手动任务并存的日常形态（SQLite 侧靠 `busy_timeout` 排队）。

    ⚠️ **每笔写刻意在事务里停 3ms**（`flush()` 之后、`commit()` 之前）：真实的写事务就是要
    持锁几毫秒（INSERT + 索引 + fsync），而**不留这个窗口时这条用例是假的** ——
    实测 360 笔微事务在"驱动超时 0 + 无 PRAGMA"的裸配置下**也一次都不冲突**
    （GIL + 亚毫秒事务 ⇒ 根本没重叠）。留窗口之后容忍度就只可能来自
    `PRAGMA busy_timeout=30000`：拿掉监听器立刻红（反向验证实测）。
    """
    vid = _seed_v(env)
    errors: list[str] = []
    per_thread = 60
    threads_n = 6

    def _writer(tid: int) -> None:
        db = env.Session()
        try:
            for i in range(per_thread):
                db.add(Post(platform="bilibili", platform_uid=f"u{tid}",
                            platform_post_id=f"p{tid}-{i}", type="text"))
                db.flush()                          # 先拿到写锁
                time.sleep(0.003)                   # ……再持锁 3ms（真实写事务的量级）
                db.commit()
        except Exception as e:                      # noqa: BLE001 - 要看到底是什么错
            errors.append(f"线程{tid}: {type(e).__name__}: {e}")
        finally:
            db.close()

    threads = [threading.Thread(target=_writer, args=(t,)) for t in range(threads_n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)

    assert not errors, f"并发写报错了：{errors[:3]}"
    db = env.Session()
    try:
        assert db.query(Post).count() == threads_n * per_thread
    finally:
        db.close()
    assert vid > 0


# ── ③ WAL：写事务不挡读，读到的是**旧值** ──────────────────────────────

def test_wal_readers_see_the_old_value_while_a_writer_is_open(env):
    """写事务**未提交**时，别的事务读到的是旧值，而且读不被挡住（快照语义）。

    ⚠️ 这条钉的是**语义**，不是"WAL 比 rollback journal 并发度高"：实测把
    `journal_mode` 换成 `DELETE` 这条**照样绿**（rollback journal 在 RESERVED 阶段也允许读，
    要到提交的 EXCLUSIVE 那一瞬才挡）。`journal_mode` 本身是不是 `wal` 由
    `test_production_pragmas_are_applied` 直接断言。
    """
    db = env.Session()
    try:
        db.execute(text("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"))
        db.execute(text("INSERT INTO t (id, v) VALUES (1, 'old')"))
        db.commit()

        writer = env.engine.connect()
        writer.exec_driver_sql("BEGIN IMMEDIATE")
        writer.exec_driver_sql("UPDATE t SET v = 'new' WHERE id = 1")

        reader = env.Session()
        try:
            # 写事务还开着（未提交）：读得到旧值，而且**不被挡住**
            assert reader.execute(text("SELECT v FROM t WHERE id = 1")).scalar() == "old"
        finally:
            reader.close()

        writer.exec_driver_sql("COMMIT")
        writer.close()
        db.expire_all()
        assert db.execute(text("SELECT v FROM t WHERE id = 1")).scalar() == "new"
    finally:
        db.close()


# ── ④ busy_timeout：排队 vs 立刻报错 ───────────────────────────────────

def test_busy_timeout_queues_the_second_writer(tmp_path):
    """`busy_timeout=30s` 的实际效果 = 第二个写者**排队**（产品参数，不是装饰）。

    ⚠️ 两个坑都踩过，写法是照着它们定的：
    ① 第一版写成"持锁不放 ⇒ 30s 后仍报错"，跑出来 65s 且测的是**超时**不是**排队**；
    ② 第二版用驱动默认超时（5s）压这条 —— **拿掉 PRAGMA 也照样绿**（pysqlite 的 `timeout`
       连接参数本身就是同一个旋钮）。所以这里刻意把驱动的 `timeout` 压到 **0.2s**、
       再把 PRAGMA 抬到 30s：**拿掉那行 PRAGMA 就会立刻失败**（反向验证实测过）。
    """
    from sqlalchemy.exc import OperationalError

    path = tmp_path / "q.db"
    # 驱动超时 0.2s + 生产那套 PRAGMA（busy_timeout=30s）⇒ 排队能力只可能来自 PRAGMA
    prod = _file_engine(path, timeout=0.2)
    Base.metadata.create_all(bind=prod)

    holder = prod.connect()
    holder.exec_driver_sql("BEGIN IMMEDIATE")
    holder.exec_driver_sql("INSERT INTO vtubers (name) VALUES ('占着锁')")

    # ① 小超时：不等，直接抛（**不带**生产那套监听器，否则 busy_timeout 会被它改回 30s）
    quick = create_engine(f"sqlite:///{path.as_posix()}",
                          connect_args={"check_same_thread": False, "timeout": 0.2})
    qdb = sessionmaker(bind=quick, autoflush=False, autocommit=False)()
    try:
        t0 = time.monotonic()
        with pytest.raises(OperationalError) as ei:
            qdb.add(VTuber(name="小超时"))
            qdb.commit()
        assert "locked" in str(ei.value)
        assert time.monotonic() - t0 < 5.0, "小超时该**立刻**失败，不该等满 30s"
        qdb.rollback()
    finally:
        qdb.close()
        quick.dispose()

    # ② 生产参数：排队者要真的"等到"锁，然后成功
    result: dict[str, object] = {}

    def _queued_writer() -> None:
        db = sessionmaker(bind=prod, autoflush=False, autocommit=False)()
        t = time.monotonic()
        try:
            db.add(VTuber(name="排队成功"))
            db.commit()
            result["elapsed"] = time.monotonic() - t
        except Exception as e:                  # noqa: BLE001
            result["error"] = f"{type(e).__name__}: {e}"
        finally:
            db.close()

    th = threading.Thread(target=_queued_writer)
    th.start()
    time.sleep(0.5)                             # 让它先撞上锁、进排队
    holder.exec_driver_sql("COMMIT")            # 放锁 —— 排队者应当接上
    holder.close()
    th.join(timeout=30)

    assert "error" not in result, f"排队者还是报错了：{result.get('error')}"
    assert float(result["elapsed"]) >= 0.3, "它没有真的等过锁 —— 这条用例没测到排队"
    prod.dispose()



# ── ⑤ T0 直播轮询 ∥ 帖子写入（两条真路径） ─────────────────────────────

def test_live_poller_writes_concurrently_with_post_inserts(env, monkeypatch):
    """T0 是独立守护线程且**不占抓取锁**（§1 表）⇒ 它与帖子写入天然并发。

    这里跑的是真 `live_sweep_core`（只把批量接口换成替身）与真 `PostRepo.create`。
    """
    from app.services import scheduler as sch

    vid = _seed_v(env, "T0并发V")
    db0 = env.Session()
    try:
        db0.add(Account(vtuber_id=vid, platform="bilibili", platform_uid="70001",
                        display_name="T0并发V", live_status=0))
        db0.commit()
    finally:
        db0.close()

    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MIN", 0.0)
    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MAX", 0.0)

    async def fake_batch(mids, client=None):
        return {str(m): {"live_status": 1, "live_title": "并发开播",
                         "room_id": "1", "live_url": "https://live.bilibili.com/1"}
                for m in mids}

    monkeypatch.setattr(sch, "fetch_bilibili_live_batch", fake_batch)

    t0_errors: list[str] = []
    post_errors: list[str] = []

    def _t0() -> None:
        db = env.Session()
        try:
            asyncio.run(sch.live_sweep_core(db))
        except Exception as e:                  # noqa: BLE001
            t0_errors.append(f"{type(e).__name__}: {e}")
        finally:
            db.close()

    def _posts() -> None:
        db = env.Session()
        try:
            repo = PostRepo(db)
            for i in range(60):
                repo.create({"platform": "bilibili", "platform_uid": "70001",
                             "platform_post_id": f"live-{i}", "type": "text"})
        except Exception as e:                  # noqa: BLE001
            post_errors.append(f"{type(e).__name__}: {e}")
        finally:
            db.close()

    a, b = threading.Thread(target=_t0), threading.Thread(target=_posts)
    a.start()
    b.start()
    a.join(timeout=60)
    b.join(timeout=60)

    assert not t0_errors and not post_errors, f"T0={t0_errors} posts={post_errors}"
    db = env.Session()
    try:
        assert db.query(Post).count() == 60
        acc = db.query(Account).filter(Account.platform_uid == "70001").one()
        assert acc.live_status == 1 and acc.live_title == "并发开播"
        # T0 的跳变快照随同一次事务落盘（批次 7 修的那条）
        assert db.query(Account).count() == 1
        assert db.query(LiveSession).count() == 0        # 场次表由另一条路径写，这里不该有
    finally:
        db.close()


# ── ⑥ checkpoint 之后重开 ──────────────────────────────────────────────

def test_data_survives_checkpoint_and_reopen(env):
    db = env.Session()
    try:
        for i in range(50):
            db.add(Post(platform="bilibili", platform_uid="u", platform_post_id=f"c{i}",
                        type="text"))
        db.commit()
    finally:
        db.close()

    got = m.checkpoint_wal(env.engine)
    assert got["after"] == 0, "checkpoint 之后 WAL 该被截断"
    env.engine.dispose()                    # 模拟进程重启

    reopened = _file_engine(env.path)
    try:
        with reopened.connect() as c:
            assert c.execute(text("SELECT count(*) FROM posts")).scalar() == 50
    finally:
        reopened.dispose()


# ── ⑦ 连接释放：dispose 之前文件改不动名（Windows） ────────────────────

def test_dispose_releases_the_file_so_it_can_be_renamed(env):
    """§6 第 28 条的实现依据：**隔离坏库前必须 `engine.dispose()`**。

    ⚠️ **"不 dispose 就改不动名"只在 Windows 成立**：POSIX 允许改名/删除**打开中**的文件，
    所以这半条判据带 `os.name == "nt"` 守卫（第一次上 CI 就是这里红的 —— Linux 两条腿
    一起挂在"DID NOT RAISE"上）。**"dispose 之后一定改得动"两个平台都断言** ——
    那才是产品真正依赖的那一半（Windows 上撞"另一个程序正在使用此文件"）。
    """
    db = env.Session()
    try:
        db.add(VTuber(name="占用检查"))
        db.commit()
    finally:
        db.close()

    target = env.path.with_suffix(".db.failed")
    if os.name == "nt":
        with pytest.raises(OSError):
            env.path.rename(target)         # 连接池还握着句柄（Windows：文件被占用）
            target.rename(env.path)

    env.engine.dispose()
    env.path.rename(target)                 # 释放之后才改得动（两个平台都必须成立）
    assert target.exists()
    target.rename(env.path)
