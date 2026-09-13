# -*- coding: utf-8 -*-
"""动态流一轮的真机实测（只读 + 打真实上游，不写库）：量「按平台名单」的墙钟与请求数。

用法：
  python scripts/measure_dynamics_round.py            # R7 默认：名单内串行 + 自适应间隔
  python scripts/measure_dynamics_round.py --old      # 复现 R6 形态：平台内并发 3 + 起跑闸门
  python scripts/measure_dynamics_round.py --rounds 2 # 连跑两轮（看周期是否符合预期）
  python scripts/measure_dynamics_round.py --verbose  # 打开 INFO 日志（能看清每个上游请求：
                                                      # 用它可以确认"名单跳过时没有多余探测请求"）

⚠️ 会真的抓一轮动态（每个账号 1 次 feed 请求 + 新帖详情），与定时任务行为一致；
   数据落**开发库副本**（不碰真库）。
"""
import asyncio
import logging
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(os.environ["APPDATA"]) / "com.ddtoolkit.app-dev"
TMP = Path(os.environ["TEMP"]) / "ddtk-dynamics-measure"
OLD = "--old" in sys.argv
ROUNDS = 2 if "--rounds" in sys.argv and sys.argv[sys.argv.index("--rounds") + 1] == "2" else 1

if TMP.exists():
    shutil.rmtree(TMP, ignore_errors=True)
TMP.mkdir(parents=True)
for name in ("vtuber.db", "vtuber.db-wal", "vtuber.db-shm", ".env"):
    src = SRC / name
    if src.exists():
        shutil.copy2(src, TMP / name)
os.environ["DDTOOLKIT_DATA_DIR"] = str(TMP)
sys.path.insert(0, str(ROOT))

if "--verbose" in sys.argv:
    # 默认不开：httpx 每个请求一行，会把测量结果淹掉
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

from app.core.config import settings  # noqa: E402
from app.services import scheduler as sch  # noqa: E402

if OLD:
    # 复现 R6：平台内并发 3 + 起跑闸门（名单口径仍是 R7 的全部账号）
    settings.DYNAMICS_CONCURRENCY = 3
    settings.DYNAMICS_MIN_CYCLE_SECONDS = 0.0

print(f"模式 = {'R6（平台内并发 3 + 起跑闸门）' if OLD else 'R7（按平台名单：名单间并行 / 名单内串行 + 自适应间隔）'}")
print(f"DYNAMICS_CONCURRENCY = {settings.DYNAMICS_CONCURRENCY}"
      f"（1 = 名单内串行）")
print(f"周期下限 = {settings.DYNAMICS_MIN_CYCLE_SECONDS}s"
      f" / 名单目标轮长 = {settings.DYNAMICS_LANE_TARGET_SECONDS}s"
      f" / 名单内间隔夹取 = {settings.DYNAMICS_LANE_GAP_MIN}~{settings.DYNAMICS_LANE_GAP_MAX}s")

db = sch.SessionLocal()
try:
    lanes, skipped = sch._active_dynamics_lanes(db)
    print("\n名单（按平台）：")
    for pf, q in lanes.items():
        print(f"  {pf:10s} {len(q):2d} 个账号  间隔 {sch._lane_gap(len(q)):.2f}s"
              f"  预计轮长 {len(q) * (settings.DYNAMICS_LANE_FETCH_ESTIMATE + sch._lane_gap(len(q))):.0f}s"
              f"  → " + "、".join(v.name for v, _a in q))
    for pf, why in skipped.items():
        print(f"  {pf:10s} 跳过（{why}）")
    print(f"  预算估算 cost = {sch._next_dynamics_cost(db)}")
finally:
    db.close()

for i in range(1, ROUNDS + 1):
    t0 = time.monotonic()
    out = asyncio.run(sch.run_latest_dynamics_sweep())
    wall = time.monotonic() - t0
    print(f"\n===== 第 {i} 轮 =====")
    print(f"墙钟 = {wall:.1f}s")
    print(f"实际请求数 = {out.get('requests')}")
    print(f"名单 = {out.get('lanes')}  间隔 = {out.get('lane_gaps')}")
    print(f"入库 = {out.get('total')}  跳过名单 = {out.get('skipped_lanes')}")
    issues = out.get("issues") or []
    print(f"问题账号 = {len(issues)}" + (f" → {issues[:3]}" if issues else "（无风控/异常）"))

    db = sch.SessionLocal()
    try:
        due = sch._dynamics_next_due(db, since=t0)
        without = sch._dynamics_next_due(db)
    finally:
        db.close()
    now = time.monotonic()
    print(f"按 R7 口径（从轮**开始**算）：下一轮 {due - t0:.0f}s 后 → 周期 ≈ {due - t0:.0f}s")
    print(f"旧口径（从轮结束算）        ：下一轮 {without - now:.0f}s 后 → 周期 ≈ "
          f"{wall + (without - now):.0f}s")
    if i < ROUNDS:
        wait = max(0.0, due - time.monotonic())
        print(f"（等 {wait:.0f}s 进入下一轮）")
        time.sleep(wait)
