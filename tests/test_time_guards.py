"""时间口径的**静态守卫**（2026-10-20）。

这不是功能测试，而是"防止口径再次跑偏"的网：

1. 后端 `app/` 里不允许出现**裸的** `datetime.fromtimestamp(x)` —— 必须显式给 `tz=`，
   否则取的是机器本地时区（569/570 两次事故的共同根因）；
2. 不允许再写 `date(<列>)` 做分天 —— 必须走 `timecn.sql_day()`（东八区）。
   白名单：`timecn.py` 自身、以及注释/字符串里提到的地方。

已知豁免写在 `ALLOW` 里，新增豁免需要写理由（这条规则靠人守，靠测试提醒）。
"""

from __future__ import annotations

import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"

#: (文件相对路径, 行内必须包含的标记) —— 豁免要写清理由
ALLOW: set[tuple[str, str]] = {
    # 业务上就是"本地时刻"的地方：免打扰时段、文件名时间戳、登录时长
    ("services/scheduler.py", "quiet_hours"),
    ("services/db_maintenance.py", "strftime"),
    ("services/auth.py", "days"),
    ("services/douyin_auth.py", "days"),
    ("services/xhs_auth.py", "days"),
    ("services/vtuber_repo.py", "datetime.now()"),
    ("routers/vtuber.py", "datetime.now(timezone.utc)"),
}

FROMTS = re.compile(r"datetime\.fromtimestamp\(")
DATE_COL = re.compile(r"\bdate\(\s*[a-zA-Z_][\w.]*")


def _iter_py():
    for p in sorted(APP.rglob("*.py")):
        if "__pycache__" in p.parts or p.name == "timecn.py":
            continue
        yield p


def test_no_naive_fromtimestamp() -> None:
    bad: list[str] = []
    for p in _iter_py():
        rel = p.relative_to(APP).as_posix()
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if not FROMTS.search(line) or "tz=" in line:
                continue
            if any(rel == a and marker in line for a, marker in ALLOW):
                continue
            bad.append(f"{rel}:{i}  {line.strip()[:80]}")
    assert not bad, "裸的 datetime.fromtimestamp()（必须显式给 tz=）：\n" + "\n".join(bad)


def test_no_utc_day_grouping() -> None:
    """SQL 里不允许 `date(列)` 直接分天（那是 UTC 日），必须走 sql_day()。"""
    bad: list[str] = []
    for p in _iter_py():
        rel = p.relative_to(APP).as_posix()
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if "#" in line.split("date(")[0]:
                continue
            if not DATE_COL.search(line):
                continue
            if "sql_day" in line or "+8 hours" in line:
                continue
            bad.append(f"{rel}:{i}  {line.strip()[:80]}")
    assert not bad, "SQL 分天必须经 timecn.sql_day()（东八区）：\n" + "\n".join(bad)
