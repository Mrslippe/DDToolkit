"""粉丝结构分析 · 展示标签（P3）。

对应规格 `plans/fan-model-spec.md` §4.5。

## 为什么标签单独一层

分量进合成 ⇒ 必须**稳定**（分半信度那一档）；
标签是**极端或稀有的单一事实**（"这个窗口每场都来"不保证下个窗口还成立）⇒ 天然不稳。

⇒ 标签只描述**"这个人做过什么"**，不描述**"这个人有多核心"**。
本模块的输出**不进入** `compose` 的任何函数，也不参与排序主键。

## 13 条标签

出勤类 3 条（满勤 / 常驻 / 新面孔）· SC 类 3 条 · 付费类 5 条 · 沉默类 2 条 · 话痨 1 条。
阈值全部是**具名常量**，改常量就要看用例是否还成立（施工计划铁律 3）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

from app.services.fan.axes import AxisTable, empirical_percentile
from app.services.fan.loader import UserFact, Window

# ── 具名常量（施工计划 A2）────────────────────────────────────────────────
#: "出席 ≥10 场"才谈得上"常来" —— 低于此数多数标签无意义
MIN_SESSIONS_FOR_TAGS = 10
#: 常驻：出席率门槛
REGULAR_FLOOR = 0.90
#: 每场SC：SC 场次占出席场次的比例门槛
EVERY_SESSION_SC_FLOOR = 0.80
#: 每场SC：至少出席多少场才判定
EVERY_SESSION_SC_MIN_ATT = 10
#: SC常客：至少多少个不同场次打过 SC
SC_REGULAR_SESSIONS = 10
#: 大额SC / 千元户：金额门槛（元）
BIG_SC_YUAN = 1000.0
BIG_PAY_YUAN = 1000.0
#: 大额打米 / 话痨：池内分位
P99_QUANTILE = 0.99
#: 新面孔：首次出现位置门槛（0=窗口起点，1=终点）
NEWCOMER_FIRST_POS = 0.75
#: 几乎不言：发言场次占比上限
SILENT_MSG_SESSION_RATE = 0.10

GUARD_ADMIRAL = ("提督", "总督")

TAG_FULL_ATTENDANCE = "满勤"
TAG_REGULAR = "常驻"
TAG_NEWCOMER = "新面孔"
TAG_EVERY_SESSION_SC = "每场SC"
TAG_SC_REGULAR = "SC常客"
TAG_BIG_SC = "大额SC"
TAG_BIG_PAY = "大额打米"
TAG_KILOYUAN = "千元户"
TAG_ADMIRAL = "提督+"
TAG_CAPTAIN = "舰长"
TAG_PURE_LURKER = "纯黑听"
TAG_BARELY_SPEAK = "几乎不言"
TAG_CHATTERBOX = "话痨"


@dataclass(frozen=True)
class TagContext:
    """判标签需要的池内参照量。"""

    n_sessions: int
    pay_p99: float
    msg_pm_p99: float   # 场均弹幕的 p99


@dataclass(frozen=True)
class TagRule:
    name: str
    desc: str
    pred: Callable[[UserFact, TagContext], bool]


#: 注意：出勤类用 `att_n`（场次数），**不是**出席率；话痨用场均 `msg_pm`。
#: 这两处口径写错过一次（把出席率当场次数、把总量除以出席率），见 `devlog/508`。
RULES: tuple[TagRule, ...] = (
    TagRule(TAG_FULL_ATTENDANCE, "窗口内每一场都出席",
            lambda u, c: u.att_n >= c.n_sessions),
    TagRule(TAG_REGULAR, "出席率 ≥90% 但未满勤",
            lambda u, c: REGULAR_FLOOR <= u.att_n / max(1, c.n_sessions) < 1.0),
    TagRule(TAG_NEWCOMER, "首次出现落在窗口最后 25%",
            lambda u, c: u.first_pos >= NEWCOMER_FIRST_POS),
    TagRule(TAG_EVERY_SESSION_SC, f"出席 ≥{EVERY_SESSION_SC_MIN_ATT} 场且 ≥80% 的场次都打了 SC",
            lambda u, c: (u.att_n >= EVERY_SESSION_SC_MIN_ATT
                          and u.sc_sess / max(1, u.att_n) >= EVERY_SESSION_SC_FLOOR)),
    TagRule(TAG_SC_REGULAR, f"在 ≥{SC_REGULAR_SESSIONS} 个不同场次打过 SC",
            lambda u, c: u.sc_sess >= SC_REGULAR_SESSIONS),
    TagRule(TAG_BIG_SC, f"累计 SC ≥ ¥{BIG_SC_YUAN:,.0f}",
            lambda u, c: u.pay > 0 and u.sc_cnt > 0 and _sc_amount_ge(u, BIG_SC_YUAN)),
    TagRule(TAG_BIG_PAY, "累计付费进本池前 1%",
            lambda u, c: u.pay >= c.pay_p99 and c.pay_p99 > 0),
    TagRule(TAG_KILOYUAN, f"累计付费 ≥ ¥{BIG_PAY_YUAN:,.0f}",
            lambda u, c: u.pay >= BIG_PAY_YUAN),
    TagRule(TAG_ADMIRAL, "持有「提督」或「总督」",
            lambda u, c: u.guard_top in GUARD_ADMIRAL),
    TagRule(TAG_CAPTAIN, "持有「舰长」（不含提督/总督）",
            lambda u, c: u.guard_top == "舰长"),
    TagRule(TAG_PURE_LURKER, f"出席 ≥{MIN_SESSIONS_FOR_TAGS} 场且从未发过一条弹幕",
            lambda u, c: u.att_n >= MIN_SESSIONS_FOR_TAGS and u.m == 0),
    TagRule(TAG_BARELY_SPEAK, f"出席 ≥{MIN_SESSIONS_FOR_TAGS} 场且发言场次占比 <10%",
            lambda u, c: (u.att_n >= MIN_SESSIONS_FOR_TAGS
                          and u.msg_sess / max(1, u.att_n) < SILENT_MSG_SESSION_RATE)),
    TagRule(TAG_CHATTERBOX, "场均弹幕进本池前 1%",
            lambda u, c: (u.m / max(1, u.att_n)) >= c.msg_pm_p99 and c.msg_pm_p99 > 0),
)


def _sc_amount_ge(u: UserFact, threshold: float) -> bool:
    """`UserFact` 没有单列 SC 金额，用累计付费是否达到门槛做保守代理。

    ⚠️ 严格说这是"付费达标且打过 SC"，比"SC 金额达标"宽。规格里已注明。
    """
    return u.pay >= threshold


def explain() -> list[tuple[str, str]]:
    """返回 [(标签, 条件说明)]，给界面写说明用。"""
    return [(r.name, r.desc) for r in RULES]


def tag_context(win: Window, table: AxisTable | None = None) -> TagContext:
    """按**入选池**的分位算参照量。没有入池时退化为 0（那样分位类标签不会命中）。"""
    pool = list(table.uids) if table is not None else [
        u.uid for u in win.users.values() if u.att_n / max(1, win.n) >= 0.10]
    pays = sorted((win.users[uid].pay for uid in pool if uid in win.users))
    msgs = sorted(((win.users[uid].m / max(1, win.users[uid].att_n))
                   for uid in pool if uid in win.users))

    def q(xs: list[float], p: float) -> float:
        if not xs:
            return 0.0
        return xs[min(len(xs) - 1, int(len(xs) * p))]

    return TagContext(
        n_sessions=win.n,
        pay_p99=q(pays, P99_QUANTILE),
        msg_pm_p99=q(msgs, P99_QUANTILE),
    )


def tags_for(u: UserFact, ctx: TagContext) -> list[str]:
    """一个用户的标签列表（可能为空）。"""
    out: list[str] = []
    for rule in RULES:
        try:
            if rule.pred(u, ctx):
                out.append(rule.name)
        except (ZeroDivisionError, TypeError):
            continue
    return out


def tag_all(win: Window, table: AxisTable | None = None) -> dict[str, list[str]]:
    """给窗口内**所有观测到的**用户打标签（不只入选者）。"""
    ctx = tag_context(win, table)
    return {uid: tags_for(u, ctx) for uid, u in win.users.items()}


def prevalence(tags: dict[str, list[str]]) -> dict[str, float]:
    """每个标签的占比（分母是**全部观测用户**），给界面写"这个标签有多稀有"。"""
    n = max(1, len(tags))
    counts: dict[str, int] = {r.name: 0 for r in RULES}
    for names in tags.values():
        for name in names:
            counts[name] = counts.get(name, 0) + 1
    return {k: v / n for k, v in counts.items()}


__all__ = [
    "MIN_SESSIONS_FOR_TAGS",
    "REGULAR_FLOOR",
    "EVERY_SESSION_SC_FLOOR",
    "SC_REGULAR_SESSIONS",
    "BIG_SC_YUAN",
    "BIG_PAY_YUAN",
    "P99_QUANTILE",
    "NEWCOMER_FIRST_POS",
    "SILENT_MSG_SESSION_RATE",
    "TAG_FULL_ATTENDANCE",
    "TAG_REGULAR",
    "TAG_NEWCOMER",
    "TAG_EVERY_SESSION_SC",
    "TAG_SC_REGULAR",
    "TAG_BIG_SC",
    "TAG_BIG_PAY",
    "TAG_KILOYUAN",
    "TAG_ADMIRAL",
    "TAG_CAPTAIN",
    "TAG_PURE_LURKER",
    "TAG_BARELY_SPEAK",
    "TAG_CHATTERBOX",
    "TagContext",
    "TagRule",
    "RULES",
    "explain",
    "tag_context",
    "tags_for",
    "tag_all",
    "prevalence",
]
