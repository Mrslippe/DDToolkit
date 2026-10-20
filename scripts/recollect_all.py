"""按当前链路全量重采 4 个 V，并替换旧数据。

每个 V：读现有 stats 得到场次清单与日期范围 → 删除 stats/raw → 用同一清单重采。
（先整体备份到 dev/fan-structure.bak-<ts>，失败可回滚。）
"""

from __future__ import annotations

import asyncio
import json
import shutil
import time
from pathlib import Path

from app.services.fan.collector import SessionPlan, collect
from app.services.fan.loader import list_vtubers

ROOT = Path("E:/work/Project/database/dev/fan-structure")
DEV = ROOT.parent


def main() -> None:
    stamp = time.strftime("%Y%m%d-%H%M")
    bak = DEV / f"fan-structure.bak-{stamp}"
    if not bak.exists():
        t0 = time.time()
        shutil.copytree(ROOT, bak)
        print(f"已备份 → {bak}（{time.time()-t0:.0f}s）", flush=True)

    refs = {v.subdir: v for v in list_vtubers(None, root=ROOT)}
    for vdir in sorted(d for d in ROOT.iterdir() if (d / "stats").is_dir()):
        v = refs.get(vdir.name)
        if v is None and vdir.name.startswith("bili-"):
            from app.services.fan.loader import VtuberRef
            mid = vdir.name[len("bili-"):]
            v = VtuberRef(name=vdir.name, subdir=vdir.name, mid=mid, short=vdir.name[-6:])
        if v is None:
            print(f"[{vdir.name}] 无法解析 V，跳过", flush=True)
            continue

        plans = []
        for sf in sorted((vdir / "stats").glob("*.json")):
            st = json.loads(sf.read_text(encoding="utf-8"))
            if st.get("start_at") and st.get("end_at"):
                plans.append(SessionPlan(str(st["live_id"]), str(st["start_at"])[:19],
                                         str(st["end_at"])[:19]))
        if not plans:
            print(f"[{vdir.name}] 无场次清单，跳过", flush=True)
            continue
        since = min(p.start_at for p in plans)[:10]
        until = max(p.start_at for p in plans)[:10]
        print(f"\n[{vdir.name}] {len(plans)} 场 · {since} ~ {until} · 开始重采", flush=True)

        for sub in ("stats", "raw"):
            for f in (vdir / sub).glob("*"):
                f.unlink()

        t0 = time.time()
        prog = asyncio.run(collect(v, since, until, root=ROOT, sessions=plans))
        print(f"  完成：{prog.done}/{prog.total} · 跳过 {prog.skipped} · 失败 {prog.failed}"
              f" · {time.time()-t0:.0f}s", flush=True)
        for f in (prog.failures or [])[:5]:
            print("    失败:", f, flush=True)


if __name__ == "__main__":
    main()
