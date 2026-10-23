"""ACV 裁剪规则比较：按比例 vs 按固定分钟。

输出每个 V 的：全量 ACV、去头尾 10% 的 ACV、去头 10 分钟/尾 5 分钟的 ACV，
以及按 0.75×ACV 算出的核心层人数。
"""

from __future__ import annotations

import json
import statistics as st
from pathlib import Path

import httpx

from app.services.fan.collector import DANMAKUS_BASE, HEADERS
from app.services.fan.loader import list_vtubers, resolve_data_dir

ROOT = resolve_data_dir()
SAMPLE = 16


def timeline(c: httpx.Client, live_id: str) -> list[tuple[int, int]]:
    r = None
    for _ in range(3):
        try:
            r = c.get(f"{DANMAKUS_BASE}/api/v2/live",
                      params=[("liveId", live_id), ("includeExtra", "true"), ("pageSize", 1)])
            break
        except (httpx.HTTPError, httpx.ReadTimeout):
            continue
    if r is None or r.status_code != 200 or r.content[:1] != b"{":
        return []
    live = ((r.json().get("data") or {}).get("data") or {}).get("live") or {}
    tl = ((live.get("extra") or {}).get("onlineRank")) or {}
    if not isinstance(tl, dict):
        return []
    return sorted((int(k), int(v)) for k, v in tl.items())


def mean_after(pts: list[tuple[int, int]], *, frac: float = 0.0,
               head_min: float = 0.0, tail_min: float = 0.0) -> float | None:
    if not pts:
        return None
    k = int(len(pts) * frac)
    core = pts[k:len(pts) - k] if k else list(pts)
    if head_min or tail_min:
        t0, t1 = core[0][0], core[-1][0]
        lo = t0 + head_min * 60_000
        hi = t1 - tail_min * 60_000
        core = [(t, v) for t, v in core if lo <= t <= hi]
    vals = [v for _, v in core if v > 0]
    return st.mean(vals) if vals else None


def main() -> None:
    for v in list_vtubers(None, root=ROOT):
        all_stats = [json.loads(f.read_text(encoding="utf-8"))
                     for f in sorted((ROOT / v.subdir / "stats").glob("*.json"))]
        stats = all_stats[-SAMPLE:]            # 抽最近的 N 场，控制请求量
        full, pct10, min_tr, peak = [], [], [], []
        miss = 0
        with httpx.Client(timeout=60, headers=HEADERS, trust_env=False) as c:
            for s in stats:
                pts = timeline(c, s["live_id"])
                if not pts:
                    miss += 1
                    continue
                a = mean_after(pts)
                b = mean_after(pts, frac=0.10)
                d = mean_after(pts, head_min=10, tail_min=5)
                if a:
                    full.append(a)
                if b:
                    pct10.append(b)
                if d:
                    min_tr.append(d)
                peak.append(max(x for _, x in pts))

        print(f"\n{v.name}：{len(stats)} 场 · 有同接 {len(full)} 场 · 缺 {miss}")
        for label, arr in (("全量", full), ("去头尾10%", pct10), ("去头10分/尾5分", min_tr)):
            if not arr:
                continue
            acv = st.median(arr)
            print(f"  {label:<12} ACV {acv:>7,.0f} · 核心(0.75×) {acv*0.75:>6,.0f}"
                  f" · 次核心(1.25×) {acv*1.25:>6,.0f} · 外层(3×) {acv*3:>6,.0f}"
                  f" · 合计 {acv*5:>7,.0f}")
        if peak:
            print(f"  峰值中位 {st.median(peak):,.0f} · 峰值/ACV "
                  f"{st.median(peak)/st.median(full):.2f}（全量口径）")


if __name__ == "__main__":
    main()
