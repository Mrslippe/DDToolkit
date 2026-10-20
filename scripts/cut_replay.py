"""对**已有**数据执行回放裁剪（不动采集链路）。

用法：
    python scripts/cut_replay.py --root <数据根> [--apply]

对每个 stats/raw 配对：检测"后段回放"，裁掉回放段的弹幕并重写两个文件
（`stats` 只改计数与结束时间）。改写前留 `.bak-replay`。
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from app.services.fan.duration import apply_rate_end
from app.services.fan.quality import apply_replay_cut


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    scanned = hit = 0
    total_dropped = 0
    for vdir in sorted(d for d in args.root.iterdir() if (d / "stats").is_dir()):
        for sf in sorted((vdir / "stats").glob("*.json")):
            rf = vdir / "raw" / sf.name
            if not rf.is_file():
                continue
            scanned += 1
            stats = json.loads(sf.read_text(encoding="utf-8"))
            raw = json.loads(rf.read_text(encoding="utf-8"))
            before_end = stats.get("end_at", "")[:16]
            cut = apply_replay_cut(raw, stats)
            tightened = apply_rate_end(raw, stats)
            if not (cut or tightened):
                continue
            changed = True
            hit += 1
            dropped = int(stats.get("dropped_replay") or 0)
            total_dropped += dropped
            tag = "回放" if cut else "率降"
            extra = (f"丢弃 {dropped:>6,} 条 · 回放起于 {stats['replay_from']} · "
                     if cut else "")
            print(f"  {vdir.name[10:]}/{sf.stem[:8]}  [{tag}] {extra}"
                  f"结束 {before_end} → {stats['end_at'][:16]}")
            if args.apply:
                for f in (sf, rf):
                    bak = f.with_suffix(f.suffix + ".bak-replay")
                    if not bak.exists():
                        shutil.copy2(f, bak)
                sf.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                rf.write_text(json.dumps(raw, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    verb = "已裁剪" if args.apply else "将裁剪"
    print(f"\n扫描 {scanned} 场 · {verb} {hit} 场 · 合计 {total_dropped:,} 条")


if __name__ == "__main__":
    main()
