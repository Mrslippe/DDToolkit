"""数据目录体检与库维护（R22，devlog/103）。

起因（2026-09-16 用户）："数据库放置在 C 盘中会不会导致数据量很大了之后挤占太多 C 盘空间"。
实测开发档（8 个 V / 11 账号）：库 **54.3MB**（其中 `posts.raw_json` 占 **46%**，平均 5.9KB/帖）、
图片缓存 **101.7MB**（当时**只管时间不管体积**）、日志 5.7MB（已按天轮转 ✓）。
结论：会挤占，而且**图片缓存比库涨得更快** —— 所以这一批两件事：

1. **占用看得见**（`dir_stats`）：谁在长、长了多少、磁盘还剩多少、有没有遗留的大备份；
2. **删数据真的还盘**：SQLite 默认 `auto_vacuum=NONE`，删掉的行只进 freelist，**文件不会变小**
   （实测 freelist 554 页 / 2.2MB 白白占着）。这里做一次性切换（`INCREMENTAL` + `VACUUM`）
   与之后的 `PRAGMA incremental_vacuum`（破坏性清理之后调用）。
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy.engine import Engine

from app.core.config import settings
from app.core.database import engine as default_engine

logger = logging.getLogger(__name__)

# 一次性切换 auto_vacuum 需要一次全库 VACUUM：**临时空间约等于库大小**，大库上还可能跑很久。
# 超过这个体积就不动手，只记日志 —— "升级时把用户卡住"比"没还盘"糟糕得多。
AUTOVACUUM_MAX_BYTES = 512 * 1024 * 1024

# `vtuber.db.bak-20260913-141254` 这类**不是程序生成**的历史备份（实测一个 54MB）。
# 体检时单独列出来：它们不会自己消失，用户也不知道能删。
_STALE_BACKUP_GLOB = "vtuber.db.bak-*"


# ── 占用体检 ─────────────────────────────────────────────────────────

def _database_path() -> Path:
    """库文件路径：以 `DATABASE_URL` 为准，解析不出来就退回 `DATA_DIR/vtuber.db`。"""
    url = str(settings.DATABASE_URL)
    if url.startswith("sqlite:///"):
        return Path(url[len("sqlite:///"):])
    return Path(settings.DATA_DIR) / "vtuber.db"


def _dir_bytes(path: Path) -> tuple[int, int]:
    """`(字节数, 文件数)`；目录不存在或读不到就当 0（体检不该把调用方弄崩）。"""
    total = 0
    files = 0
    try:
        for p in path.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
                    files += 1
            except OSError:
                continue
    except OSError:
        pass
    return total, files


def _file_bytes(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def dir_stats() -> dict[str, Any]:
    """数据目录体检：分组占用 + 磁盘余量 + 遗留备份。

    分组就是"用户在意的三块"：库（含 WAL/SHM）、图片缓存、日志；
    其余（`.env`、`vtubers.csv` 等）合进 `other`，免得体检表看着像文件浏览器。
    """
    data_dir = Path(settings.DATA_DIR)
    db = _database_path()

    db_bytes = sum(_file_bytes(Path(str(db) + suffix))
                   for suffix in ("", "-wal", "-shm"))
    cache_bytes, cache_files = _dir_bytes(Path(settings.IMG_CACHE_DIR)
                                          if Path(settings.IMG_CACHE_DIR).is_absolute()
                                          else data_dir / str(settings.IMG_CACHE_DIR))
    log_bytes, log_files = _dir_bytes(data_dir / "logs")
    total_bytes, total_files = _dir_bytes(data_dir)
    groups = {
        "database": {"bytes": db_bytes, "files": 3 if db_bytes else 0},
        "img_cache": {"bytes": cache_bytes, "files": cache_files},
        "logs": {"bytes": log_bytes, "files": log_files},
        "other": {"bytes": max(0, total_bytes - db_bytes - cache_bytes - log_bytes),
                  "files": max(0, total_files)},
    }

    stale: list[dict[str, Any]] = []
    try:
        for p in sorted(data_dir.glob(_STALE_BACKUP_GLOB)):
            stale.append({"name": p.name, "bytes": _file_bytes(p)})
    except OSError:
        pass

    try:
        usage = shutil.disk_usage(data_dir if data_dir.exists() else Path.cwd())
        disk = {"free": usage.free, "total": usage.total}
    except OSError:
        disk = {"free": 0, "total": 0}

    return {
        "data_dir": str(data_dir),
        "database": str(db),
        "groups": groups,
        "total_bytes": total_bytes,
        "stale_backups": stale,
        "disk": disk,
        "img_cache_max_bytes": max(0, int(settings.IMG_CACHE_MAX_MB)) * 1024 * 1024,
    }


# ── 库维护 ───────────────────────────────────────────────────────────

def sqlite_stats(engine: Engine | None = None) -> dict[str, int]:
    """页与空闲空间现状（`auto_vacuum` 0=NONE / 1=FULL / 2=INCREMENTAL）。"""
    eng = engine or default_engine
    # 自己开一条连接、**自己读自己关**：PRAGMA 读在 SQLAlchemy 的隐式事务里也拿得到值，
    # 但下面切换 auto_vacuum 需要一条"没有事务"的连接，两条路径统一在这里更省心。
    raw = eng.raw_connection()
    try:
        cur = raw.cursor()
        page_size = int(cur.execute("PRAGMA page_size").fetchone()[0])
        page_count = int(cur.execute("PRAGMA page_count").fetchone()[0])
        freelist = int(cur.execute("PRAGMA freelist_count").fetchone()[0])
        auto_vacuum = int(cur.execute("PRAGMA auto_vacuum").fetchone()[0])
        cur.close()
    finally:
        raw.close()
    return {
        "page_size": page_size,
        "page_count": page_count,
        "bytes": page_size * page_count,
        "freelist_pages": freelist,
        "freelist_bytes": page_size * freelist,
        "auto_vacuum": auto_vacuum,
    }


def ensure_incremental_autovacuum(
    engine: Engine | None = None, max_bytes: int = AUTOVACUUM_MAX_BYTES,
) -> str:
    """把库切成 `auto_vacuum=INCREMENTAL`（幂等），返回做了什么：

    | 返回值 | 含义 |
    |---|---|
    | `already` | 已经是增量模式（或 FULL），不动 |
    | `skipped-large` | 库大于 `max_bytes`，**不冒险做全库 VACUUM** |
    | `converted` | 已切换（`PRAGMA auto_vacuum=INCREMENTAL` + `VACUUM`） |

    ⚠️ 这两条 PRAGMA 都**不能在事务里**执行（`VACUUM` 会直接报错），所以这里绕过 SQLAlchemy
    的隐式事务、用 DBAPI 连接的 autocommit 模式跑。
    """
    eng = engine or default_engine
    raw = eng.raw_connection()
    try:
        dbapi = getattr(raw, "driver_connection", raw)
        dbapi.isolation_level = None            # 关掉隐式事务（sqlite3 的 autocommit）
        cur = dbapi.cursor()
        try:
            auto_vacuum = int(cur.execute("PRAGMA auto_vacuum").fetchone()[0])
            page_size = int(cur.execute("PRAGMA page_size").fetchone()[0])
            page_count = int(cur.execute("PRAGMA page_count").fetchone()[0])
            if auto_vacuum != 0:
                return "already"
            if page_size * page_count > max_bytes:
                logger.info(
                    f"数据库 {page_size * page_count / 1048576:.0f}MB 超过 "
                    f"{max_bytes / 1048576:.0f}MB，跳过 auto_vacuum 切换"
                    f"（全库 VACUUM 的临时空间与耗时都不划算）")
                return "skipped-large"
            cur.execute("PRAGMA auto_vacuum=INCREMENTAL")
            cur.execute("VACUUM")
            cur.execute("PRAGMA incremental_vacuum")   # 立刻把已有的空闲页还掉
            # ⚠️ 真库实测（2026-09-16）：WAL 模式下 `VACUUM` 会把**整库重写进 WAL** ——
            # 不 checkpoint 的话磁盘上会多出约等于库大小的一份 WAL（54.3MB 的库变成
            # "库 50.9MB + WAL 54MB"），而我们做这件事的初衷正是省地方。
            cur.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return "converted"
        finally:
            cur.close()
    finally:
        raw.close()


def checkpoint_wal(engine: Engine | None = None) -> dict[str, int]:
    """把 WAL 并回主库并**截断 WAL 文件**，返回 `{"before": b, "after": b}` 字节数。

    为什么必须有这一步（真库实测，2026-09-16）：WAL 模式下 `VACUUM` 会把**整库重写进 WAL** ——
    54.3MB 的库在切换 auto_vacuum 之后留下 **54MB 的 WAL**，`dir_stats()` 一眼看出
    "库怎么突然变 105MB"。它还不会自己消失：只有**最后一个连接关闭**时 SQLite 才会
    checkpoint，而应用自己就握着一池连接。

    启动时（几乎没有并发）做一次最划算；已经切换过的库也走这条路 ——
    否则上一次留下的胖 WAL 会一直躺在磁盘上。
    """
    eng = engine or default_engine
    raw = eng.raw_connection()
    try:
        dbapi = getattr(raw, "driver_connection", raw)
        dbapi.isolation_level = None
        cur = dbapi.cursor()
        try:
            before = _file_bytes(Path(str(_database_path()) + "-wal"))
            cur.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            after = _file_bytes(Path(str(_database_path()) + "-wal"))
            if before:
                logger.info(
                    f"WAL 已回收：{before / 1048576:.1f}MB → {after / 1048576:.1f}MB")
            return {"before": before, "after": after}
        finally:
            cur.close()
    except Exception as e:  # noqa: BLE001 - 收不回来也不该影响启动
        logger.warning(f"WAL 回收失败（不影响启动）: {e}")
        return {"before": 0, "after": 0}
    finally:
        raw.close()


def incremental_vacuum(engine: Engine | None = None) -> int:
    """把 freelist 里的空闲页还给系统，返回释放的页数（非增量模式下是 0/no-op）。

    调用点：**破坏性清理之后**（解除订阅 / 删除账号 / 清空归档）—— 那时才会产生大量空闲页。
    故意不做成"每次写都调"：它有真实成本，而绝大多数写不会产生空闲页。
    """
    eng = engine or default_engine
    raw = eng.raw_connection()
    try:
        dbapi = getattr(raw, "driver_connection", raw)
        dbapi.isolation_level = None
        cur = dbapi.cursor()
        try:
            before = int(cur.execute("PRAGMA freelist_count").fetchone()[0])
            if before <= 0:
                return 0
            cur.execute("PRAGMA incremental_vacuum")
            after = int(cur.execute("PRAGMA freelist_count").fetchone()[0])
            freed = max(0, before - after)
            if freed:
                logger.info(f"数据库回收空闲页：{freed} 页")
            return freed
        finally:
            cur.close()
    except Exception as e:  # noqa: BLE001 - 回收失败不该影响业务结果
        logger.warning(f"数据库空闲页回收失败（不影响本次操作）: {e}")
        return 0
    finally:
        raw.close()
