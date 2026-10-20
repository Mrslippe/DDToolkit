"""采集后的**数据质量修复**：识别并裁掉"后段回放"。

## 问题

上游偶尔会把一场直播的**前段弹幕重新记到末尾**（时间戳变了、内容相同）。实测 9/227 场如此，
最多一场重复 9,856 条。它会让场次看起来长得多，并污染"按小时/按场次"的所有统计。

## 为什么不能用"时间/活跃度"判断

重复块在末尾**密度不低**（有的每小时上千条，比正常时段还热闹），任何"多久没弹幕就下播"的
判据都会把它当成正常内容。必须比对**内容**。

## 判据

按小时分桶，比较每小时与"此前的全部记录"的 `(uid, 文本哈希)` 多重集合：

- 若某小时 **≥80%** 的记录此前都出现过，且该小时 ≥50 条 ⇒ 判为回放；
- 从**第一个回放小时**起，丢弃之后的所有弹幕。

只丢弃**弹幕**（`mt`/`mh`），不动入场与付费事件 —— 那些没有逐条金额，无法按时间精确回退，
且它们在尾部的量很小。这一点写进 `stats["cut_note"]`，不假装完全干净。
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

#: 业务时区（分桶用，与全项目一致）
CN_TZ = timezone(timedelta(hours=8))

#: 判定阈值
OVERLAP_RATIO = 0.80
MIN_HOUR_RECORDS = 50


def _hour(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=CN_TZ).replace(minute=0, second=0, microsecond=0)


def find_replay_from(raw: dict) -> tuple[int | None, int, float]:
    """返回 `(首个回放小时的时间戳, 丢弃的弹幕条数, 该小时的重合比)`。

    没有任何回放时返回 `(None, 0, 0.0)`。
    """
    per_hour: dict[datetime, Counter] = defaultdict(Counter)
    for uid, a in raw.items():
        if not isinstance(a, dict):
            continue
        for t, h in zip(a.get("mt") or [], a.get("mh") or []):
            if not h:
                continue
            per_hour[_hour(int(t))][(uid, int(h))] += 1
    if not per_hour:
        return None, 0, 0.0

    cum: Counter = Counter()
    for hour in sorted(per_hour):
        c = per_hour[hour]
        n = sum(c.values())
        if n >= MIN_HOUR_RECORDS:
            overlap = sum((cum & c).values())
            ratio = overlap / n
            if ratio >= OVERLAP_RATIO:
                # 该小时起的**全部**弹幕都视为回放
                start = int(hour.timestamp() * 1000)
                dropped = sum(
                    sum(1 for t in (a.get("mt") or []) if int(t) >= start)
                    for a in raw.values() if isinstance(a, dict)
                )
                return start, dropped, ratio
        cum.update(c)
    return None, 0, 0.0


def apply_replay_cut(raw: dict, stats: dict) -> bool:
    """就地裁掉回放段，更新 `raw` 与 `stats`。返回是否发生了裁剪。

    只动弹幕：`mt` / `mh` / `m` / `uniq` / `maxrep`，以及 `stats` 里的
    `records` / `type0` / `uniq_total` / `dup_rate` / `end_at`。
    """
    start, dropped, ratio = find_replay_from(raw)
    if start is None or dropped <= 0:
        return False

    for a in raw.values():
        if not isinstance(a, dict):
            continue
        mt = a.get("mt") or []
        mh = a.get("mh") or []
        keep = [i for i, t in enumerate(mt) if int(t) < start]
        if len(keep) == len(mt):
            continue
        a["m"] = len(keep)
        a["mt"] = [mt[i] for i in keep]
        a["mh"] = [mh[i] for i in keep] if len(mh) == len(mt) else mh[: len(keep)]
        counts = Counter(x for x in a["mh"] if x)
        a["uniq"] = len(counts)
        a["maxrep"] = max(counts.values()) if counts else 0

    type0 = sum(int(a.get("m") or 0) for a in raw.values() if isinstance(a, dict))
    uniq_total = sum(int(a.get("uniq") or 0) for a in raw.values() if isinstance(a, dict))
    stats["records"] = int(stats.get("records") or 0) - dropped
    stats["type0"] = type0
    if "type_hist" in stats:
        hist = dict(stats.get("type_hist") or {})
        hist["0"] = type0
        stats["type_hist"] = hist
    stats["uniq_total"] = uniq_total
    stats["dup_rate"] = round(1 - uniq_total / type0, 6) if type0 else None
    stats["dropped_replay"] = dropped
    stats["replay_from"] = datetime.fromtimestamp(start / 1000, tz=CN_TZ).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    stats["replay_ratio"] = round(ratio, 3)

    # 结束时间：取「裁后最后一条弹幕」与「原 end_at」中**较早**的一个。
    # 只用前者会把结束时间往后推（平台给的结束可能更早），那就违背"裁剪只会变短"。
    last = 0
    for a in raw.values():
        if isinstance(a, dict) and a.get("mt"):
            last = max(last, int(a["mt"][-1]))
    if last:
        cut_end = datetime.fromtimestamp(last / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S.%f"
        )
        old_end = str(stats.get("end_at") or "")
        stats["end_at"] = min(cut_end, old_end) if old_end else cut_end
        stats["duration_note"] = "end_at 取「裁后最后一条弹幕」与原结束时间中较早者"
    return True
