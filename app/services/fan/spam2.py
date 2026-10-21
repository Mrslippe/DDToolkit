"""独轮车判定 v2：用**时间分布**而不是只看重复率。

## 为什么需要 v2

v1 只看 `uniq` / `maxrep` / `m`，抓的是"整体重复率高"。但实测（2026-10-21）：

- 平台限流 ⇒ **瞬时爆发根本不存在**（6 场 1,121 人中，同文本 60 秒内最多 12 次，≥20 次为 0）；
- 真正的独轮车是**慢速高频**：一条文本重复几百次、摊在几小时里；
- 还有一类只在某个环节刷（整体重复率不高，但**局部窗口**里几乎全是同一条）。

v2 在 `mt`/`mh` 序列上算三个特征，任一命中即判刷屏：

| 规则 | 判据 | 抓什么 |
|---|---|---|
| **持续复读** | 同一条文本 ≥ `REP_COUNT` 次，且首末跨度 ≥ `REP_SPAN_H` 小时 | 一条口号从头刷到尾 |
| **窗口刷屏** | 某个 10 分钟窗口内重复率 ≥ `WIN_DUP`，且窗口内 ≥ `WIN_MIN` 条 | 只在某个环节刷 |
| **跨场惯犯** | 同一条文本出现在 ≥ `CROSS_SESSIONS` 场 | 每场都来刷同一句 |

**不需要重新采集** —— 全部在已有的 `mt`（时间戳）与 `mh`（文本哈希）上离线计算。
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: v2 参数
REP_COUNT = 50          # 单条文本累计重复次数
REP_SPAN_H = 1.0        # 且首末跨度 ≥ 1 小时（排除"一时激动"）
WIN_MIN = 30            # 窗口内至少这么多条才判
WIN_DUP = 0.80          # 窗口内重复率（1 - uniq/count）
WIN_SIZE_MS = 10 * 60_000
#: 「持续复读」还要求这条文本占该用户**全部**消息的比例 —— 否则高频正常用户会被误判。
#: 实测反例（2026-10-21）：某用户 69,604 条里说了 3,961 次"哈哈哈"（5.7%），
#: 50,066 条互不相同（72% 不重复），是正常话痨，不是独轮车。
SUSTAIN_SHARE = 0.20
#: 「窗口刷屏」同理：一个 10 分钟的笑点爆发不算独轮车，要看这条文本在全场的占比。
WINDOW_SHARE = 0.10

CROSS_SESSIONS = 20     # 同一条文本出现在 ≥20 场（占 75 场窗口的 1/4 以上）
CROSS_MIN_COUNT = 3     # 且每场至少 3 次，才算"惯犯"
CROSS_SHARE = 0.25      # 且这条文本要占该用户全部消息的 25% 以上（5% 会被口头禅误伤）


@dataclass
class Trace:
    """一个用户在一段时间内的行为摘要（v2 的输入）。"""

    sessions: int = 0
    messages: int = 0
    uniq: int = 0
    maxrep: int = 0
    rep_span_h: float = 0.0
    worst_window_dup: float = 0.0
    worst_window_count: int = 0
    #: 最密窗口里占主导的那条文本，全场出现了多少次（用于算占比）
    worst_window_hash_count: int = 0
    #: 每个重哈希的**累计条数**（跨场），用于算 cross_session 的占比
    heavy_n: dict[int, int] = field(default_factory=dict)
    #: 重复最多的那条文本，全场出现了多少次
    max_hash_count: int = 0
    cross_sessions: int = 0
    heavy: dict[int, set[int]] = field(default_factory=dict)   # hash → 场次集合


def feed(trace: Trace, *, session_idx: int, mt: list[int], mh: list[int]) -> None:
    """把**一场**里该用户的原始序列喂进 trace。"""
    if not mt or len(mh) != len(mt):
        return
    trace.sessions += 1
    trace.messages += len(mt)
    counts: dict[int, list[int]] = {}
    for t, h in zip(mt, mh):
        if not h:
            continue
        counts.setdefault(h, []).append(t)
    trace.uniq += len(counts)
    for h, ts in counts.items():
        c = len(ts)
        trace.maxrep = max(trace.maxrep, c)
        if c >= REP_COUNT:
            span = (max(ts) - min(ts)) / 3_600_000
            trace.rep_span_h = max(trace.rep_span_h, span)
        if c >= CROSS_MIN_COUNT:
            trace.heavy.setdefault(h, set()).add(session_idx)
            trace.heavy_n[h] = trace.heavy_n.get(h, 0) + c

    # 滑动窗口：找最密的 10 分钟
    pairs = sorted((t, h) for t, h in zip(mt, mh) if h)
    j = 0
    window_counts: dict[int, int] = {}
    for i, (t, h) in enumerate(pairs):
        while t - pairs[j][0] > WIN_SIZE_MS:
            old = pairs[j][1]
            window_counts[old] -= 1
            if window_counts[old] == 0:
                del window_counts[old]
            j += 1
        window_counts[h] = window_counts.get(h, 0) + 1
        n = i - j + 1
        if n >= WIN_MIN:
            dup = 1 - len(window_counts) / n
            if dup > trace.worst_window_dup:
                trace.worst_window_dup = dup
                trace.worst_window_count = n
                top_h = max(window_counts, key=lambda k: window_counts[k])
                trace.worst_window_hash_count = len(counts.get(top_h, []))

    trace.max_hash_count = max(trace.max_hash_count, trace.maxrep)
    trace.cross_sessions = max((len(s) for s in trace.heavy.values()), default=0)


def verdict(trace: Trace) -> tuple[bool | None, str]:
    """返回 `(是否独轮车, 命中的规则)`；样本不足返回 `(None, "unknown")`。"""
    if trace.messages < 20:
        return None, "unknown"
    total = max(1, trace.messages)
    if (trace.maxrep >= REP_COUNT and trace.rep_span_h >= REP_SPAN_H
            and trace.max_hash_count / total >= SUSTAIN_SHARE):
        return True, "sustained"
    if (trace.worst_window_dup >= WIN_DUP
            and trace.worst_window_hash_count / total >= WINDOW_SHARE):
        return True, "window"
    if trace.cross_sessions >= CROSS_SESSIONS:
        share = max(trace.heavy_n.values(), default=0) / total
        if share >= CROSS_SHARE:
            return True, "cross_session"
    return False, "ok"
