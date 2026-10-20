"""用上游的 `startDate` / `stopDate` 回填场次起止（不重采）。

## 为什么

`stopDate` 是平台记录的下播时间，覆盖率 99.9%，比"从事件时间戳推"权威：
实测中位差 6 分钟，但尾部能差 8 小时（弹幕没覆盖全场，或弹幕延伸到下播之后）。

## 用法

    python scripts/backfill_platform_span.py --root <数据根> [--dry-run]

每个 stats 文件改写前会留一份 `<id>.json.bak-platform`。
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.services.fan.collector import DANMAKUS_BASE, HEADERS
from app.services.fan.loader import list_vtubers

ISO = "%Y-%m-%d %H:%M:%S.%f"


def utc_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


def fetch_lives(v) -> dict[str, dict]:
    r = httpx.get(f"{DANMAKUS_BASE}/api/v2/channel",
                  params=[("uId", v.mid), ("includeLive", "true")],
                  headers=HEADERS, timeout=40, trust_env=False)
    r.raise_for_status()
    lives = (r.json().get("data") or {}).get("lives") or []
    return {str(x["liveId"]): x for x in lives if x.get("liveId")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    refs = {v.subdir: v for v in list_vtubers(None, root=args.root)}
    total = changed = 0
    long_before = long_after = 0

    for vdir in sorted(d for d in args.root.iterdir() if (d / "stats").is_dir()):
        v = refs.get(vdir.name)
        if v is None:
            print(f"[{vdir.name}] 解析不到 VtuberRef，跳过")
            continue
        lives = fetch_lives(v)
        have_stop = sum(1 for x in lives.values() if x.get("stopDate"))
        print(f"\n[{vdir.name}] 线上 {len(lives)} 场 · 其中 stopDate>0 {have_stop}")

        for sf in sorted((vdir / "stats").glob("*.json")):
            st = json.loads(sf.read_text(encoding="utf-8"))
            lid = str(st.get("live_id") or sf.stem)
            x = lives.get(lid)
            total += 1
            try:
                before = (datetime.strptime(st["end_at"], ISO)
                          - datetime.strptime(st["start_at"], ISO)).total_seconds() / 3600
            except (KeyError, ValueError):
                before = 0.0
            if before > 24:
                long_before += 1
            if not x or not x.get("stopDate") or not x.get("startDate"):
                continue
            new_start = utc_iso(int(x["startDate"]))
            new_end = utc_iso(int(x["stopDate"]))
            after = (datetime.strptime(new_end, ISO) - datetime.strptime(new_start, ISO)).total_seconds() / 3600
            if after > 24:
                long_after += 1
            if abs(after - before) < 0.02 and st.get("duration_source") == "platform":
                continue
            changed += 1
            if changed <= 6 or abs(after - before) > 1:
                print(f"  {lid[:8]}  {before:6.2f}h → {after:6.2f}h  "
                      f"({'%+.1f' % (after - before)}h)")
            if args.apply:
                bak = sf.with_suffix(".json.bak-platform")
                if not bak.exists():
                    shutil.copy2(sf, bak)
                st["start_at"] = new_start
                st["end_at"] = new_end
                st["duration_source"] = "platform"
                st["duration_trimmed"] = 0
                sf.write_text(json.dumps(st, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    verb = "已写回" if args.apply else "将改动"
    print(f"\n扫描 {total} 场，{verb} {changed} 场")
    print(f">24 小时：改前 {long_before} 场 → 改后 {long_after} 场")


if __name__ == "__main__":
    main()
