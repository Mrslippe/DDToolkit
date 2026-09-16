"""数据目录体检与库维护（R22，devlog/103）。

判错的代价（三条都是"界面上看不出来"的）：
- `dir_stats` 少算一块（比如漏了 `-wal`、或漏了遗留备份）→ 用户以为占用没那么大；
- `ensure_incremental_autovacuum` 在**大库**上照样跑全库 VACUUM → 升级时卡住 / 临时空间不够；
- 两条 PRAGMA **不能在事务里**执行（`VACUUM` 直接报错）—— 所以这里用真库跑一遍，
  而不是只对着 SQLAlchemy 的隐式事务想当然。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from app.core.config import settings
from app.services import db_maintenance as m


@pytest.fixture()
def temp_env(tmp_path, monkeypatch):
    """把数据目录三件套指到临时目录（体检函数全部按调用时的 settings 读路径）。"""
    data = tmp_path / "data"
    (data / "logs").mkdir(parents=True)
    (data / "static" / "img-cache").mkdir(parents=True)
    monkeypatch.setattr(settings, "DATA_DIR", data)
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite:///{data / 'vtuber.db'}")
    monkeypatch.setattr(settings, "IMG_CACHE_DIR", str(data / "static" / "img-cache"))
    monkeypatch.setattr(settings, "IMG_CACHE_MAX_MB", 300)
    return data


def _touch(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def test_dir_stats_counts_each_group_and_flags_stale_backups(temp_env):
    db = temp_env / "vtuber.db"
    _touch(db, 1000)
    _touch(Path(str(db) + "-wal"), 200)         # WAL 也算库占用（漏了就会少报）
    _touch(temp_env / "static" / "img-cache" / "a.bin", 500)
    _touch(temp_env / "logs" / "app.log", 300)
    _touch(temp_env / "vtuber.db.bak-20260913-141254", 700)

    st = m.dir_stats()
    assert st["groups"]["database"]["bytes"] == 1200
    assert st["groups"]["img_cache"] == {"bytes": 500, "files": 1}
    assert st["groups"]["logs"] == {"bytes": 300, "files": 1}
    # 遗留备份不是程序生成的，但**它就是占地方**：要单独列出来，也要算进总量
    assert [b["name"] for b in st["stale_backups"]] == ["vtuber.db.bak-20260913-141254"]
    assert st["stale_backups"][0]["bytes"] == 700
    assert st["total_bytes"] >= 1200 + 500 + 300 + 700
    assert st["disk"]["total"] > 0 and st["disk"]["free"] >= 0
    assert st["img_cache_max_bytes"] == 300 * 1024 * 1024


def test_sqlite_stats_reports_freelist(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 's.db'}")
    with eng.begin() as c:
        c.execute(text("create table t(id integer primary key, v text)"))
    st = m.sqlite_stats(eng)
    assert st["page_size"] > 0 and st["page_count"] > 0
    assert st["bytes"] == st["page_size"] * st["page_count"]
    assert st["auto_vacuum"] == 0            # 新库默认 NONE


def test_ensure_incremental_autovacuum_converts_once(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'a.db'}")
    with eng.begin() as c:
        c.execute(text("create table t(id integer primary key, v text)"))
    assert m.ensure_incremental_autovacuum(eng) == "converted"
    assert m.sqlite_stats(eng)["auto_vacuum"] == 2       # INCREMENTAL，且持久在库头里
    assert m.ensure_incremental_autovacuum(eng) == "already"
    # WAL 必须被 checkpoint 掉：真库实测里 VACUUM 会把整库重写进 WAL，
    # 不截断的话磁盘上会多留一份≈库大小的 WAL —— 那就白干这件事了
    wal = Path(str(tmp_path / "a.db") + "-wal")
    assert (not wal.exists()) or wal.stat().st_size == 0


def test_ensure_skips_big_databases(tmp_path):
    """大库**不动手**：全库 VACUUM 的临时空间约等于库大小，升级时卡住用户比"没还盘"更糟。"""
    eng = create_engine(f"sqlite:///{tmp_path / 'big.db'}")
    with eng.begin() as c:
        c.execute(text("create table t(id integer primary key, v text)"))
    assert m.ensure_incremental_autovacuum(eng, max_bytes=1) == "skipped-large"
    assert m.sqlite_stats(eng)["auto_vacuum"] == 0


def test_incremental_vacuum_returns_pages_to_the_system(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'v.db'}")
    with eng.begin() as c:
        c.execute(text("create table t(id integer primary key, v text)"))
    assert m.ensure_incremental_autovacuum(eng) == "converted"
    with eng.begin() as c:
        for _ in range(2000):
            c.execute(text("insert into t(v) values (:v)"), {"v": "x" * 200})
    with eng.begin() as c:
        c.execute(text("delete from t"))
    before = m.sqlite_stats(eng)["freelist_pages"]
    assert before > 0, "删了 2000 行却没产生空闲页？那这条用例就没在测东西"
    assert m.incremental_vacuum(eng) > 0
    assert m.sqlite_stats(eng)["freelist_pages"] < before


def test_incremental_vacuum_is_a_noop_without_freelist(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'n.db'}")
    with eng.begin() as c:
        c.execute(text("create table t(id integer primary key)"))
    assert m.incremental_vacuum(eng) == 0


def test_checkpoint_wal_truncates_a_bloated_wal(tmp_path, monkeypatch):
    """WAL 会胖到 ≈ 库大小（`VACUUM` 会把整库写进 WAL），而且**只有最后一个连接关闭**时
    SQLite 才自动 checkpoint —— 应用握着连接池，所以必须显式截断一次。

    这里用 `wal_autocheckpoint=0` 造一个胖 WAL（否则 SQLite 自己就 checkpoint 了，
    用例会变成"什么都没测"）。
    """
    db = tmp_path / "w.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite:///{db}")
    eng = create_engine(f"sqlite:///{db}")
    with eng.begin() as c:
        c.execute(text("PRAGMA journal_mode=WAL"))
        c.execute(text("PRAGMA wal_autocheckpoint=0"))
        c.execute(text("create table t(id integer primary key, v text)"))
    # 占住一条连接不放，模拟"应用一直握着连接池"
    keep = eng.connect()
    keep.execute(text("PRAGMA wal_autocheckpoint=0"))
    for _ in range(500):
        keep.execute(text("insert into t(v) values (:v)"), {"v": "y" * 400})
    keep.commit()
    wal = Path(str(db) + "-wal")
    assert wal.exists() and wal.stat().st_size > 0

    got = m.checkpoint_wal(eng)
    assert got["before"] > 0
    assert got["after"] == 0                 # TRUNCATE：文件被截到 0
    keep.close()
    eng.dispose()
