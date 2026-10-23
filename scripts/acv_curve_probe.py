"""看同接曲线的形态：头尾两段到底拉低了多少？

对每场取 `live.extra.onlineRank`，按时间排序后分别用「去掉头尾 x%」的均值做对比。
"""

from __future__ import annotations

import json
import statistics as st
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.services.fan.collector import DANMAKUS_BASE, HEADERS
from app.services.fan.loader import resolve_data_dir

ROOT = resolve_data_dir()
VS = ("pilot_v3_mizuki", "pilot_v3_mingqian", "pilot_v3_xingtong")
TRIMS = (0.05, 0.10, 0.15, 0.20)


def timeline(c: httpx.Client, live_id: str) -> list[tuple[int, int]]:
    r = c.get(f"{DANMAKUS_BASE}/api/v2/live",
              params=[("liveId", live_id), ("includeExtra", "true"), ("pageSize", 1)])
    if r.status_code != 200 or r.content[:1] != b"{":
        return []
    live = ((r.json().get("data") or {}).get("data") or {}).get("live") or {}
    tl = ((live.get("extra") or {}).get("onlineRank")) or {}
    if not isinstance(tl, dict):
        return []
    return sorted((int(k), int(v)) for k, v in tl.items())


def mean_trim(vals: list[int], frac: float) -> float | None:
    if not vals:
        return None
    k = int(len(vals) * frac)
    core = vals[k:len(vals) - k] if k else vals
    return st.mean(core) if core else None


def main() -> None:
    with httpx.Client(timeout=60, headers=HEADERS, trust_env=False) as c:
        for sub in VS:
            files = sorted((ROOT / sub / "stats").glob("*.json"))
            picks = [files[len(files) // 3], files[len(files) // 2], files[-2]]
            for f in picks:
                s = json.loads(f.read_text(encoding="utf-8"))
                pts = timeline(c, s["live_id"])
                if not pts:
                    print(f"{sub[10:]} {s['live_id'][:8]}: 无 onlineRank")
                    continue
                vals = [v for _, v in pts]
                t0, t1 = pts[0][0], pts[-1][0]
                dur = (t1 - t0) / 60000
                head = st.mean(vals[:max(1, len(vals) // 10)])
                tail = st.mean(vals[-max(1, len(vals) // 10):])
                row = [f"{sub[10:]:<9}{s['live_id'][:8]} {dur:>6.0f}分 {len(vals):>5}点"]
                row.append(f"全 {st.mean(vals):>6.0f}")
                for tr in TRIMS:
                    m = mean_trim(vals, tr)
                    row.append(f"-{int(tr*100)}% {m:>6.0f}")
                row.append(f"头10% {head:>5.0f} 尾10% {tail:>5.0f}")
                print("  ".join(row))


if __name__ == "__main__":
    main()
