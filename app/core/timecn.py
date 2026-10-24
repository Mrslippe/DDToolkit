"""时间口径的**唯一真源**（2026-10-20）。

## 为什么需要它

这一版之前，时间处理散落在各处，口径互相矛盾，实测造成过两次真实故障：

1. **写侧**：采集用 `datetime.fromtimestamp()`（本地时间）写 `start_at`，
   而库与展示层是 UTC ⇒ 东八区机器上新采数据整体 **+8 小时**（dev 库 227 场里 76 场如此）；
2. **读侧**：SQL 用 `date(start_at)` 分天 ⇒ 按 **UTC 日**切分，而使用者心里的"那一天"是**本地日**，
   于是当地 00:00–08:00 开播的场次会落到**前一天**的格子里，且这种偏移在图上不可见。

## 三层口径（全项目只认这三条）

| 层 | 口径 | 谁负责 |
|---|---|---|
| 存储 | **UTC**，naive 字符串 `YYYY-MM-DD HH:MM:SS.ffffff` | 写入方必须用本模块的 `utc_iso()` |
| 分天 / 分月 / 分年 | **东八区（UTC+8）** | SQL 用 `sql_day()`；Python 用 `cn_day()` |
| 展示 | 浏览器本地时区 | 前端 `new Date(...)`，后端只给 UTC 或带时区偏移 |

## 用法

```python
from app.core.timecn import CN_TZ, utc_iso, cn_day, sql_day, day_bounds_utc

utc_iso(1_700_000_000_000)              # 写入用
cn_day("2026-10-19 23:30:00.000000")    # -> "2026-10-20"（跨日）
sql_day("s.start_at")                   # SQL 片段：date(s.start_at, '+8 hours')
day_bounds_utc("2026-10-20")            # -> ("2026-10-19 16:00:00", "2026-10-20 15:59:59")
```

⚠️ **不要**再直接写 `date(s.start_at)` 或裸用 `datetime.fromtimestamp()` ——
前者按 UTC 分天，后者按机器本地时区，二者都会在单测里被抓（见 `tests/test_timecn.py`）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

#: 业务时区：东八区。用固定偏移而非 tzdata —— 中国自 1991 年起无夏令时，
#: 固定 +8 更简单且不依赖系统时区库。若将来有跨时区需求，再换 `zoneinfo`。
CN_TZ = timezone(timedelta(hours=8), "UTC+8")

#: SQLite 的时间修饰符：把 UTC 时间戳平移到东八区（仅用于取日期部分）
SQL_SHIFT = "+8 hours"


def utc_iso(ms: int | float) -> str:
    """毫秒时间戳 → **UTC** 的 `YYYY-MM-DD HH:MM:SS.ffffff`（naive，与库内格式一致）。"""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


def parse_utc(s: str) -> datetime | None:
    """把库里的 naive 字符串按 **UTC** 解释成 aware datetime。解析失败返回 None。"""
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            try:
                # 切片里存的是分钟精度（`[:16]`），也要认
                return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
            except ValueError:
                return None


def cn_day(s: str) -> str:
    """UTC 字符串 → **东八区日期** `YYYY-MM-DD`。无法解析时退回原串前 10 位。"""
    dt = parse_utc(s)
    return dt.astimezone(CN_TZ).strftime("%Y-%m-%d") if dt else str(s)[:10]


def cn_text(s: str, fmt: str = "%Y-%m-%d %H:%M") -> str:
    """UTC 字符串 → **东八区展示串**。

    凡是"把库里的时间给前端看"都走这里 —— 少了它就会出现"与场次时间差 8 小时"那类 bug
    （2026-10-24 用户发现详情 tooltip 的时间对不上，就是名字里少了这一步）。
    解析失败时退回原串前 16 位（宁可显示旧值，也不要抛错把整页带崩）。
    """
    dt = parse_utc(s)
    return dt.astimezone(CN_TZ).strftime(fmt) if dt else str(s)[:16]


def sql_day(column: str = "s.start_at") -> str:
    """SQL 片段：把 UTC 列转成**东八区日期**。全项目分天只用它。"""
    return f"date({column}, '{SQL_SHIFT}')"


def day_bounds_utc(day: str) -> tuple[str, str]:
    """本地日期 → 该日在 **UTC** 下的闭区间边界（用于索引友好的范围过滤）。"""
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=CN_TZ)
    return (
        start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        (start + timedelta(days=1) - timedelta(seconds=1)).astimezone(timezone.utc)
        .strftime("%Y-%m-%d %H:%M:%S"),
    )
