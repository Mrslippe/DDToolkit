"""粉丝结构分析 · 展示标签（P3）。

## 标签是什么，不是什么

标签只描述**"这个人做过什么"**（极端的单一事实），**不描述"这个人有多核心"** ——
核心度由三轴分位与强度负责。因此标签**不参与排序**，只用于展示与筛选。

## 2026-10-24 重构：10 条，阈值统一为「池内分位」

旧的 13 条有几个问题：无标签用户占 53%、舰长/几乎不言两个标签吃掉近一半、
绝对金额（千元户）与相对分位（大额打米）混用导致跨 V 不可比。重构后：

| 标签 | 条件 |
|---|---|
| 舰长 / 提督 / 总督 | 持有对应最高大航海等级（互斥） |
| 黑听民 | 出席 ≥10 场，且场均弹幕在本池**最低 5%** |
| 互动民 | 场均弹幕在本池**前 1%** |
| 老头 | 累计付费在本池**前 1%** |
| sc民 | 在 ≥10 个不同场次打过 SC |
| 全勤 | 窗口内每一场都出席 |
| 新人 | 首次出现落在窗口**最后 25%** |
| 独轮车 | 被独轮车判定命中（`win.spam`，规则名见 `spam.py`） |

**阈值一律相对池内** —— 同一个标签在不同主播之间的含义可比。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.services.fan.axes import AxisTable
from app.services.fan.loader import UserFact, Window

#: 黑听民 / sc民 的最低出席场次
MIN_SESSIONS_FOR_TAGS = 10
#: 分位阈值
P99 = 0.99
P05 = 0.05
#: 新人：首次出现位置门槛（0=窗口起点，1=终点）
NEWCOMER_FIRST_POS = 0.75
#: sc民：打过 SC 的场次数
SC_SESSIONS = 10

TAG_CAPTAIN = "舰长"
TAG_ADMIRAL = "提督"
TAG_GOVERNOR = "总督"
TAG_LURKER = "黑听民"
TAG_CHATTY = "互动民"
TAG_WHALE = "老头"
TAG_SC = "sc民"
TAG_FULL = "全勤"
TAG_NEW = "新人"
TAG_SPAM = "独轮车"


@dataclass(frozen=True)
class TagContext:
    """判标签需要的**池内**参照量。"""

    n_sessions: int
    pay_p99: float
    msg_pm_p99: float      # 场均弹幕 p99
    msg_pm_p05: float      # 场均弹幕 p5（黑听民）


@dataclass(frozen=True)
class TagRule:
    name: str
    desc: str
    pred: Callable[[UserFact, TagContext], bool]


def _pm(u: UserFact) -> float:
    """场均弹幕（出席场次为分母）。"""
    return u.m / max(1, u.att_n)


#: ⚠️ 出勤类一律用 `att_n`（场次数），不是出席率；场均类用 `_pm`。
RULES: tuple[TagRule, ...] = (
    TagRule(TAG_CAPTAIN, "持有「舰长」（不含提督/总督）",
            lambda u, c: u.guard_top == "舰长"),
    TagRule(TAG_ADMIRAL, "持有「提督」",
            lambda u, c: u.guard_top == "提督"),
    TagRule(TAG_GOVERNOR, "持有「总督」",
            lambda u, c: u.guard_top == "总督"),
    TagRule(TAG_LURKER, f"出席 ≥{MIN_SESSIONS_FOR_TAGS} 场，且场均弹幕在本池最低 5%",
            lambda u, c: u.att_n >= MIN_SESSIONS_FOR_TAGS and _pm(u) <= c.msg_pm_p05),
    TagRule(TAG_CHATTY, "场均弹幕进本池前 1%",
            lambda u, c: _pm(u) >= c.msg_pm_p99 and c.msg_pm_p99 > 0),
    TagRule(TAG_WHALE, "累计付费进本池前 1%",
            lambda u, c: u.pay >= c.pay_p99 and c.pay_p99 > 0),
    TagRule(TAG_SC, f"在 ≥{SC_SESSIONS} 个不同场次打过 SC",
            lambda u, c: u.sc_sess >= SC_SESSIONS),
    TagRule(TAG_FULL, "窗口内每一场都出席",
            lambda u, c: u.att_n >= c.n_sessions),
    TagRule(TAG_NEW, "首次出现落在窗口最后 25%",
            lambda u, c: u.first_pos >= NEWCOMER_FIRST_POS),
)


def explain() -> list[tuple[str, str]]:
    """`[(标签, 条件说明)]`，给界面写说明用。"""
    return [(r.name, r.desc) for r in RULES] + [
        (TAG_SPAM, "被独轮车判定命中（不同文本率 ≤20%）"),
    ]


def _q(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    return xs[min(len(xs) - 1, int(len(xs) * p))]


def tag_context(win: Window, table: AxisTable | None = None) -> TagContext:
    """按**入选池**的分位算参照量；没有入池时退化为 0（分位类标签不会命中）。"""
    pool = list(table.uids) if table is not None else [
        u.uid for u in win.users.values() if u.att_n / max(1, win.n) >= 0.10]
    pays = sorted(win.users[uid].pay for uid in pool if uid in win.users)
    msgs = sorted(_pm(win.users[uid]) for uid in pool if uid in win.users)
    return TagContext(
        n_sessions=win.n,
        pay_p99=_q(pays, P99),
        msg_pm_p99=_q(msgs, P99),
        msg_pm_p05=_q(msgs, P05),
    )


def tags_for(u: UserFact, ctx: TagContext, *, spam: str | None = None) -> list[str]:
    """一个用户的标签列表（可能为空）。`spam` 是独轮车规则名，非空则加「独轮车」。"""
    out: list[str] = []
    for rule in RULES:
        try:
            if rule.pred(u, ctx):
                out.append(rule.name)
        except (ZeroDivisionError, TypeError):
            continue
    if spam:
        out.append(TAG_SPAM)
    return out


def tag_all(win: Window, table: AxisTable | None = None) -> dict[str, list[str]]:
    """给窗口内**所有观测到的**用户打标签（不只入选者）。"""
    ctx = tag_context(win, table)
    return {
        uid: tags_for(u, ctx, spam=win.spam.get(uid))
        for uid, u in win.users.items()
    }


def prevalence(tags: dict[str, list[str]]) -> dict[str, float]:
    """每个标签的占比（分母是**全部观测用户**），给界面写"这个标签有多稀有"。"""
    n = max(1, len(tags))
    counts: dict[str, int] = {name: 0 for name, _ in explain()}
    for names in tags.values():
        for name in names:
            counts[name] = counts.get(name, 0) + 1
    return {k: v / n for k, v in counts.items()}
