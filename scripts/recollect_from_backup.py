"""从备份恢复"场次清单"，再按当前链路重采（补昵称与 ACV）。

用途：重采中断导致 stats 被清空后，计划清单还在备份里。
用法：python scripts/recollect_from_backup.py --backup <备份目录> --root <数据根>
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.services.fan.collector import SessionPlan, collect
from app.services.fan.loader import VtuberRef, list_vtubers


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backup", required=True, type=Path)
    ap.add_argument("--root", required=True, type=Path)
    args = ap.parse_args()

    refs = {v.subdir: v for v in list_vtubers(None, root=args.root)}
    for vdir in sorted(d for d in args.backup.iterdir() if (d / "stats").is_dir()):
        cur = args.root / vdir.name / "stats"
        have = len(list(cur.glob("*.json"))) if cur.is_dir() else 0
        total = len(list((vdir / "stats").glob("*.json")))
        if have >= total:
            print(f"[{vdir.name}] 已完整（{have}/{total}），跳过", flush=True)
            continue

        plans = []
        for sf in sorted((vdir / "stats").glob("*.json")):
            st = json.loads(sf.read_text(encoding="utf-8"))
            if st.get("start_at") and st.get("end_at"):
                plans.append(SessionPlan(str(st["live_id"]), str(st["start_at"])[:19],
                                         str(st["end_at"])[:19]))
        v = refs.get(vdir.name)
        if v is None and vdir.name.startswith("bili-"):
            mid = vdir.name[len("bili-"):]
            v = VtuberRef(name=vdir.name, subdir=vdir.name, mid=mid, short=vdir.name[-6:])
        if v is None or not plans:
            print(f"[{vdir.name}] 无法继续（v={v}，plans={len(plans)}）", flush=True)
            continue

        since = min(p.start_at for p in plans)[:10]
        until = max(p.start_at for p in plans)[:10]
        print(f"[{vdir.name}] {have}/{total} → 重采 {len(plans)} 场（{since}~{until}）", flush=True)
        prog = asyncio.run(collect(v, since, until, root=args.root, sessions=plans))
        print(f"  完成：{prog.done}/{prog.total} · 跳过 {prog.skipped} · 失败 {prog.failed}",
              flush=True)


if __name__ == "__main__":
    main()
