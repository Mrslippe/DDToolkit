# -*- coding: utf-8 -*-
"""墓碑机制（删除检测，v0.5.1）测试：
- 两击规则：单次缺席不判，连续两次缺席打墓碑（最后在线严格早于上一轮扫描）
- 已验证窗口：增量停止帖 / 自然结束才判定；窗口外（比停止帖更旧的缺席）永不判
- 排除：已归档 / 未扫描类型（增量轮 video）/ 无基线（last_seen_at NULL）
- 墓碑不可逆转：复活帖保留墓碑、仅刷新 last_seen_at
- 坏窗口（page_limit 等）不判但推进扫描标记；paginated is_deleted 过滤 + stats 计数
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, Post, VTuber
from app.repositories.vtuber_repo import PostRepo
from app.services.tombstone import apply_tombstone_scan


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


T0 = datetime(2026, 9, 1, 12, 0, 0)   # 计时基线（naive UTC，与库内约定一致）


def _mk_account(db, platform="bilibili", uid="10086", posts_last_scan_at=None) -> Account:
    v = VTuber(name=f"vtuber-{uid}")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform=platform, platform_uid=uid,
                  posts_last_scan_at=posts_last_scan_at)
    db.add(acc)
    db.commit()
    return acc


def _mk_post(db, acc: Account, pid: str, published_at: datetime, *,
             archived: bool = False, type_: str = "text",
             last_seen_at=None, deleted_detected_at=None) -> Post:
    p = Post(
        platform=acc.platform, platform_uid=acc.platform_uid,
        platform_post_id=pid, type=type_, title=f"post-{pid}",
        published_at=published_at, is_archived=archived,
        last_seen_at=last_seen_at, deleted_detected_at=deleted_detected_at,
    )
    db.add(p)
    db.commit()
    return p


def _scan(db, acc: Account, seen: list[str], round_ts: datetime, *,
          natural_end: bool = True, stop_pid: str | None = None,
          exclude=None) -> list[Post]:
    return apply_tombstone_scan(
        db, acc, seen_pids=seen, natural_end=natural_end,
        stop_existing_pid=stop_pid, round_ts=round_ts, exclude_types=exclude,
    )


def _by_pid(db, acc: Account, pid: str) -> Post:
    return db.query(Post).filter(
        Post.platform == acc.platform, Post.platform_uid == acc.platform_uid,
        Post.platform_post_id == pid,
    ).one()


# ── 两击规则 ────────────────────────────────────────────────────────

def test_two_absent_rounds_tombstone(db):
    """单次缺席不判；连续第二次缺席（last_seen 早于上一轮）打墓碑。"""
    acc = _mk_account(db)
    p_new = _mk_post(db, acc, "new", T0 + timedelta(hours=2), last_seen_at=T0)
    p_del = _mk_post(db, acc, "gone", T0 + timedelta(hours=3), last_seen_at=T0)

    # 第 1 轮基线：全部可见（prev=None → 只记账不判定）
    _scan(db, acc, ["new", "gone"], T0 + timedelta(hours=1))
    assert _by_pid(db, acc, "gone").deleted_detected_at is None
    assert acc.posts_last_scan_at == T0 + timedelta(hours=1)

    # 第 2 轮：gone 缺席（strike 1）→ 不判，last_seen 保持第 1 轮
    _scan(db, acc, ["new"], T0 + timedelta(hours=2))
    g = _by_pid(db, acc, "gone")
    assert g.deleted_detected_at is None
    assert g.last_seen_at == T0 + timedelta(hours=1)

    # 第 3 轮：gone 仍缺席（strike 2）→ 墓碑
    _scan(db, acc, ["new"], T0 + timedelta(hours=3))
    g = _by_pid(db, acc, "gone")
    assert g.deleted_detected_at == T0 + timedelta(hours=3)
    assert _by_pid(db, acc, "new").last_seen_at == T0 + timedelta(hours=3)


def test_present_after_absence_heals(db):
    """单次缺席后重新被见 → 不判且刷新 last_seen。"""
    acc = _mk_account(db, posts_last_scan_at=T0)
    wobble = _mk_post(db, acc, "wobble", T0 + timedelta(hours=3), last_seen_at=T0)
    _mk_post(db, acc, "anchor", T0 + timedelta(hours=2), last_seen_at=T0)
    _scan(db, acc, ["anchor"], T0 + timedelta(hours=1))          # strike 1（缺席）
    assert _by_pid(db, acc, "wobble").deleted_detected_at is None
    _scan(db, acc, ["anchor", "wobble"], T0 + timedelta(hours=2))  # 复活 → 刷新
    w = _by_pid(db, acc, "wobble")
    assert w.deleted_detected_at is None
    assert w.last_seen_at == T0 + timedelta(hours=2)


# ── 已验证窗口 ──────────────────────────────────────────────────────

def test_outside_window_never_judged(db):
    """比「本轮所见最旧帖」更旧的缺席帖在窗口外：缺席多轮也不判。"""
    acc = _mk_account(db, posts_last_scan_at=T0)
    older = _mk_post(db, acc, "older", T0 + timedelta(hours=1), last_seen_at=T0)
    anchor = _mk_post(db, acc, "anchor", T0 + timedelta(hours=2), last_seen_at=T0)
    for i in range(1, 4):   # 三轮都只见 anchor
        _scan(db, acc, ["anchor"], T0 + timedelta(hours=i))
    assert _by_pid(db, acc, "older").deleted_detected_at is None
    assert _by_pid(db, acc, "anchor").deleted_detected_at is None


def test_stop_pid_window_tighter_than_natural(db):
    """增量停止：窗口下界取停止帖发布时间——比停止帖更旧的缺席不判；
    比停止帖更新的缺席达到两击（含基线轮缺席）即判。"""
    acc = _mk_account(db)
    stop = _mk_post(db, acc, "stop", T0 + timedelta(hours=2), last_seen_at=T0)
    above = _mk_post(db, acc, "above", T0 + timedelta(hours=3), last_seen_at=T0)
    below = _mk_post(db, acc, "below", T0 + timedelta(hours=1), last_seen_at=T0)
    # 第 1 轮基线：只见 stop（above 已缺席）；prev=None 只记账
    _scan(db, acc, ["stop"], T0 + timedelta(hours=1), stop_pid="stop")
    assert above.deleted_detected_at is None
    # 第 2 轮：above 连续两轮缺席 → 墓碑（T0+2h）；below 窗口外不判
    _scan(db, acc, ["stop"], T0 + timedelta(hours=2), stop_pid="stop")
    assert _by_pid(db, acc, "above").deleted_detected_at == T0 + timedelta(hours=2)
    assert _by_pid(db, acc, "below").deleted_detected_at is None


def test_bad_window_skips_judgment_but_keeps_mark(db):
    """page_limit / 网络失败（非自然结束、无停止帖）→ 窗口不可信，缺席不判，
    但 last_seen 与扫描标记照常推进。"""
    acc = _mk_account(db, posts_last_scan_at=T0)
    _mk_post(db, acc, "gone", T0 + timedelta(hours=1), last_seen_at=T0)
    h1 = _scan(db, acc, [], T0 + timedelta(hours=1), natural_end=False)
    h2 = _scan(db, acc, [], T0 + timedelta(hours=2), natural_end=False)
    assert h1 == [] and h2 == []
    assert _by_pid(db, acc, "gone").deleted_detected_at is None
    assert acc.posts_last_scan_at == T0 + timedelta(hours=2)


# ── 排除项 ──────────────────────────────────────────────────────────

def test_archived_never_judged(db):
    """已归档帖缺席不受影响（即使处于窗口内、两击已满）。"""
    acc = _mk_account(db, posts_last_scan_at=T0)
    _mk_post(db, acc, "old", T0 + timedelta(hours=3), archived=True, last_seen_at=T0)
    _mk_post(db, acc, "anchor", T0 + timedelta(hours=2), last_seen_at=T0)
    _scan(db, acc, ["anchor"], T0 + timedelta(hours=1))
    _scan(db, acc, ["anchor"], T0 + timedelta(hours=2))
    assert _by_pid(db, acc, "old").deleted_detected_at is None


def test_excluded_type_not_judged_in_incremental(db):
    """增量轮（不抓视频）：type=video 缺席不判（即使两击已满）；全量轮照判。"""
    acc = _mk_account(db, posts_last_scan_at=T0)
    v = _mk_post(db, acc, "bv1", T0 + timedelta(hours=3), type_="video", last_seen_at=T0)
    d = _mk_post(db, acc, "dyn1", T0 + timedelta(hours=2), type_="text", last_seen_at=T0)
    # 增量轮：只见动态（视频未扫描）→ video 排除，text 照常刷新
    _scan(db, acc, ["dyn1"], T0 + timedelta(hours=1), exclude={"video"})
    _scan(db, acc, ["dyn1"], T0 + timedelta(hours=2), exclude={"video"})
    assert _by_pid(db, acc, "bv1").deleted_detected_at is None
    # 全量轮（视频被扫描）：排除集合为空 → 两击满后判
    _scan(db, acc, ["dyn1"], T0 + timedelta(hours=3))
    assert _by_pid(db, acc, "bv1").deleted_detected_at == T0 + timedelta(hours=3)


def test_null_last_seen_not_judged(db):
    """无基线（迁移前旧库 last_seen_at NULL）：窗口内缺席两轮也不判，被见后建立基线。"""
    acc = _mk_account(db, posts_last_scan_at=T0)
    _mk_post(db, acc, "legacy", T0 + timedelta(hours=4), last_seen_at=None)
    _mk_post(db, acc, "anchor", T0 + timedelta(hours=3), last_seen_at=T0)
    _scan(db, acc, ["anchor"], T0 + timedelta(hours=1))
    _scan(db, acc, ["anchor"], T0 + timedelta(hours=2))
    assert _by_pid(db, acc, "legacy").deleted_detected_at is None
    _scan(db, acc, ["anchor", "legacy"], T0 + timedelta(hours=3))
    assert _by_pid(db, acc, "legacy").last_seen_at == T0 + timedelta(hours=3)


# ── 墓碑不可逆转 ────────────────────────────────────────────────────

def test_tombstone_survives_revival(db):
    """已墓碑帖重新被见：墓碑保留，仅刷新 last_seen_at。"""
    acc = _mk_account(db, posts_last_scan_at=T0)
    _mk_post(db, acc, "phoenix", T0 + timedelta(hours=1),
             last_seen_at=T0, deleted_detected_at=T0)
    _scan(db, acc, ["phoenix"], T0 + timedelta(hours=2))
    p = _by_pid(db, acc, "phoenix")
    assert p.deleted_detected_at == T0          # 墓碑保留
    assert p.last_seen_at == T0 + timedelta(hours=2)


# ── 读取侧（paginated 过滤 + stats 计数） ────────────────────────────

def test_paginated_is_deleted_filter_and_stats(db):
    acc = _mk_account(db)
    _mk_post(db, acc, "gone", T0, last_seen_at=T0, deleted_detected_at=T0 + timedelta(hours=1))
    _mk_post(db, acc, "alive", T0 + timedelta(hours=1), last_seen_at=T0)
    repo = PostRepo(db)
    _, deleted = repo.paginated("bilibili", "10086", is_deleted=True)
    _, alive = repo.paginated("bilibili", "10086", is_deleted=False)
    _, all_ = repo.paginated("bilibili", "10086")
    assert [p.platform_post_id for p in deleted] == ["gone"]
    assert [p.platform_post_id for p in alive] == ["alive"]
    assert len(all_) == 2
    stats = repo.stats("bilibili", "10086")
    assert stats["deleted"] == 1
    assert stats["total"] == 2
