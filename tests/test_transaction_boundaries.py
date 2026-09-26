# -*- coding: utf-8 -*-
"""事务边界（R3，批次 7）：五个多表流程"中途失败"时会留下什么。

计划 §R3 的必测五条，核实后**全部缺失**（`ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §R3）：

| # | 判据 | 本批之前的状态 |
|---|---|---|
| ① | purge 中途失败 ⇒ 全回滚（删账号 / 删 VTuber） | ❌ 没有任何失败路径用例 |
| ② | 快照写失败 ⇒ live 状态回滚（T0） | ❌ 无，而且**今天必然复现**（两笔独立 commit） |
| ③ | 布局半途失败 ⇒ 旧布局还在 | ⚠️ 半个（只断言抛 `IntegrityError`，没断言旧行还在） |
| ④ | 账号唯一冲突 ⇒ 不留孤儿 V | ❌ 无 |
| ⑤ | 锁冲突之后 session 还能继续用 | ⚠️ 半个（既有用例测的是风控冷却重连，不是锁） |

⚠️ **为什么用文件库**：内存库每个连接一份空库 —— ⑤ 要"另一个连接持写锁"、④ 的并发窗口
要"事务外真的有人插了一行"，内存库都做不到；计划也明确要求"文件 SQLite 故障测试"。
⚠️ **为什么要 `PRAGMA foreign_keys=ON`**：与生产同口径。没有它，"删 V 被外键挡下"这类
整次回滚的事故根本测不出来（`tests/test_vtuber_api.py` 同款理由）。
⚠️ ② 的"边沿被吞"是**用户可见**的后果：直播日历少一场 —— 所以除了"回滚"，
还钉了一条"失败一轮之后，下一轮仍能把这条边沿补上"。
"""
from __future__ import annotations

import asyncio
import atexit
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import sessionmaker

from app.core.database import Base, get_db
from app.main import app
from app.models.vtuber import (
    Account, AccountStatSnapshot, LiveSession, Post, ProfileCard, VTuber,
)

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-tx-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)

test_engine = create_engine(f"sqlite:///{(_TMPDIR / 'tx.db').as_posix()}",
                            connect_args={"check_same_thread": False})


@event.listens_for(test_engine, "connect")
def _fk_on(dbapi_connection, _record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


TestingSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)


def _override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _test_db_for_app():
    """只在本文件的用例里把 `get_db` 指到测试库，用完**还原**（不是 `clear()`）。

    ⚠️ 不能像 `test_vtuber_api.py` 那样在**模块导入时**装覆盖：那会和另一个文件的
    覆盖互相盖掉（哪个后导入哪个赢），症状是"某些用例连到别人的库上"。
    """
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    Base.metadata.create_all(bind=test_engine)
    yield
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def db():
    s = TestingSession()
    yield s
    s.close()


@pytest.fixture
def client(monkeypatch):
    """HTTP 客户端。

    ⚠️ **不写成 `with TestClient(app)`**：那会跑应用 lifespan → 起真调度器，
    而测试进程里 `DATA_DIR` = 仓库根 ⇒ 在开发者那本真库上跑迁移/抓取
    （批次 6 devlog/211 记过的那一类"用例碰了真实数据目录，而它不会红"）。
    """
    import app.routers.vtuber as router_mod

    async def _noop(*_a, **_k) -> None:
        return None

    monkeypatch.setattr(router_mod, "_adopt_background", _noop)
    return TestClient(app)


# ── 铺数据 ─────────────────────────────────────────────────────────────

def _mk_v(db, name="事务V"):
    v = VTuber(name=name)
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _mk_account(db, v, uid="11073", **kw):
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid,
                  display_name="事务V", followers_count=7, **kw)
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return acc


def _seed_children(db, acc):
    """每张"要逐表删"的子表各铺一行：purge 的失败点才落在"已经删过东西之后"。"""
    db.add(AccountStatSnapshot(account_id=acc.id, followers_count=7, live_status=1,
                               live_title="开播中"))
    db.add(LiveSession(account_id=acc.id, platform="bilibili", source="danmakus",
                       live_id="L1", start_at=datetime(2026, 9, 1, 12, tzinfo=timezone.utc)))
    db.add(Post(platform="bilibili", platform_uid=acc.platform_uid,
                platform_post_id="P1", type="text"))
    db.commit()


def _fresh() -> dict[str, int]:
    """从**另一个会话**读计数：本会话的身份映射看不出"到底提交了没有"。"""
    s = TestingSession()
    try:
        return {
            "v": s.query(VTuber).count(),
            "acc": s.query(Account).count(),
            "snap": s.query(AccountStatSnapshot).count(),
            "live": s.query(LiveSession).count(),
            "post": s.query(Post).count(),
            "card": s.query(ProfileCard).count(),
        }
    finally:
        s.close()


_EMPTY = {"v": 0, "acc": 0, "snap": 0, "live": 0, "post": 0, "card": 0}


# ── ① 删账号 / 删 VTuber：purge 中途失败必须全回滚 ──────────────────────

def test_delete_account_rolls_back_when_purge_fails_midway(db, client, monkeypatch):
    """删账号：帖子与快照已经删过 → 第 3 步崩 ⇒ **一行都不许少**。

    失败点刻意选在 `LiveSessionRepo.delete_by_account`（purge_account 的第 3 步）——
    前两步的 DELETE 已经发给 SQLite 了，只有"同一事务 + 不提交"能让它们回来。
    """
    from app.repositories.vtuber_repo import LiveSessionRepo

    v = _mk_v(db)
    acc = _mk_account(db, v)
    _seed_children(db, acc)
    assert _fresh() == {**_EMPTY, "v": 1, "acc": 1, "snap": 1, "live": 1, "post": 1}

    def _boom(self, account_id):  # noqa: ANN001 - 替身
        raise RuntimeError("模拟清理到第 3 步崩掉")

    monkeypatch.setattr(LiveSessionRepo, "delete_by_account", _boom)

    with pytest.raises(RuntimeError):
        client.delete(f"/account/{acc.id}")

    assert _fresh() == {**_EMPTY, "v": 1, "acc": 1, "snap": 1, "live": 1, "post": 1}, \
        "purge 中途失败后库被改了一半（帖子/快照已删、账号还在）"


def test_delete_vtuber_rolls_back_when_purge_fails_midway(db, client, monkeypatch):
    """删 V：先清 events / profile_cards / 曾用值，再逐账号清子表；中途崩 ⇒ 全回滚。"""
    from app.repositories.vtuber_repo import AccountStatSnapshotRepo

    v = _mk_v(db)
    acc = _mk_account(db, v)
    _seed_children(db, acc)
    db.add(ProfileCard(vtuber_id=v.id, card_key="anniversary", kind="anniversary",
                       x=0, y=0, w=6, h=3))
    db.commit()

    def _boom(self, account_id):  # noqa: ANN001 - 替身
        raise RuntimeError("模拟清到账号子表时崩掉")

    monkeypatch.setattr(AccountStatSnapshotRepo, "delete_by_account", _boom)

    with pytest.raises(RuntimeError):
        client.delete(f"/vtuber/{v.id}")

    after = _fresh()
    assert after == {**_EMPTY, "v": 1, "acc": 1, "snap": 1, "live": 1, "post": 1, "card": 1}, \
        f"删 V 中途失败后库被改了一半：{after}"


# ── ② T0：live 字段与跳变快照必须同一个事务 ─────────────────────────────

def _patch_live_sweep(monkeypatch, live_status=1, title="今晚开播"):
    from app.services import scheduler as sch

    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MIN", 0.0)
    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MAX", 0.0)

    async def fake_batch(mids, client=None):
        return {str(m): {"live_status": live_status, "live_title": title,
                         "room_id": "123", "live_url": "https://live.bilibili.com/123"}
                for m in mids}

    monkeypatch.setattr(sch, "fetch_bilibili_live_batch", fake_batch)
    return sch


def test_live_status_rolls_back_when_snapshot_write_fails(db, monkeypatch):
    """**本批的一号缺陷**：快照写失败时 live 字段必须一起回滚。

    改造前这里是两笔独立 commit（先 commit live 字段、再 commit 快照）：
    第二笔失败 ⇒ live 状态已落盘、跳变快照缺失，而下一轮 `prev_status == live_status`
    ⇒ **这条边沿被永久吞掉**（直播日历少一场）。所以今天这条是**必然红**的。
    """
    sch = _patch_live_sweep(monkeypatch)
    v = _mk_v(db)
    acc = _mk_account(db, v, live_status=0, live_title="旧标题")

    def _boom(_db, _acc):
        raise RuntimeError("模拟快照写失败")

    monkeypatch.setattr(sch, "_record_stat_snapshot", _boom)

    result = asyncio.run(sch.live_sweep_core(db))

    db.expire_all()
    fresh = db.query(Account).filter(Account.id == acc.id).one()
    assert fresh.live_status == 0, "live 状态落了盘而快照没落 —— 这条边沿永远不会再被记录"
    assert fresh.live_title == "旧标题"
    assert db.query(AccountStatSnapshot).filter(
        AccountStatSnapshot.account_id == acc.id).count() == 0
    assert result.details, "T0 失败必须留在 details 里（它不进状态通道，不能连日志都没有）"


def test_live_edge_is_recorded_on_the_next_round_after_a_failure(db, monkeypatch):
    """失败一轮之后，下一轮仍要能把这条边沿补上（用户可见的后果：别少一场）。"""
    sch = _patch_live_sweep(monkeypatch)
    v = _mk_v(db)
    acc = _mk_account(db, v, live_status=0)

    real = sch._record_stat_snapshot
    calls = {"n": 0}

    def _fail_once(_db, _acc):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("第一轮快照写失败")
        return real(_db, _acc)

    monkeypatch.setattr(sch, "_record_stat_snapshot", _fail_once)

    asyncio.run(sch.live_sweep_core(db))          # 第 1 轮：崩
    asyncio.run(sch.live_sweep_core(db))          # 第 2 轮：上游还是「直播中」

    db.expire_all()
    fresh = db.query(Account).filter(Account.id == acc.id).one()
    assert fresh.live_status == 1
    rows = db.query(AccountStatSnapshot).filter(
        AccountStatSnapshot.account_id == acc.id).all()
    assert len(rows) == 1, "第二轮的边沿没落上：开播那一场会从直播日历里消失"
    assert rows[0].live_status == 1


# ── ③ 档案布局：半途失败保留旧布局 ──────────────────────────────────────

def test_failed_layout_save_keeps_the_old_layout(db):
    """`replace_all` 是"删旧 + 插新"：插入撞唯一键 ⇒ 旧布局必须**还在**。"""
    from app.repositories.vtuber_repo import ProfileCardRepo

    v = _mk_v(db)
    repo = ProfileCardRepo(db)

    def _card(key, x=0):
        return {"card_key": key, "kind": key, "x": x, "y": 0, "w": 6, "h": 3}

    repo.replace_all(v.id, [_card("anniversary", 0), _card("top-posts", 5)])
    assert [c.card_key for c in repo.by_vtuber(v.id)] == ["anniversary", "top-posts"]

    with pytest.raises(IntegrityError):
        repo.replace_all(v.id, [_card("anniversary", 0), _card("anniversary", 5)])

    reader = TestingSession()
    try:
        kept = [c.card_key for c in ProfileCardRepo(reader).by_vtuber(v.id)]
    finally:
        reader.close()
    assert kept == ["anniversary", "top-posts"], \
        f"保存失败把旧布局删没了（用户看到的是「布局丢了」）：{kept}"


# ── ④ 收录：账号唯一冲突不留孤儿 V ──────────────────────────────────────

def test_adopt_conflict_leaves_no_orphan_vtuber(db, client, monkeypatch):
    """并发收录撞唯一约束 ⇒ 409，且**不能留下一个没有账号的 V**。

    怎么制造那个"并发窗口"：`exists` 预检之后、`db.commit()` 之前，另一个请求抢先
    插了同 (platform, uid) 的账号行。这里用 SQLite **触发器**在"插入 vtubers 行"那一
    瞬间插入冲突行来复现 —— 比双线程竞态确定，而且是真的数据库层冲突（不是假替身）。
    """
    import app.routers.vtuber as router_mod

    monkeypatch.setattr(router_mod.pool, "find_in_pool",
                        lambda p, u: {"name": "并发收录的V", "platform": p, "platform_uid": u})

    with test_engine.begin() as conn:
        conn.exec_driver_sql(
            """
            CREATE TRIGGER tx_race_adopt AFTER INSERT ON vtubers
            BEGIN
                INSERT INTO accounts (vtuber_id, platform, platform_uid, display_name)
                VALUES (NEW.id, 'bilibili', '11073', '别的请求抢先插的');
            END
            """
        )
    try:
        r = client.post("/vtuber/adopt",
                        json={"platform": "bilibili", "platform_uid": "11073"})
        assert r.status_code == 409, f"唯一冲突应映射成 409，实际 {r.status_code}：{r.text}"
    finally:
        with test_engine.begin() as conn:
            conn.exec_driver_sql("DROP TRIGGER tx_race_adopt")

    assert _fresh() == _EMPTY, "冲突之后留下了孤儿 V（或半写的账号行）"

    # 冲突之后这条路仍然可用（回滚干净、没把会话搞坏）
    ok = client.post("/vtuber/adopt",
                     json={"platform": "bilibili", "platform_uid": "11073"})
    assert ok.status_code == 201
    assert _fresh()["v"] == 1 and _fresh()["acc"] == 1


# ── ⑤ 锁冲突之后 session 还能继续用 ─────────────────────────────────────

def _lock_engine():
    """短 busy_timeout 的文件库：锁冲突要**快点抛**，否则用例要干等 30s。"""
    eng = create_engine(f"sqlite:///{(_TMPDIR / 'locked.db').as_posix()}",
                        connect_args={"check_same_thread": False, "timeout": 0.2})

    @event.listens_for(eng, "connect")
    def _pragma(dbapi_connection, _record):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=200")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    return eng


def test_session_still_usable_after_a_lock_conflict(monkeypatch):
    """锁冲突（`database is locked`）是并发写库的**正常形态**：抛错、可回滚、会话不坏死。

    实测口径（2026-09-26，SQLAlchemy 2.0 + sqlite3，探针跑过再写判据）：
      · 冲突发生在**写**那一句（`OperationalError`），且那一笔**没有半应用**；
      · 抛完之后同一会话**仍可读** —— ⚠️ 不是"不 rollback 就直接报 PendingRollbackError"
        （第一版判据照直觉写，实测**假红**：`execute` 抛 DBAPI 错不会把会话打成待回滚态）；
      · `rollback()` + 锁释放之后，**同一个会话对象**要能照常写进去（这才是"能继续用"）；
      · 产品路径同款：T0 那一轮失败要留痕，下一轮必须照常写进去 —— 否则链路不报错、
        只是"什么都不再更新"。
    """
    eng = _lock_engine()
    Base.metadata.create_all(bind=eng)
    Testing = sessionmaker(bind=eng, autoflush=False, autocommit=False)

    seed = Testing()
    v = _mk_v(seed)
    _mk_account(seed, v)
    seed.close()

    holder = eng.connect()                       # 另一个连接：持写锁不放
    holder.exec_driver_sql("BEGIN IMMEDIATE")
    holder.exec_driver_sql("UPDATE accounts SET followers_count = 1")

    s = Testing()
    try:
        with pytest.raises(OperationalError):
            s.execute(text("UPDATE accounts SET followers_count = 2"))
        assert s.execute(text("SELECT followers_count FROM accounts")).scalar() == 7, \
            "冲突的那一笔半应用了（本该整笔失败）"
        s.rollback()
    finally:
        holder.exec_driver_sql("ROLLBACK")       # 释放写锁
        holder.close()
    try:
        s.execute(text("UPDATE accounts SET followers_count = 9"))
        s.commit()
        assert s.execute(text("SELECT followers_count FROM accounts")).scalar() == 9, \
            "锁释放之后同一个 session 写不进去了（事务状态没收拾干净）"
    finally:
        s.close()

    # 产品路径同款：T0 一轮写库撞锁 ⇒ 记进 details 且会话没坏死；锁释放后下一轮照常
    sch = _patch_live_sweep(monkeypatch)

    holder2 = eng.connect()
    holder2.exec_driver_sql("BEGIN IMMEDIATE")
    holder2.exec_driver_sql("UPDATE accounts SET followers_count = 1")
    db = Testing()
    try:
        first = asyncio.run(sch.live_sweep_core(db))
        assert first.success == 0 and first.details, "锁冲突那一轮该失败并留痕"
    finally:
        holder2.exec_driver_sql("ROLLBACK")
        holder2.close()

    second = asyncio.run(sch.live_sweep_core(db))
    assert second.success == 1, "锁释放之后同一个 session 没能继续用（回滚没做干净？）"
    db.expire_all()
    assert db.query(Account).first().live_status == 1
    db.close()
    eng.dispose()
