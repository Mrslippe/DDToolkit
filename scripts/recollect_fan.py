"""重新采集并**替换**聚合数据（让每场都带上 `uniq` / `mh` / 裁剪后的跨度）。

## 为什么需要它

2026-10-20 之前采集的数据里没有文本指纹（`uniq`、`mh`），而旧 raw 也没有原文，
**无法离线补算**。要拿到就必须重采。

## 安全约束

1. **必须先备份**：脚本检查 `<数据根>.bak-*` 是否存在，没有就拒绝执行；
2. 逐 V 处理：先删该 V 已登记的场次（stats/raw），再整体重采；
3. 重采后**逐场核对**：文件数、记录数变化、带 `uniq` 的用户比例；
4. 失败会列出 `live_id` 与原因，不静默跳过。

## 用法

    python scripts/recollect_fan.py --root <数据根> [--only pilot_v3_xingtong] [--dry-run]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from app.services.fan.collector import SessionPlan, collect
from app.services.fan.loader import list_vtubers


def plan_for(vdir: Path) -> list[SessionPlan]:
    out: list[SessionPlan] = []
    for sf in sorted((vdir / "stats").glob("*.json")):
        try:
            d = json.loads(sf.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        start = str(d.get("start_at") or "")[:19]
        lid = str(d.get("live_id") or sf.stem)
        if lid and start:
            out.append(SessionPlan(lid, start))
    return out


def records_of(vdir: Path) -> dict[str, int]:
    out: dict[str, int] = {}
    for sf in (vdir / "stats").glob("*.json"):
        try:
            d = json.loads(sf.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out[str(d.get("live_id") or sf.stem)] = int(d.get("records") or 0)
    return out


def uniq_ratio(vdir: Path) -> tuple[int, int]:
    have = total = 0
    for rf in (vdir / "raw").glob("*.json"):
        try:
            r = json.loads(rf.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(r, dict):
            continue
        for a in r.values():
            if isinstance(a, dict):
                total += 1
                if "uniq" in a:
                    have += 1
    return have, total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--only", default="", help="只处理某个子目录")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root: Path = args.root
    backups = sorted(root.parent.glob(root.name + ".bak-*"))
    if not backups:
        sys.exit(f"拒绝执行：没找到备份（{root.parent / (root.name + '.bak-*')}）。先备份再跑。")

    refs = {v.subdir: v for v in list_vtubers(None, root=root)}
    targets = [d for d in sorted(root.iterdir())
               if d.is_dir() and (d / "stats").is_dir()
               and (not args.only or d.name == args.only)]
    print(f"数据根 {root}\n备份 {backups[-1].name}\n目标 {len(targets)} 个 V", flush=True)

    for vdir in targets:
        plans = plan_for(vdir)
        if not plans:
            print(f"\n[{vdir.name}] 无可重采场次，跳过", flush=True)
            continue
        before = records_of(vdir)
        v = refs.get(vdir.name)
        if v is None:
            print(f"\n[{vdir.name}] 解析不到 VtuberRef，跳过", flush=True)
            continue
        print(f"\n[{vdir.name}] 待重采 {len(plans)} 场 · 原记录合计 {sum(before.values()):,}",
              flush=True)
        if args.dry_run:
            continue

        for p in plans:
            for sub in ("stats", "raw"):
                f = vdir / sub / f"{p.live_id}.json"
                if f.is_file():
                    f.unlink()

        since = min(p.start_at for p in plans)[:10]
        until = max(p.start_at for p in plans)[:10]
        prog = asyncio.run(collect(v, since, until, root=root, sessions=plans))
        print(f"  采集: {prog.state} · 完成 {prog.done}/{prog.total} · "
              f"跳过 {prog.skipped} · 失败 {prog.failed}", flush=True)
        if prog.failures:
            print("  失败明细:", prog.failures[:5], flush=True)

        after = records_of(vdir)
        old_sum, new_sum = sum(before.values()), sum(after.values())
        have, total = uniq_ratio(vdir)
        delta = f"{100 * (new_sum - old_sum) / old_sum:+.1f}%" if old_sum else "n/a"
        print(f"  核对: 场次 {len(after)}（原 {len(before)}）· 记录 {new_sum:,}（原 {old_sum:,}，{delta}）"
              f" · 带 uniq 的用户 {have}/{total}", flush=True)


if __name__ == "__main__":
    main()
