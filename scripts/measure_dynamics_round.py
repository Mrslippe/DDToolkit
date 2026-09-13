# -*- coding: utf-8 -*-
"""R6 真机实测（只读 + 打真实上游，不写库）：量「一轮动态流」的墙钟与并发形态。

用法：python scripts/measure_dynamics_round.py [--old]
  --old  临时把 DYNAMICS_CONCURRENCY 压到 1（复现旧的"平台内逐个 + 3~5s 节流"）

⚠️ 会真的抓一轮动态（每个主账号 1 次 feed 请求 + 新帖详情），
   与定时任务的行为一致；数据落**开发库副本**（不碰真库）。
"""
import asyncio
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(os.environ["APPDATA"]) / "com.ddtoolkit.app-dev"
TMP = Path(os.environ["TEMP"]) / "ddtk-r6-measure"
OLD = "--old" in sys.argv

if TMP.exists():
    shutil.rmtree(TMP, ignore_errors=True)
TMP.mkdir(parents=True)
for name in ("vtuber.db", "vtuber.db-wal", "vtuber.db-shm", ".env"):
    src = SRC / name
    if src.exists():
        shutil.copy2(src, TMP / name)
os.environ["DDTOOLKIT_DATA_DIR"] = str(TMP)
sys.path.insert(0, str(ROOT))

from app.core.config import settings  # noqa: E402
from app.services import scheduler as sch  # noqa: E402

if OLD:
    # 复现旧行为：平台内不并发（逐个抓 + 每账号抓完睡 3~5s）
    settings.DYNAMICS_CONCURRENCY = 1
    settings.DYNAMICS_MIN_CYCLE_SECONDS = 0.0

print(f"模式 = {'旧（单并发、无周期下限）' if OLD else 'R6（并发 + 60s 周期下限）'}")
print(f"并发档 DYNAMICS_CONCURRENCY = {settings.DYNAMICS_CONCURRENCY}")
print(f"周期下限 DYNAMICS_MIN_CYCLE_SECONDS = {settings.DYNAMICS_MIN_CYCLE_SECONDS}")

db = sch.SessionLocal()
try:
    cost = sch._next_dynamics_cost(db)
    pairs = sch._primary_accounts(db)
    print(f"名单：{len(pairs)} 个主账号 / 按平台 {cost}")
finally:
    db.close()

t0 = time.monotonic()
out = asyncio.run(sch.run_latest_dynamics_sweep())
wall = time.monotonic() - t0

print(f"\n一轮墙钟 = {wall:.1f}s")
print(f"实际请求数 = {out.get('requests')}")
print(f"入库 = {out.get('total')}")
issues = out.get("issues") or []
print(f"问题账号 = {len(issues)}" + (f" → {issues[:3]}" if issues else "（无风控/异常）"))

db = sch.SessionLocal()
try:
    due = sch._dynamics_next_due(db, since=t0)
    without = sch._dynamics_next_due(db)
finally:
    db.close()
now = time.monotonic()
print(f"\n按 R6 口径（从轮开始算）：下一轮 {due - t0:.0f}s 后 → 周期 ≈ {due - t0:.0f}s")
print(f"旧口径（从轮结束算）    ：下一轮 {without - now:.0f}s 后 → 周期 ≈ {wall + (without - now):.0f}s")
