# -*- coding: utf-8 -*-
"""升级与迁移安全：迁移前备份 + 失败时"绝不留下一本打不开的库"（批次 16，devlog/207）。

**为什么这一批值得单独写用例**：这是唯一一类"故障发生在**别人的机器**上、档案在**别人手里**、
你看不见也够不着"的问题。今天之前：

- 每次升级都会跑的 schema 迁移**没有任何备份**；中途失败（磁盘满 / 断电 / SQLite locked）
  ⇒ 用户面对"打不开 + 没有任何退路"；
- 启动失败文案分不清"迁移失败"与"端口占用/杀软首扫/后端崩了" ⇒ 用户拿不到可操作的下一步。

判据口径（`ARCHITECTURE.md` §6 的两条不变量）：
① **真跑迁移之前必须先备份**（快路径**不**备份）；② **迁移失败不得留下打不开的库**，
且失败要能**分类**带出去（`/healthz` 的 `migration`）。

⚠️ 这里用**真库**（临时目录里的 sqlite + 真 alembic 迁移链）而不是 mock 掉 alembic：
"迁移失败之后应用还能起来"这件事，只有真跑一遍才算验过。
"""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from app import main as app_main
from app.core import database as app_database
from app.core.config import settings
from app.services import db_maintenance as m

#: 迁移链上的一个中间版本（用它造"落后一版的库"）
BEHIND = "e006"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """把库与数据目录指到临时目录，并让 `app.main` 用**这一套** engine。

    ⚠️ `app.main` 是 `from app.core.database import engine`（名字已绑定模块属性），
    所以测试里必须同时换掉 `app.main.engine` 与 `app.core.database.engine`
    —— 只换后者的话被测代码还用着老 engine（那会连到真库上去）。
    """
    data = tmp_path / "data"
    data.mkdir(parents=True)
    db = data / "vtuber.db"
    engine = create_engine(f"sqlite:///{db.as_posix()}",
                           connect_args={"check_same_thread": False})
    monkeypatch.setattr(settings, "DATA_DIR", data)
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite:///{db.as_posix()}")
    monkeypatch.setattr(app_main, "engine", engine)
    monkeypatch.setattr(app_database, "engine", engine)
    monkeypatch.setattr(app_main, "_MIGRATION_STATE", {"status": "not-run"})
    monkeypatch.setattr(app_main, "FIRST_RUN_MARKER", data / ".first-run-done")
    yield {"data": data, "db": db, "engine": engine}
    engine.dispose()


def _migrate_to(engine, revision: str) -> None:
    """把临时库迁到某个版本（用真 alembic，路径与产品代码同一套）。"""
    from app.main import _alembic_config
    cfg = _alembic_config()
    cfg.set_main_option("sqlalchemy.url", str(engine.url))
    from alembic import command
    command.upgrade(cfg, revision)


# ── ① 备份 ──────────────────────────────────────────────────────────────

def test_backup_copies_wal_but_never_shm(env):
    """复制 `-wal`（里面有已提交但没并回主库的数据）、**不复制 `-shm`**（索引，可重建）。

    反向验证：把 `-shm` 也复制 ⇒ 本用例红；反过来漏掉 `-wal` ⇒ 也是红
    （两条断言分别钉住"必须带"和"必须不带"）。
    """
    db = env["db"]
    db.write_bytes(b"main" * 100)
    Path(str(db) + "-wal").write_bytes(b"wal" * 10)
    Path(str(db) + "-shm").write_bytes(b"shm" * 10)

    got = m.backup_database("f007")
    dst = Path(got["path"])
    assert dst.is_file()
    assert dst.name.startswith("vtuber-f007-") and dst.suffix == ".db"
    assert dst.read_bytes() == db.read_bytes()
    assert Path(str(dst) + "-wal").is_file(), "WAL 必须一起备份（丢了就是丢数据）"
    assert not Path(str(dst) + "-shm").exists(), "-shm 是共享内存索引，不该备份"
    assert got["wal_bytes"] > 0
    # 备份是"复制"不是"搬走"：原件必须还在
    assert db.is_file() and Path(str(db) + "-wal").is_file()


def test_backup_leaves_no_part_file_behind(env):
    """先写 `.part` 再改名 ⇒ 正常情况下不该留下残片（崩在中途才会）。"""
    env["db"].write_bytes(b"x" * 50)
    m.backup_database("f007")
    assert list(m.backups_dir().glob("*.part*")) == []


def test_backup_without_database_is_skipped(env):
    """没有库可备份（全新安装）⇒ 明确返回 skipped，而不是造一个空备份。"""
    got = m.backup_database("f007")
    assert got == {"skipped": "no-database", "path": None}


def test_prune_keeps_newest_and_never_deletes_the_last_one(env):
    """保留份数与体积上限都要生效，但**永远至少留最新那一份**。

    反向验证：把 `if len(backups) - len(doomed) <= 1: break` 删掉 ⇒ 第三条断言红。
    """
    d = m.backups_dir()
    d.mkdir(parents=True, exist_ok=True)
    made = []
    for i in range(5):
        p = d / f"vtuber-f007-2026092{i}-000000.db"
        p.write_bytes(b"x" * 1000)
        made.append(p)

    removed = m.prune_backups(keep=2, max_bytes=10 ** 9)
    left = [b["name"] for b in m.list_backups()]
    assert len(left) == 2, f"应只留 2 份，实得 {left}"
    assert left == [made[-1].name, made[-2].name], "留下的必须是最新两份"
    assert len(removed) == 3

    # 体积上限：只给 1 份的空间 ⇒ 只留最新那份（不能删光）
    removed2 = m.prune_backups(keep=2, max_bytes=1)
    left2 = [b["name"] for b in m.list_backups()]
    assert left2 == [made[-1].name], f"体积超限时也只该留最新一份，实得 {left2}"
    assert removed2 == [made[-2].name]


def test_prune_removes_the_wal_sidecar_too(env):
    """淘汰备份时 `-wal` 必须一起删（否则永远删不干净、占用统计还对不上）。"""
    d = m.backups_dir()
    d.mkdir(parents=True, exist_ok=True)
    old = d / "vtuber-f007-20260920-000000.db"
    old.write_bytes(b"x" * 10)
    Path(str(old) + "-wal").write_bytes(b"y" * 10)
    new = d / "vtuber-f007-20260921-000000.db"
    new.write_bytes(b"x" * 10)

    m.prune_backups(keep=1, max_bytes=10 ** 9)
    assert not old.exists() and not Path(str(old) + "-wal").exists()
    assert new.is_file()


# ── ② 真跑迁移：备份 + 失败兜底 ──────────────────────────────────────────

def test_fast_path_does_not_backup(env):
    """已经是最新版本的库（常态）**不备份** —— 别为每次启动付复制 50MB 的代价。"""
    _migrate_to(env["engine"], "head")
    app_main._run_migrations()

    assert app_main.migration_state()["status"] == "fast-path"
    assert not m.backups_dir().exists(), "快路径不该产生备份目录"


def test_real_migration_backs_up_first(env):
    """落后一版的库：真跑迁移，**而且先落了备份** —— 这是本批的核心承诺。"""
    _migrate_to(env["engine"], BEHIND)
    before = env["db"].stat().st_size
    assert before > 0

    app_main._run_migrations()

    state = app_main.migration_state()
    assert state["status"] == "ok", state
    assert state["label"] == f"{BEHIND} -> {app_main.MIGRATION_HEAD}"
    backups = m.list_backups()
    assert len(backups) == 1, f"迁移前应有 1 份备份，实得 {backups}"
    assert backups[0]["bytes"] == before
    # 备份里的库是**迁移前**的那一版（能回退才有意义）
    con = sqlite3.connect(backups[0]["path"])
    try:
        rev = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    finally:
        con.close()
    assert rev == BEHIND, f"备份应当是迁移前的版本 {BEHIND}，实得 {rev}"


def test_migration_failure_quarantines_and_keeps_the_app_usable(env, monkeypatch):
    """⚠️ 本批最重要的一条：**迁移失败绝不留下打不开的库**。

    造法：让第一次 `command.upgrade` 抛错（模拟"迁移中途失败"），第二次（空库重建）
    放行 —— 断言四件事：坏库被隔离成 `.failed-*`、原路径上有一本**能打开的新库**、
    状态里带出可找回的位置、`/healthz` 把失败报出来（前端只有这条通路）。

    反向验证：把 `_migrate_with_safety` 里的 `_quarantine_database()` + 空库重建
    那段去掉（直接 `raise`）⇒ 本用例红（库还躺在原地、状态里没有 quarantined）。
    """
    _migrate_to(env["engine"], BEHIND)
    real_upgrade = app_main._upgrade_to_head
    calls = {"n": 0}

    def flaky() -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("磁盘满（模拟）")
        real_upgrade()

    monkeypatch.setattr(app_main, "_upgrade_to_head", flaky)

    app_main._run_migrations()          # ← 不抛错：失败被兜住并用空库起来了

    state = app_main.migration_state()
    assert state["status"] == "failed", state
    assert "磁盘满" in state["error"]
    assert state["recovered"] is True
    quarantined = Path(state["quarantined"])
    assert quarantined.is_file(), "坏库必须被隔离（而不是留在原处让人打不开）"
    assert ".failed-" in quarantined.name
    assert state["backup"] and Path(state["backup"]["path"]).is_file(), \
        "失败路径也应当有迁移前的备份（它是「能找回」的另一半）"

    # 原路径上现在是**一本能打开的新库**（应用可用）
    assert env["db"].is_file()
    con = sqlite3.connect(env["db"])
    try:
        tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        rev = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    finally:
        con.close()
    assert "posts" in tables and "vtubers" in tables, f"新库应当建好了表：{tables}"
    assert rev == app_main.MIGRATION_HEAD

    # 被隔离的库**没被动过**（还是原样那一版）—— "档案没有丢"要能被验证
    con = sqlite3.connect(quarantined)
    try:
        old_rev = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    finally:
        con.close()
    assert old_rev == BEHIND

    # /healthz：前端在**拿到 token 之前**唯一的通路
    body = TestClient(app_main.app).get("/healthz").json()
    assert body["ok"] is True
    assert body["migration"]["status"] == "failed"
    assert body["migration"]["quarantined"] == state["quarantined"]


def test_backup_failure_does_not_block_the_migration(env, monkeypatch):
    """备份写不下去（磁盘满/权限）时**继续迁移**，但状态里必须带上这个事实。

    为什么不是"备份失败就拒绝启动"：那种情况下用户连界面都进不去、也拿不到提示，
    而迁移本身在事务里（见模块头）。⇒ 判据是"说了出来"，不是"挡住了"。
    """
    _migrate_to(env["engine"], BEHIND)

    def boom(*_a, **_kw):
        raise OSError("No space left on device")

    monkeypatch.setattr(m, "backup_database", boom)
    app_main._run_migrations()

    state = app_main.migration_state()
    assert state["status"] == "ok" and state["label"].endswith(app_main.MIGRATION_HEAD)
    assert "No space left" in state["backup"]["error"], state["backup"]
    assert env["db"].is_file()


def test_healthz_reports_not_run_before_lifespan(env):
    """`/healthz` 在任何时候都要有 `migration` 字段（前端会读它，缺字段=静默假绿）。"""
    body = TestClient(app_main.app).get("/healthz").json()
    assert body["migration"]["status"] == "not-run"


def test_backup_dir_is_counted_in_storage_stats(env):
    """备份要出现在"数据目录占用"里 —— 用户得看得见它占了多少、有哪些、能不能删。"""
    env["db"].write_bytes(b"x" * 100)
    m.backup_database("f007")

    st = m.dir_stats()
    assert st["groups"]["backups"]["files"] >= 1
    assert st["groups"]["backups"]["bytes"] > 0
    assert st["backup_dir"].endswith("backups")
    assert [b["name"] for b in st["backups"]] == [m.list_backups()[0]["name"]]


def test_data_dir_migration_does_not_touch_backups(env):
    """备份目录跟着数据目录走：整目录体检时它算在 total 里（而不是被漏掉）。

    （这条守的是"用户搬目录/删目录"时的口径：备份不能是隐形占用。）
    """
    env["db"].write_bytes(b"x" * 100)
    m.backup_database("f007")
    st = m.dir_stats()
    assert st["total_bytes"] >= st["groups"]["backups"]["bytes"]
    # 收尾：临时目录由 pytest 清理；这里只确认没有写到真数据目录去
    assert str(env["data"]) in st["backup_dir"]
    shutil.rmtree(m.backups_dir(), ignore_errors=True)


# ── ③ 诊断包 ────────────────────────────────────────────────────────────

def test_diagnostics_carries_the_sections_support_needs(env):
    """诊断包里必须有"支持者第一眼要看的东西"：版本 / 迁移结局 / 库形态 / 备份位置 / 日志尾。

    反向验证：把 `build_diagnostics` 里 "本次启动的 schema 迁移" 那一段删掉 ⇒ 本用例红。
    """
    from app.services import diagnostics

    _migrate_to(env["engine"], "head")
    (env["data"] / "logs").mkdir(exist_ok=True)
    (env["data"] / "logs" / "app.log").write_text("第一行\n第二行\n", encoding="utf-8")
    app_main._run_migrations()

    got = diagnostics.build_diagnostics()
    text = got["text"]
    assert got["filename"].startswith("ddtoolkit-diagnostics-") and got["filename"].endswith(".txt")
    assert settings.VERSION in text
    assert "本次启动的 schema 迁移" in text and "fast-path" in text
    assert "schema 版本" in text and app_main.MIGRATION_HEAD in text
    assert "备份目录" in text
    assert "app.log" in text and "第二行" in text


def test_diagnostics_never_leaks_credentials(env, monkeypatch):
    """⚠️ **凭据一律不进诊断包**：`.env`（B 站 SESSDATA / 微博 cookie）与会话 token。

    写法是"植哨兵再断言不在输出里"（不是"读一遍代码觉得没拼"）—— 这类判据必须能被
    一个真实的坏改动弄红：把 `.env` 加进打包 ⇒ 红。
    """
    from app.services import diagnostics

    (env["data"] / ".env").write_text(
        "BILI_SESSDATA=SENTINEL_SESSDATA_9f3a\n"
        "BILI_REFRESH_TOKEN=SENTINEL_REFRESH_1a2b\n"
        "WEIBO_COOKIE=SENTINEL_COOKIE_7b1c\n", encoding="utf-8")
    monkeypatch.setattr(settings, "API_TOKEN", "SENTINEL_TOKEN_4d2e", raising=False)
    monkeypatch.setattr(settings, "DEV_API_TOKEN", "SENTINEL_DEVTOKEN_5e6f", raising=False)

    text = diagnostics.build_diagnostics()["text"]
    for secret in ("SENTINEL_SESSDATA_9f3a", "SENTINEL_REFRESH_1a2b",
                   "SENTINEL_COOKIE_7b1c", "SENTINEL_TOKEN_4d2e",
                   "SENTINEL_DEVTOKEN_5e6f"):
        assert secret not in text, f"诊断包里出现了凭据：{secret}"
    assert ".env" not in text, "连 `.env` 这个文件名都不该出现（避免引导用户去贴它）"


def test_diagnostics_survives_a_missing_or_broken_database(env):
    """"库读不动"正是**最需要诊断包**的时候 ⇒ 它不能因为读库失败就抛。"""
    from app.services import diagnostics

    env["db"].unlink(missing_ok=True)
    assert "不存在" in diagnostics.build_diagnostics()["text"]

    env["db"].write_bytes(b"this is not a sqlite file at all")
    text = diagnostics.build_diagnostics()["text"]
    assert "读库失败" in text or "schema 版本" in text   # 不抛异常即可


def test_diagnostics_is_capped_and_marks_truncation(env, monkeypatch):
    """日志很大时**截断并标注**（宁可截断也不能"发不出来"）。"""
    from app.services import diagnostics

    (env["data"] / "logs").mkdir(exist_ok=True)
    huge = "\n".join(f"第 {i} 行 " + "x" * 200 for i in range(4000))
    (env["data"] / "logs" / "app.log").write_text(huge, encoding="utf-8")
    monkeypatch.setattr(diagnostics, "MAX_CHARS", 5000)

    got = diagnostics.build_diagnostics()
    assert len(got["text"]) < 6000
    assert "已截断" in got["text"]
