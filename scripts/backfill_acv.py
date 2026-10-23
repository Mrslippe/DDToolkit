"""给已有场次补 ACV（平均同接，去头尾 10%）。

每场一次 `includeExtra` 请求，从 `live.extra.onlineRank` 算 ACV / 点数 / 峰值，写回 stats。
已算过的跳过；失败重试 3 次。改写前留 `.json.bak-acv`。

用法：python scripts/backfill_acv.py --root <数据根> [--apply]
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

import httpx

from app.services.fan.acv import acv_from_online_rank
from app.services.fan.collector import DANMAKUS_BASE, HEADERS


def fetch_extra(c: httpx.Client, live_id: str) -> dict | None:
    for _ in range(3):
        try:
            r = c.get(f"{DANMAKUS_BASE}/api/v2/live",
                      params=[("liveId", live_id), ("includeExtra", "true"), ("pageSize", 1)])
            if r.status_code == 200 and r.content[:1] == b"{":
                return ((((r.json().get("data") or {}).get("data") or {})
                         .get("live") or {}).get("extra")) or {}
        except (httpx.HTTPError, ValueError):
            continue
        time.sleep(0.6)
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    done = missed = skipped = 0
    with httpx.Client(timeout=60, headers=HEADERS, trust_env=False) as c:
        for vdir in sorted(d for d in args.root.iterdir() if (d / "stats").is_dir()):
            files = sorted((vdir / "stats").glob("*.json"))
            v_done = v_miss = 0
            for sf in files:
                st = json.loads(sf.read_text(encoding="utf-8"))
                if st.get("acv"):
                    skipped += 1
                    continue
                extra = fetch_extra(c, str(st.get("live_id")))
                acv, pts, peak = acv_from_online_rank(extra)
                if not acv:
                    v_miss += 1
                    missed += 1
                    continue
                st["acv"] = round(acv, 2)
                st["acv_points"] = pts
                st["peak_online"] = peak
                v_done += 1
                done += 1
                if args.apply:
                    bak = sf.with_suffix(".json.bak-acv")
                    if not bak.exists():
                        shutil.copy2(sf, bak)
                    sf.write_text(json.dumps(st, ensure_ascii=False, indent=2) + "\n",
                                  encoding="utf-8")
            print(f"  {vdir.name}: 补 {v_done} 场 · 缺 {v_miss} 场", flush=True)

    print(f"\n合计：补 {done} 场 · 缺 {missed} 场 · 已有 {skipped} 场"
          f"{'（已写回）' if args.apply else '（dry-run）'}")


if __name__ == "__main__":
    main()
