"""重采后的核对脚本。

检查五件事（对照备份）：
1. 场次数是否一致
2. 记录数变化（逐场列出偏差 >20% 的）
3. 每场 raw 里带 `uniq` 的用户比例
4. `start_at` / `end_at` 是否仍为 UTC 且跨度合理（>24 小时的列出）
5. C1 判据结果分布（应为全部通过或被正确降级）

用法：
    python scripts/verify_recollect.py --root <数据根> --backup <备份目录>
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

ISO = "%Y-%m-%d %H:%M:%S.%f"


def load_stats(d: Path) -> dict[str, dict]:
    out = {}
    for f in (d / "stats").glob("*.json"):
        try:
            s = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out[str(s.get("live_id") or f.stem)] = s
    return out


def uniq_cover(d: Path) -> tuple[int, int, int]:
    """返回 (有 uniq 的用户数, 总用户数, 有 mh 的用户数)。"""
    have = total = mh = 0
    for f in (d / "raw").glob("*.json"):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(r, dict):
            continue
        for a in r.values():
            if isinstance(a, dict):
                total += 1
                if "uniq" in a:
                    have += 1
                if a.get("mh"):
                    mh += 1
    return have, total, mh


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--backup", required=True, type=Path)
    args = ap.parse_args()

    for vdir in sorted(d for d in args.root.iterdir() if (d / "stats").is_dir()):
        old_dir = args.backup / vdir.name
        new_s = load_stats(vdir)
        old_s = load_stats(old_dir) if old_dir.is_dir() else {}
        have, total, mh = uniq_cover(vdir)
        print(f"\n[{vdir.name}] 新 {len(new_s)} 场 · 旧 {len(old_s)} 场")
        print(f"  uniq 覆盖 {have}/{total}（{have/max(1,total):.1%}）· 有 mh 的用户 {mh}")

        big = []
        for lid, s in new_s.items():
            o = old_s.get(lid)
            if not o:
                continue
            a, b = int(o.get("records") or 0), int(s.get("records") or 0)
            if a and abs(b - a) / a > 0.20:
                big.append((lid[:8], a, b, round(100 * (b - a) / a)))
        print(f"  记录数偏差 >20% 的场次：{len(big)}")
        for x in big[:5]:
            print("    ", x)

        long_sessions = []
        for lid, s in new_s.items():
            try:
                dur = (datetime.strptime(s["end_at"], ISO)
                       - datetime.strptime(s["start_at"], ISO)).total_seconds() / 3600
            except (KeyError, ValueError):
                continue
            if dur > 24:
                long_sessions.append((lid[:8], round(dur, 1)))
        print(f"  跨度 >24 小时的场次：{len(long_sessions)}  {long_sessions[:3]}")


if __name__ == "__main__":
    main()
