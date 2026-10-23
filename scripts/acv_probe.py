"""用 danmakus 的 `live.extra.onlineRank` 算平均同接（ACV），并与 vtb.cat 交叉验证。

用法：python scripts/acv_probe.py [--sample 10]
"""

from __future__ import annotations

import argparse
import json
import statistics as st
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.services.fan.collector import DANMAKUS_BASE, HEADERS
from app.services.fan.loader import list_vtubers, resolve_data_dir

K = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
VBASE = "https://api.vtb.cat"
VOFF = 8 * 3600
ROOT = resolve_data_dir()


def our_sessions(subdir: str) -> list[dict]:
    out = []
    for f in sorted((ROOT / subdir / "stats").glob("*.json")):
        s = json.loads(f.read_text(encoding="utf-8"))
        try:
            ts = int(datetime.strptime(str(s["start_at"])[:19], "%Y-%m-%d %H:%M:%S")
                     .replace(tzinfo=timezone.utc).timestamp())
        except (KeyError, ValueError):
            continue
        out.append({"live_id": s["live_id"], "start": ts})
    out.sort(key=lambda r: r["start"])
    return out


def danmakus_acv(c: httpx.Client, live_id: str) -> tuple[float | None, int, int]:
    """返回 (ACV, 点数, 峰值)。ACV 取在线点数均值（剔除 0 值点）。"""
    r = c.get(f"{DANMAKUS_BASE}/api/v2/live",
              params=[("liveId", live_id), ("includeExtra", "true"), ("pageSize", 1)])
    if r.status_code != 200 or r.content[:1] != b"{":
        return None, 0, 0
    live = ((r.json().get("data") or {}).get("data") or {}).get("live") or {}
    tl = ((live.get("extra") or {}).get("onlineRank")) or {}
    vals = [int(v) for v in tl.values() if int(v) > 0] if isinstance(tl, dict) else []
    if not vals:
        return None, 0, 0
    return st.mean(vals), len(vals), max(vals)


def vtb_acv(c: httpx.Client, mid: str, start: int) -> float | None:
    r = c.get(f"{VBASE}/live/list", params={"uid": mid, "limit": 1000, "page": 1})
    if r.status_code != 200:
        return None
    for x in (r.json() or {}).get("lives") or []:
        if int(x.get("StartAt") or 0) == start + VOFF:
            o = c.get(f"{VBASE}/online", params={"id": x.get("ID")})
            pts = (o.json() or {}).get("data") or [] if o.status_code == 200 else []
            vals = [float(p.get("Count") or 0) for p in pts]
            vals = [v for v in vals if v > 0]
            return st.mean(vals) if vals else None
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=8, help="每个 V 抽多少场做 vtb 交叉验证")
    args = ap.parse_args()

    refs = list_vtubers(None, root=ROOT)
    for v in refs:
        ours = our_sessions(v.subdir)
        acvs, peaks, diffs = [], [], []
        with httpx.Client(timeout=60, headers=K, trust_env=False) as c:
            for s in ours:
                a, n, pk = danmakus_acv(c, s["live_id"])
                if a:
                    acvs.append(a)
                    peaks.append(pk)
        if not acvs:
            print(f"{v.name}: danmakus 没有 onlineRank 数据（{len(ours)} 场）")
            continue
        print(f"\n{v.name}：{len(ours)} 场 · 有同接数据 {len(acvs)} 场")
        print(f"  ACV（逐场均值的中位）= {st.median(acvs):,.0f}"
              f" · 场均峰值中位 = {st.median(peaks):,.0f}")
        print(f"  你的假设：核心 {st.median(acvs)*0.75:,.0f} · 次核心 {st.median(acvs)*1.25:,.0f}"
              f" · 外层 {st.median(acvs)*3:,.0f} · 合计 {st.median(acvs)*5:,.0f}")

        # 与 vtb 交叉验证（抽最近 N 场）
        if args.sample:
            with httpx.Client(timeout=60, headers=K, trust_env=False) as c:
                for s in ours[-args.sample:]:
                    a, _, _ = danmakus_acv(c, s["live_id"])
                    b = vtb_acv(c, v.mid, s["start"])
                    if a and b:
                        diffs.append((a - b) / b)
            if diffs:
                print(f"  与 vtb.cat 交叉验证 {len(diffs)} 场：中位偏差 {st.median(diffs):+.1%}"
                      f"（danmakus − vtb）")


if __name__ == "__main__":
    main()
