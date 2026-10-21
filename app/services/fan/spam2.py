"""独轮车判定 v2（重写版）：以**文本多样性**为核心，不再看“重复了多少次”。

## 为什么推翻第一版

第一版用“单条文本重复 ≥50 次、横跨 ≥1 小时”判刷屏。用户拿真实弹幕指出误判：
一个人发 6.9 万条、说 3,961 次“哈哈哈”（5.7%）、**72% 的文本互不相同** —— 这是话痨，不是独轮车。

把 maxrep 最高的用户逐个取原文审查后，边界极其清晰：

| 类型 | 不同文本率（`uniq/m`） | 例子 |
|---|---|---|
| **真独轮车** | **1%–11%** | `178727502` 说 2,008 条只有 34 种文本（2%），`火队加油` 刷 1,871 次 |
| **口头禅型话痨** | **24%–78%** | `1049834725` 5,702 条里 2,313 种（41%），`好好好` 刷 1,557 次 |

**判据因此改成“他会不会说别的”**，而不是“他重复了几次那一条”。去重已经把
“一字不改地刷”消解成 1 条，再拿次数当判据只会误伤话痨。

- 单场 `uniq/m ≤ 20%` 且该场 ≥200 条 → `low_variety`
- 全场累计 `uniq/m ≤ 20%` 且 ≥500 条 → `low_variety`（覆盖“每场不多、但一直只那几句”的人）
- 同一条文本横跨 ≥20 场、且全场 `uniq/m ≤ 30%` → `cross_session`
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.services.fan.spam import is_spam

#: 判定的核心阈值
VARIETY_MAX = 0.20          # 不同文本率上限
MIN_SESSION_MSGS = 200      # 单场至少这么多条才判
MIN_TOTAL_MSGS = 500        # 全场累计至少这么多条才判
CROSS_SESSIONS = 20         # 同一条文本出现在 ≥20 场
CROSS_VARIETY_MAX = 0.30    # 且全场不同文本率仍 ≤30%


@dataclass
class Trace:
    """一个用户在一段时间内的行为摘要。"""

    sessions: int = 0
    messages: int = 0
    uniq: int = 0
    maxrep: int = 0
    #: 单场「低多样性」的次数（该场 ≥200 条且不同文本率 ≤20%）
    low_variety_sessions: int = 0
    #: 同一条文本出现过的场次数（只统计在单场出现 ≥3 次的文本）
    cross_sessions: int = 0
    heavy: dict[int, set[int]] = field(default_factory=dict)

    @property
    def variety(self) -> float:
        """不同文本率 = 去重条数 / 总条数。越低越像独轮车。"""
        return self.uniq / self.messages if self.messages else 1.0


def feed(trace: Trace, *, session_idx: int, mt: list[int], mh: list[int]) -> None:
    """把**一场**里该用户的原始序列喂进 trace。`mt` 只用于长度对齐。"""
    if not mt or len(mh) != len(mt):
        return
    trace.sessions += 1
    trace.messages += len(mt)
    counts: dict[int, int] = {}
    for h in mh:
        if h:
            counts[h] = counts.get(h, 0) + 1
    uniq = len(counts)
    trace.uniq += uniq
    if len(mt) >= MIN_SESSION_MSGS and uniq / len(mt) <= VARIETY_MAX:
        trace.low_variety_sessions += 1
    for h, c in counts.items():
        trace.maxrep = max(trace.maxrep, c)
        if c >= 3:
            trace.heavy.setdefault(h, set()).add(session_idx)
    trace.cross_sessions = max((len(s) for s in trace.heavy.values()), default=0)


def verdict(trace: Trace) -> tuple[bool | None, str]:
    """返回 `(是否独轮车, 规则名)`；样本不足返回 `(None, "unknown")`。

    **判据只有一条**：`不同文本率 ≤ 20%`（等价于 v1 的"重复率 ≥80%"），
    与 `spam.is_spam` 完全一致 —— 这里只是把"逐条序列"的产物（`maxrep`、
    `low_variety_sessions`、`cross_sessions`）一并留给报告用。
    """
    flag = is_spam(uniq=trace.uniq, maxrep=trace.maxrep, m=trace.messages)
    if flag is None:
        return None, "unknown"
    return (True, "low_variety") if flag else (False, "ok")
