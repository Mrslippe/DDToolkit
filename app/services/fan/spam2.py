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
CROSS_SESSIONS = 20     # 同一条文本出现在 ≥20 场（占 75 场窗口的 1/4 以上）
CROSS_MIN_COUNT = 3     # 且每场至少 3 次，才算"惯犯"
CROSS_SHARE = 0.05      # 且这条文本要占该用户全部消息的 5% 以上


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

    trace.cross_sessions = max((len(s) for s in trace.heavy.values()), default=0)


def _heavy_counts(trace: Trace):
    """每个重哈希在多少场出现过（用于算份额）。"""
    return [len(v) for v in trace.heavy.values()]


def verdict(trace: Trace) -> tuple[bool | None, str]:
    """返回 `(是否独轮车, 命中的规则)`；样本不足返回 `(None, "unknown")`。"""
    if trace.messages < 20:
        return None, "unknown"
    if trace.maxrep >= REP_COUNT and trace.rep_span_h >= REP_SPAN_H:
        return True, "sustained"
    if trace.worst_window_dup >= WIN_DUP:
        return True, "window"
    if trace.cross_sessions >= CROSS_SESSIONS:
        heavy_total = sum(len(v) for v in trace.heavy.values())
        share = max((c for c in _heavy_counts(trace)), default=0) / max(1, trace.messages)
        if heavy_total and share >= CROSS_SHARE:
            return True, "cross_session"
    return False, "ok"
