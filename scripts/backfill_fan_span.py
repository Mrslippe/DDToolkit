"""回填 `stats/*.json` 的场次跨度 —— 修掉被离群时间戳拉长的 `start_at` / `end_at`。

## 背景

2026-10-20 之前，`start_at` / `end_at` 取的是该场所有事件时间戳的 min / max。个别散落记录
（例如开播 4 天后的 2 条弹幕）会把跨度拉到几昼夜，于是"场次时长"失真 —— 实测 77 场里
有 6 场被拉长超过 20%，最长一场从约 6 小时变成 5 天。

采集侧已改为 `_trim_span()`（大间隔裁剪 + 只切少数一侧）。本脚本对**已有**的 stats 文件做同样的
裁剪：用 `raw/<live_id>.json` 里的时间戳重算，写回 `start_at` / `end_at`，并记录 `duration_trimmed`。

## 用法

    python scripts/backfill_fan_span.py --root <数据根> --dry-run    # 默认
    python scripts/backfill_fan_span.py --root <数据根> --apply

只改 `start_at` / `end_at` / `duration_trimmed` 三个键，其余字段原样保留（写前备份到 `.bak`）。
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from app.services.fan.collector import _trim_span

ISO = "%Y-%m-%d %H:%M:%S.%f"


def iter_vtuber_dirs(root: Path):
    for d in sorted(root.iterdir()):
        if d.is_dir() and (d / "stats").is_dir():
            yield d


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个 V（调试用）")
    ap.add_argument("--source", choices=("chat", "all"), default="chat",
                    help="跨度来源：chat=只用弹幕（默认，与采集一致）；all=全部事件")
    args = ap.parse_args()

    total = changed = 0
    for vdir in list(iter_vtuber_dirs(args.root))[: args.limit or None]:
        for sfile in sorted((vdir / "stats").glob("*.json")):
            raw_file = vdir / "raw" / sfile.name
            if not raw_file.is_file():
                continue
            total += 1
            stats = json.loads(sfile.read_text(encoding="utf-8"))
            raw = json.loads(raw_file.read_text(encoding="utf-8"))
            ts: list[int] = []
            for a in raw.values():
                ts.extend(a.get("mt") or [])
                if args.source == "all":
                    ts.extend(a.get("et") or [])
                    ts.extend(a.get("pt") or [])
            if not ts:
                continue
            lo, hi, dropped = _trim_span(ts)
            # 与采集侧一致：一律 UTC（旧文件里有 76/227 是本地时间，本脚本顺带纠回）
            new_start = datetime.fromtimestamp(lo / 1000, tz=timezone.utc).strftime(ISO)
            new_end = datetime.fromtimestamp(hi / 1000, tz=timezone.utc).strftime(ISO)
            if (new_start, new_end, dropped) == (
                stats.get("start_at"), stats.get("end_at"), stats.get("duration_trimmed", 0)
            ):
                continue
            changed += 1
            old_min = 0.0
            try:
                old_min = (datetime.strptime(stats["end_at"], ISO)
                           - datetime.strptime(stats["start_at"], ISO)).total_seconds() / 60
            except (KeyError, ValueError):
                pass
            new_min = (datetime.strptime(new_end, ISO)
                       - datetime.strptime(new_start, ISO)).total_seconds() / 60
            note = ""
            if old_min and abs(new_min - old_min) > 1 and dropped == 0:
                note = "（时区纠正）"
            print(f"  {vdir.name}/{sfile.name[:8]}  {old_min:8.1f} 分 → {new_min:8.1f} 分"
                  f"  裁掉 {dropped} 条{note}")
            if args.apply:
                shutil.copy2(sfile, sfile.with_suffix(".json.bak"))
                stats["start_at"] = new_start
                stats["end_at"] = new_end
                stats["duration_trimmed"] = dropped
                sfile.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")

    verb = "已写回" if args.apply else "将改动"
    print(f"\n扫描 {total} 场，{verb} {changed} 场"
          + ("" if args.apply else "（--dry-run 默认；加 --apply 写回）"))


if __name__ == "__main__":
    main()
