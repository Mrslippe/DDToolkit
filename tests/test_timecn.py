"""时间口径的回归测试（2026-10-20）。

锁住三件事：
1. `utc_iso()` 写的是 UTC，不随机器时区漂移；
2. 分天按**东八区**：UTC 的 10-19 23:30 属于本地的 10-20；
3. SQL 表达式 `sql_day()` 与 Python 的 `cn_day()` 逐条一致（含跨日与边界）。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from app.core.timecn import CN_TZ, cn_day, day_bounds_utc, parse_utc, sql_day, utc_iso


def test_utc_iso_is_utc_regardless_of_machine_tz():
    # 2026-10-19 23:30:00 UTC
    ms = int(datetime(2026, 10, 19, 23, 30, tzinfo=timezone.utc).timestamp() * 1000)
    assert utc_iso(ms) == "2026-10-19 23:30:00.000000"


@pytest.mark.parametrize(
    ("utc_s", "expect"),
    [
        ("2026-10-19 23:30:00.000000", "2026-10-20"),  # 跨日：本地 07:30
        ("2026-10-19 15:59:59.000000", "2026-10-19"),  # 本地 23:59:59
        ("2026-10-19 16:00:00.000000", "2026-10-20"),  # 本地 00:00:00
        ("2026-10-01 03:00:00.000000", "2026-10-01"),
    ],
)
def test_cn_day_shifts_across_midnight(utc_s: str, expect: str):
    assert cn_day(utc_s) == expect


def test_sql_day_matches_python_on_edges():
    """SQL 的 `date(col, '+8 hours')` 必须与 `cn_day()` 完全一致。"""
    con = sqlite3.connect(":memory:")
    con.execute("create table t (start_at text)")
    samples = [
        "2026-10-19 15:59:59.000000",
        "2026-10-19 16:00:00.000000",
        "2026-10-19 23:30:00.000000",
        "2026-10-20 00:00:00.000000",
        "2026-12-31 16:00:00.000000",
    ]
    con.executemany("insert into t values (?)", [(s,) for s in samples])
    got = [r[0] for r in con.execute(f"select {sql_day('start_at')} from t order by start_at")]
    assert got == [cn_day(s) for s in sorted(samples)]


def test_day_bounds_utc():
    lo, hi = day_bounds_utc("2026-10-20")
    assert lo == "2026-10-19 16:00:00"
    assert hi == "2026-10-20 15:59:59"


def test_parse_utc_is_explicit():
    dt = parse_utc("2026-10-19 23:30:00.000000")
    assert dt is not None and dt.tzinfo is not None
    assert dt.astimezone(CN_TZ).strftime("%Y-%m-%d %H:%M") == "2026-10-20 07:30"
    assert parse_utc("") is None
    assert parse_utc("not a time") is None
