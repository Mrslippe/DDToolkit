# -*- coding: utf-8 -*-
"""诊断包（批次 16，devlog/207）：把"用户能发给你的一份东西"拼出来。

## 为什么需要它

"很多人用"之后，故障现场在**别人的机器**上：你看不见 `sidecar.log`、不知道他的库是哪个
schema 版本、也不知道上次迁移是不是失败过。今天的材料散在三处（`window.__bootLog` /
`logs/` 三个文件 / 壳的 `shell.log`），**没有"一键导出成一份能给开发者看的东西"**。

## 口径（两条，都有判据）

1. ⚠️ **绝不含凭据**：`.env`（B 站 SESSDATA / refresh_token、微博 cookie）、会话 token、
   图片代理的 cookie **一律不读、不拼**（`ARCHITECTURE.md` §6 第 10 条 + 第 26 条）。
   这条不靠"我记得别加"，靠 `tests/test_migration_safety.py` 里那条
   "植一个哨兵密码 / 哨兵 token ⇒ 断言不在输出里"。
2. **宁可截断也不能没有**：日志只取尾部若干行 + 总量封顶 —— 一份 500MB 的日志对
   排查没帮助，而"发不出来"等于没有。（截断处显式写出被截掉多少行。）

形式是**纯文本**（`{filename, text}`），前端"复制到剪贴板"即可 —— 不引入 zip/文件写入
依赖，也不碰"把文件写到用户磁盘哪里"这个新问题。
"""
from __future__ import annotations

import logging
import platform
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.services import db_maintenance

logger = logging.getLogger(__name__)

#: 每个日志文件最多取多少行（尾部）
LOG_TAIL_LINES = 120
#: 整份诊断包的字符上限（超了就只留头 + 最后一段，并显式标注截断）
MAX_CHARS = 200_000

_LOG_FILES = ("app.log", "sidecar.log", "shell.log")


def _tail(path: Path, lines: int = LOG_TAIL_LINES) -> str:
    """日志尾部若干行（文件不存在/读不到就明说，不抛）。"""
    if not path.is_file():
        return "（不存在）"
    try:
        raw = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        return f"（读不到：{e}）"
    if not raw:
        return "（空文件）"
    tail = raw[-lines:]
    head = f"（共 {len(raw)} 行，下面是最新 {len(tail)} 行）" if len(raw) > len(tail) else ""
    return (head + "\n" if head else "") + "\n".join(tail)


def _db_shape() -> str:
    """库形态：文件大小、schema 版本、表与行数。**只读**，而且不碰 `.env`。"""
    from app.main import MIGRATION_HEAD      # 局部 import：避免 main ↔ services 的循环

    db = db_maintenance.database_path()
    if not db.is_file():
        return f"库文件：{db}（不存在）"
    sizes = []
    for suffix, label in (("", "主库"), ("-wal", "WAL"), ("-shm", "SHM")):
        p = Path(str(db) + suffix)
        sizes.append(f"{label}={p.stat().st_size / 1048576:.1f}MB" if p.is_file()
                     else f"{label}=-")
    out = [f"库文件：{db}", "体积：" + " ".join(sizes)]
    try:
        con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
        try:
            rev = con.execute("SELECT version_num FROM alembic_version").fetchone()
            out.append(f"schema 版本：{rev[0] if rev else '（无 alembic_version）'}"
                       f"（代码里的 head={MIGRATION_HEAD}）")
            names = [r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            out.append(f"表（{len(names)}）：{', '.join(names)}")
            for t in ("vtubers", "accounts", "posts", "live_sessions"):
                if t in names:
                    n = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                    out.append(f"  · {t}: {n} 行")
        finally:
            con.close()
    except Exception as e:      # noqa: BLE001 - 库读不动也要能出诊断包（那正是要诊断的情况）
        out.append(f"（读库失败：{type(e).__name__}: {e}）")
    return "\n".join(out)


def _data_dir_survey() -> str:
    """备份 / 隔离库 / 遗留备份：**用户找回数据要看的三个位置**。"""
    data = Path(settings.DATA_DIR)
    lines = []
    backups = db_maintenance.list_backups()
    lines.append(f"备份目录：{db_maintenance.backups_dir()}")
    if backups:
        for b in backups:
            wal = f" + WAL {b['wal_bytes'] / 1048576:.1f}MB" if b["wal_bytes"] else ""
            lines.append(f"  · {b['name']}（{b['bytes'] / 1048576:.1f}MB{wal}）")
    else:
        lines.append("  （还没有备份）")
    for pattern in ("vtuber.db.failed-*", "vtuber.db.bak-*"):
        found = sorted(p.name for p in data.glob(pattern))
        if found:
            lines.append(f"{pattern}：{', '.join(found)}")
    return "\n".join(lines)


def build_diagnostics(*, now: datetime | None = None) -> dict[str, Any]:
    """拼出一份纯文本诊断包，返回 `{filename, text, bytes, generated_at}`。"""
    from app.main import migration_state          # 局部 import：避免 main ↔ services 的循环

    ts = (now or datetime.now(timezone.utc))
    data = Path(settings.DATA_DIR)
    parts: list[str] = [
        "DDToolkit 诊断包（可以整份发给开发者）",
        f"生成时间：{ts.isoformat()}",
        f"应用版本：{settings.VERSION}",
        f"操作系统：{platform.platform()}",
        f"Python：{sys.version.split()[0]}（{platform.python_implementation()}）",
        "",
        "── 数据目录 ──",
        f"{data}",
        "",
        "── 本次启动的 schema 迁移 ──",
        # 这一块是"迁移失败"现场的核心：状态、错误、被隔离的库、备份位置
        "\n".join(f"{k}: {v}" for k, v in migration_state().items()) or "（未跑）",
        "",
        "── 数据库形态 ──",
        _db_shape(),
        "",
        "── 备份 / 隔离库 / 遗留备份 ──",
        _data_dir_survey(),
        "",
        "── 数据目录占用 ──",
    ]
    try:
        st = db_maintenance.dir_stats()
        for name, g in st["groups"].items():
            parts.append(f"{name}: {g['bytes'] / 1048576:.1f}MB / {g['files']} 文件")
        parts.append(f"磁盘可用：{st['disk']['free'] / 1073741824:.1f}GB"
                     f" / 共 {st['disk']['total'] / 1073741824:.1f}GB")
        parts.append(f"总占用：{st['total_bytes'] / 1048576:.1f}MB")
    except Exception as e:      # noqa: BLE001
        parts.append(f"（体检失败：{type(e).__name__}: {e}）")

    parts.append("")
    parts.append("── 日志尾部 ──")
    for name in _LOG_FILES:
        parts.append(f"··· logs/{name} ···")
        parts.append(_tail(data / "logs" / name))
        parts.append("")

    text = "\n".join(parts)
    if len(text) > MAX_CHARS:
        # 头部信息最重要（版本/迁移/库形态），日志尾部次要 ⇒ 保头 + 留个尾巴
        keep_tail = MAX_CHARS // 4
        text = (text[:MAX_CHARS - keep_tail]
                + f"\n…（诊断包超过 {MAX_CHARS} 字符，中间已截断）…\n"
                + text[-keep_tail:])
    return {
        "filename": f"ddtoolkit-diagnostics-{ts.strftime('%Y%m%d-%H%M%S')}.txt",
        "text": text,
        "bytes": len(text.encode("utf-8")),
        "generated_at": ts.isoformat(),
    }
