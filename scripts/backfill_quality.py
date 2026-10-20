"""给已有数据补跑质量闸（L1/L2/L3），把结论写进 `stats["quality"]`。

用法：
    python scripts/backfill_quality.py --root <数据根> [--apply]

对每个 V：
- L2 从 danmakus 的 `/api/v2/channel` 取 `danmakusCount` / `totalIncome`（按 live_id 匹配）；
- L3 从 vtb.cat 的 `/live/list` 取 `Message` / `Money`（按 StartAt−8h 匹配）。
改写前留 `.json.bak-quality`。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.services.externals.vtbcat import fetch_lives, match_session
from app.services.fan.collector import DANMAKUS_BASE, HEADERS
from app.services.fan.loader import list_vtubers
from app.services.fan.quality_gate import evaluate, summary


def mid_of(subdir: str, refs: dict) -> str | None:
    v = refs.get(subdir)
    if v is not None:
        return v.mid
    if subdir.startswith("bili-"):
        return subdir[len("bili-"):]
    return None


async def channel_lives(mid: str) -> dict[str, dict]:
    try:
        async with httpx.AsyncClient(timeout=40, headers=HEADERS, trust_env=False) as c:
            r = await c.get(f"{DANMAKUS_BASE}/api/v2/channel",
                            params=[("uId", mid), ("includeLive", "true")])
            if r.status_code != 200 or r.content[:1] != b"{":
                return {}
            lives = ((r.json().get("data") or {}).get("lives")) or []
            return {str(x.get("liveId")): x for x in lives if x.get("liveId")}
    except (httpx.HTTPError, ValueError):
        return {}


def start_ms(stats: dict) -> int | None:
    try:
        return int(datetime.strptime(str(stats["start_at"])[:19], "%Y-%m-%d %H:%M:%S")
                   .replace(tzinfo=timezone.utc).timestamp() * 1000)
    except (KeyError, ValueError):
        return None


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    refs = {v.subdir: v for v in list_vtubers(None, root=args.root)}
    allq: list[dict] = []
    for vdir in sorted(d for d in args.root.iterdir() if (d / "stats").is_dir()):
        mid = mid_of(vdir.name, refs)
        if not mid:
            print(f"[{vdir.name}] 取不到 mid，跳过")
            continue
        by_id = await channel_lives(mid)
        vtb = await fetch_lives(mid)
        statuses: dict[str, int] = {}
        rows = []
        for sf in sorted((vdir / "stats").glob("*.json")):
            stats = json.loads(sf.read_text(encoding="utf-8"))
            plat = by_id.get(str(stats.get("live_id")))
            platform = {
                "danmakus_count": int((plat or {}).get("danmakusCount") or 0),
                "income": float((plat or {}).get("totalIncome") or 0.0),
            }
            ms = start_ms(stats)
            vit = match_session(vtb, ms) if ms else None
            q = evaluate(stats=stats, platform=platform, vtb=vit)
            allq.append(q)
            s = q["status"]
            statuses[s] = statuses.get(s, 0) + 1
            if s != "ok":
                rows.append((s, str(stats.get("live_id"))[:8], q["checks"]))
            if args.apply:
                bak = sf.with_suffix(".json.bak-quality")
                if not bak.exists():
                    shutil.copy2(sf, bak)
                stats["quality"] = q
                sf.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n",
                              encoding="utf-8")
        print(f"[{vdir.name}] {len(list((vdir / 'stats').glob('*.json')))} 场 · {statuses}")
        for s, lid, checks in rows[:6]:
            print(f"    {s:<14}{lid}  { {k: v for k, v in checks.items() if k.endswith('ratio')} }")

    print(f"\n总计 {len(allq)} 场 · 汇总 {summary(allq)}")
    if not args.apply:
        print("（dry-run；加 --apply 才会写回 stats.quality）")


if __name__ == "__main__":
    asyncio.run(main())
