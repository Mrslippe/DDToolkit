# -*- coding: utf-8 -*-
"""录播**来源条目**的前处理（C1 扩展，2026-10-14，`docs/plans/vod-autofill.md` B1）。

## 为什么需要它

录播不只有一种形态，而"从投稿流里捞"尤其脏：

| 形态 | 实测 | 前处理的必要性 |
|---|---|---|
| **系列（series）** | 明前奶绿「直播回放」`series_id=2484684`，942 条 | 干净，但**942/942 标题都带 `YYYY年M月D日HH点场`** ⇒ 时间可以直接读 |
| **合集（season）** | 同号「黑神话合集」15 条 | 同系列 |
| **投稿流** | 本仓现用 `arc/search` 那条路 | **混着切片/翻唱/音声**，必须先筛 |

实测（2026-10-14）该系列时长中位 **17904s ≈ 5.0h**（p25 15730 / p75 19023），
<10 分钟的只有 **15** 条 —— 那 15 条既不是录播、又会污染"时长接近"这条最强的信号，
所以 `classify` 把它们直接标成 `excluded`。

## 分层纪律

本模块**纯函数、不碰网络、不碰库**：标题怎么写、什么算录播，是可以离线判的规则；
取数在 `app/services/vod_source.py`。这样"标题解析对不对"能拿真标题当用例锁住。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

#: 录播条目之间的时间去重粒度：同一条直播可能被切成多段上传，
#: 但标题里的"场次时刻"只到分钟 ⇒ 比较时按分钟对齐。
MINUTE = timedelta(minutes=1)

# ── 分级 ──────────────────────────────────────────────────────────────

#: 明确是"整场回放"的词（实测该系列 942/942 都带，前缀统一 `【直播回放】`）
REPLAY_TOKENS: tuple[str, ...] = ("直播回放", "回放", "录播", "直播录像")

#: **无条件排除**：这些词出现就说明这**不是一场直播的录像**（切片/剪辑/翻唱/音声…）。
#: ⚠️ 刻意不包含「切片」单独一刀切 —— 有人的回放标题会写"X月X日直播切片"，
#:    那仍是整场；「切片」只在**标题里出现多次**（=合集本身是切片集）时才排除，
#:    见 `WEAK_EXCLUDE`。
EXCLUDE_ALWAYS: tuple[str, ...] = ("翻唱", "cover", "音声", "广播剧", "手书", "mmd")

#: **弱排除**：只在"标题里反复出现"（≥2 次）或"时长很短"时才排除。
WEAK_EXCLUDE: tuple[str, ...] = ("切片", "剪辑", "cut")

#: 短于这个时长的一律不是录播（实测那 15 条就是这一档）
MIN_REPLAY_SECONDS = 600

#: 兜底路径（没有可读时间时）要求的最短时长：比上面宽，因为兜底本来就更弱
MIN_FALLBACK_SECONDS = 1800

#: 「早场」的小时上界（含）：标题写 0–5 点时，**日期按前一天理解**（录播号惯例，见
#: `parse_time_hint`）。匹配时给这类时刻一个更宽的窗口（`EARLY_TOLERANCE_MINUTES`）。
EARLY_HOUR_MAX = 5

#: 早场用的窗口（分钟）：从"前一天 19:00 开的播"到"当天 05:00 标的时刻"最多差 10 小时，
#: 取 6 小时够覆盖绝大多数（19:00→01:00 是 6 小时）；再宽就会碰到相邻场次了。
EARLY_TOLERANCE_MINUTES = 360


def matching_tolerance(hint: "TimeHint | None", default_minutes: int) -> int:
    """这条标题该用多大的时间窗（分钟）。

    - `date_only`（标题只给日期）⇒ 返回 `-1`，表示**按"同一天"匹配**（调用方自己判），
      不要拿那个 00:00 去算时间差；
    - 早场（0–5 点）⇒ `EARLY_TOLERANCE_MINUTES`（日期很可能是前一天）；
    - 其余 ⇒ 调用方给的默认值（实测 90 分）。
    """
    if hint is None:
        return default_minutes
    if hint.date_only:
        return -1
    if hint.at.hour <= EARLY_HOUR_MAX:
        return EARLY_TOLERANCE_MINUTES
    return default_minutes


@dataclass(frozen=True)
class TimeHint:
    """从标题里读出来的场次时刻（**北京墙上时间**，与录播号写标题的口径一致）。"""

    #: 解析到的时刻（已按发布时间补年）
    at: datetime
    #: 标题里是否含年份（不含时是**补**出来的 ⇒ 置信度略低，交调用方决定怎么用）
    year_from_title: bool
    #: **标题只给了日期、没给时刻**（`… 2026年10月11日`）—— 匹配时按"同一天"处理，
    #: 不拿这个 00:00 去算时间差（拿它算会把一场晚 8 点的直播算成差 20 小时）。
    date_only: bool = False


# ── 标题时间解析 ──────────────────────────────────────────────────────

#: `2026年10月11日18点场` / `2026年10月11日 18:30` / `2026-10-11 18:00`
_DATE_CN = re.compile(r"(?P<y>\d{4})\s*[年\-/.]\s*(?P<mo>\d{1,2})\s*[月\-/.]\s*(?P<d>\d{1,2})\s*日?")
_TIME_CN = re.compile(r"(?P<h>\d{1,2})\s*[点时]\s*(?:(?P<mi>\d{2})\s*分?)?")
#: ISO 写法的时间：`2026-10-11 18:30` / `2026/10/11 18:30`。
#: ⚠️ 上面那条 `_TIME_CN` 只认「点/时」，实测**吃不到**这种写法 —— 会静默退化成"只解到日期"，
#: 于是这一条录播与场次差 18 小时、被当成配不上（2026-10-14 探针抓到）。
_TIME_ISO = re.compile(r"(?P<h>\d{1,2}):(?P<mi>\d{2})")
#: 无年份：`10月11日18点场`（实测存在这种写法）
_DATE_CN_NO_YEAR = re.compile(r"(?<![\d年])(?P<mo>\d{1,2})\s*月\s*(?P<d>\d{1,2})\s*日")


def _safe_dt(y: int, mo: int, d: int, h: int, mi: int) -> datetime | None:
    try:
        return datetime(y, mo, d, h, mi)
    except ValueError:                 # 上游标题写错日期（2月30日之类）不该炸掉整条扫描
        return None


def parse_time_hint(title: str | None, *, published_at: datetime | None = None
                    ) -> TimeHint | None:
    """标题 → 场次时刻（北京墙上时间）；读不出返回 `None`。

    `published_at`（北京时间或 UTC 皆可，只取日期）用来**给没有年份的标题补年**：
    录播一定发布在直播**之后**，所以"标题月日 + 发布年"若晚于发布日 2 天以上，
    那这条标题指的是**上一年**的同一月日（跨年场次，实测存在的形态）。
    """
    text = (title or "").strip()
    if not text:
        return None
    m = _DATE_CN.search(text)
    year_from_title = m is not None
    if m:
        y, mo, d = int(m.group("y")), int(m.group("mo")), int(m.group("d"))
    else:
        m2 = _DATE_CN_NO_YEAR.search(text)
        if not m2 or published_at is None:
            return None
        mo, d = int(m2.group("mo")), int(m2.group("d"))
        y = published_at.year
        guess = _safe_dt(y, mo, d, 0, 0)
        if guess is None:
            return None
        # 补出来的日子比发布日还晚 ⇒ 说的是去年
        if guess.date() > published_at.date() + timedelta(days=2):
            guess = _safe_dt(y - 1, mo, d, 0, 0)
            if guess is None:
                return None
        y = guess.year

    # 时间：取日期之后的第一个 `N点`/`N:MM`；没有 ⇒ **只给了日期**（`date_only`）
    tail = text[m.end():] if m else text[m2.end():]      # type: ignore[union-attr]
    date_only = False
    t = _TIME_CN.search(tail)
    if t:
        h = int(t.group("h"))
        mi = int(t.group("mi") or 0)
    else:
        t = _TIME_ISO.search(tail)
        if t:
            h = int(t.group("h"))
            mi = int(t.group("mi"))
        else:
            h = mi = 0
            date_only = True
    if h > 23 or mi > 59:              # 「24点」「18点70分」这种脏值：退化成只用日期
        h = mi = 0
        date_only = True
    at = _safe_dt(y, mo, d, h, mi)
    if at is None:
        return None
    # ⚠️ **凌晨场（0–5 点）的日期是"前一天"** —— 录播号的惯例（用户 2026-10-15 指出）：
    #    「非官方录播号可能上传时间和直播时间有很大差距，但会在标题中标明日期」，
    #    而实测那批同人录播号更细一层：**凌晨开的播按前一天写日期**
    #    （`【直播回放】吃饱了来一下 2026年06月07日00点场` 对应的场次在 **06-06**）。
    #    ⇒ 这里**不再把 00:00 特殊处理**（旧版只给 `h == 0` 打了一天补丁，1–5 点照样错），
    #    改成把"早场"这件事交给**匹配容差**去表达：`EARLY_HOUR_MAX` 以内的时刻，
    #    `matching_tolerance()` 会给一个更宽的窗口，让它能配到前一天那一场。
    return TimeHint(at=at, year_from_title=year_from_title, date_only=date_only)


# ── 分级 ──────────────────────────────────────────────────────────────

def _count_hits(text: str, words: tuple[str, ...]) -> int:
    low = text.lower()
    return sum(low.count(w.lower()) for w in words)


def classify(title: str | None, duration_seconds: int | None,
             published_at: datetime | None = None) -> tuple[str, TimeHint | None]:
    """一条来源条目 → `(tier, 时间提示)`。

    | tier | 判据 | 调用方拿它干什么 |
    |---|---|---|
    | `excluded` | 时长 < 10 分钟 / 标题含 `EXCLUDE_ALWAYS` / 弱排除词出现 ≥2 次 | 直接丢掉 |
    | `replay` | 有可读时间 **且** 标题含回放词 | 按时间对齐场次（高置信） |
    | `dated` | 有可读时间，但没有回放词 | 也能按时间对齐，置信度略低 |
    | `weak` | 既没时间也不像回放 | 只能靠"发布时间 + 时长"兜底 |

    ⚠️ 时长**未知**（`None`）不等于短 —— 不因此排除，交后续按别的信号判。
    """
    text = (title or "").strip()
    if _count_hits(text, EXCLUDE_ALWAYS) > 0:
        return "excluded", None
    if _count_hits(text, WEAK_EXCLUDE) >= 2:
        return "excluded", None
    if duration_seconds is not None and duration_seconds < MIN_REPLAY_SECONDS:
        return "excluded", None

    hint = parse_time_hint(text, published_at=published_at)
    if hint is not None:
        return ("replay" if _count_hits(text, REPLAY_TOKENS) > 0 else "dated"), hint
    return "weak", None
