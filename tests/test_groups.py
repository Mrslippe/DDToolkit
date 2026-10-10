# -*- coding: utf-8 -*-
"""企划归属（B3，需求 6，`devlog/457`）：两条来源的优先级、写入纪律、幂等。

判据重点（每一条都能被一种"改回去"的写法弄红）：

| # | 不变量 | 改回旧写法会怎样 |
|---|---|---|
| 1 | 池快照优先于本地索引 | 两条都造出企划但名字不同 ⇒ 断言抓错源 |
| 2 | 索引兜底只在池里没有这个人时用 | 去掉兜底 ⇒ 池快照之后的新 V 一个徽章都没有 |
| 3 | **只填空**：已有企划不许被改写 | 改成无条件赋值 ⇒ "用户看到的徽章自己变了" |
| 4 | **来源没有就什么都不做**（不许写空值） | 写成 `vtuber.group_name = hit or ""` ⇒ 把已有企划抹掉 |
| 5 | 幂等：连跑两次第二次 `filled=0` | 去掉 `if group_name: return False` ⇒ 每次都"改了库" |

⚠️ 其中一条吃**真实数据**（`test_backfill_uses_the_real_snapshot`）：拿随包快照里真的带企划的
那一条 uid 建 V，断言回填结果 = 快照里的企划名（造样本的话"新列没接上"照样绿）。
"""
from __future__ import annotations

import csv
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core import config as cfg
from app.core.database import Base
from app.models.vtuber import Account, ThirdpartyVtuber, VTuber
from app.services import groups, pool


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _mk(db, uid="123", name="测试V", group_name=None):
    v = VTuber(name=name, group_name=group_name)
    db.add(v)
    db.flush()
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid))
    db.commit()
    db.refresh(v)
    return v


def _index(db, uid, group_name, source="danmakus"):
    db.add(ThirdpartyVtuber(platform="bilibili", platform_uid=uid, name="索引名",
                            source=source, group_name=group_name))
    db.commit()


# ── 来源优先级 ────────────────────────────────────────────────────────

def test_pool_snapshot_wins_over_local_index(db, monkeypatch):
    monkeypatch.setattr(groups.pool, "find_in_pool",
                        lambda p, u: {"group": "池里的企划", "group_uuid": "g-uuid",
                                      "uuid": "这个人的-uuid"})
    _index(db, "123", "索引里的企划")
    assert groups.group_for("bilibili", "123", db) == ("池里的企划", "g-uuid"), \
        "取错列了：`uuid` 是**这个人**的 uuid，企划的 uuid 在 `group_uuid`"


def test_index_is_the_fallback_when_pool_has_nobody(db, monkeypatch):
    """池快照之后新出现的 V 只有本地索引里有 ⇒ 不兜底的话它们一个徽章都没有。"""
    monkeypatch.setattr(groups.pool, "find_in_pool", lambda p, u: None)
    _index(db, "456", "索引里的企划")
    assert groups.group_for("bilibili", "456", db) == ("索引里的企划", "")


def test_unknown_person_returns_none(db, monkeypatch):
    monkeypatch.setattr(groups.pool, "find_in_pool", lambda p, u: None)
    assert groups.group_for("bilibili", "789", db) is None


def test_index_row_without_group_is_not_a_hit(db, monkeypatch):
    monkeypatch.setattr(groups.pool, "find_in_pool", lambda p, u: None)
    _index(db, "999", "")
    assert groups.group_for("bilibili", "999", db) is None


# ── 写入纪律 ──────────────────────────────────────────────────────────

def test_fill_only_when_empty(db, monkeypatch):
    monkeypatch.setattr(groups.pool, "find_in_pool",
                        lambda p, u: {"group": "新企划", "group_uuid": "g-1"})
    v = _mk(db, uid="1", group_name="原本的企划")
    assert groups.fill_for_vtuber(db, v) is False, "已有企划的 V 不该被改写"
    assert v.group_name == "原本的企划" and v.group_uuid is None

    v2 = _mk(db, uid="2")
    assert groups.fill_for_vtuber(db, v2) is True
    db.refresh(v2)
    assert v2.group_name == "新企划" and v2.group_uuid == "g-1", "填了却没落库"


def test_no_source_means_no_write(db, monkeypatch):
    """来源查不到 ⇒ **一个字节都不写**（写成空串会把将来的手工值/上次的值抹掉）。"""
    monkeypatch.setattr(groups.pool, "find_in_pool", lambda p, u: None)
    v = _mk(db, uid="3")
    assert groups.fill_for_vtuber(db, v) is False
    db.refresh(v)
    assert v.group_name is None and v.group_uuid is None


def test_backfill_counts_and_is_idempotent(db, monkeypatch):
    hits = {"1": {"group": "甲企划", "uuid": "g-1"}}

    def fake(platform, uid):
        return hits.get(str(uid))

    monkeypatch.setattr(groups.pool, "find_in_pool", fake)
    _mk(db, uid="1")
    _mk(db, uid="2")
    _mk(db, uid="3", group_name="早就有")
    first = groups.backfill_groups(db)
    assert first == {"scanned": 3, "filled": 1}, first
    second = groups.backfill_groups(db)
    assert second["filled"] == 0, "不幂等 ⇒ 每次启动都写库、还刷 updated_at"


def test_backfill_uses_the_real_snapshot(db, monkeypatch):
    """吃真实数据：随包快照里那条真的带企划的行 → 回填出它自己的企划名。"""
    monkeypatch.setattr(cfg.settings, "VTUBER_LIST_FILE",
                        str(Path(cfg.PROJECT_ROOT) / "vtubers.csv"))
    monkeypatch.setattr(pool, "_cache", None)
    rows = list(csv.DictReader((Path(cfg.PROJECT_ROOT) / "vtubers.csv")
                               .open(newline="", encoding="utf-8")))
    sample = next(r for r in rows if r["group_name"])
    _mk(db, uid=sample["platform_uid"])
    stats = groups.backfill_groups(db)
    assert stats["filled"] == 1, stats
    v = db.query(VTuber).one()
    assert v.group_name == sample["group_name"]
    assert v.group_uuid == sample["group_uuid"]
    pool.reload_pool()
