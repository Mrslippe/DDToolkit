"""诊断：直播场次详情里的弹幕/词云「抓不下来」到底是哪一段坏了（只读）。

用法：

    $env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\\com.ddtoolkit.app-dev"   # 必须！见下
    python scripts/check_danmaku_fetch.py [场次数=6] [--self]

它会挑库里**最近的 N 个 danmakus 场次**，逐个真打上游：

1. `fetch_live_summary`  → 弹幕总量 + 上游词云（`status=upstream` / `upstream_absent`）
2. `fetch_live_events`   → 中断/继续事件（type 7/8）
3. `--self`：再对**最新一场**跑自建路径（v3 原始弹幕 + jieba 分词）——
   **很慢**（实测 12s ~ 120s，取决于上游瞬时状态），默认不跑。

全绿退出码 0，有失败退出码 1（可当探针用）。

由来（devlog/062）：用户报「弹幕数据还是抓不下来」，实际是**旧代码单次 12s 超时**
把"上游慢"渲染成了「本场无弹幕记录」——最近 5 个场次 100% 中招、更早的场次全好。
这个脚本就是那次的取证工具，留着给下次用：**先看是超时、是断供、还是真没弹幕**。

⚠️ **只读**：不写库（sqlite `mode=ro`）、不 adopt、不删除。但仍建议指向开发库；
不设 `DDTOOLKIT_DATA_DIR` 时 `settings` 会回退到**项目根**的库（裸跑残留，不是真库），
脚本会就此告警。
"""
import asyncio
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))   # 与其它 scripts/ 同款：允许直跑

from app.core.config import settings                                    # noqa: E402
from app.services.externals.danmakus import (fetch_live_events,         # noqa: E402
                                             fetch_live_summary)

_argc = [a for a in sys.argv[1:] if a != "--self"]
LIMIT = int(_argc[0]) if _argc else 6
WITH_SELF = "--self" in sys.argv

DB = settings.DATABASE_URL.replace("sqlite:///", "")
if not Path(DB).exists():
    raise SystemExit(f"库不存在：{DB}\n请先设 DDTOOLKIT_DATA_DIR 指向开发数据目录。")
if not os.getenv("DDTOOLKIT_DATA_DIR"):
    print("⚠️ 未设 DDTOOLKIT_DATA_DIR：用的是 settings 的回退库（通常是项目根的裸跑残留，"
          "不是开发库）。\n   开发库请用 "
          r'$env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\com.ddtoolkit.app-dev"')
print(f"目标库（只读）: {DB}\n")


def recent_lives() -> list[tuple]:
    con = sqlite3.connect(f"file:{Path(DB).as_posix()}?mode=ro", uri=True)
    try:
        return con.execute(
            "SELECT live_id, title, start_at, danmakus_count FROM live_sessions "
            "WHERE source LIKE '%danmakus%' ORDER BY start_at DESC LIMIT ?",
            (LIMIT,)).fetchall()
    finally:
        con.close()


async def main() -> int:
    rows = recent_lives()
    if not rows:
        print("库里没有 danmakus 来源的场次 —— 先让直播场次同步跑一次。")
        return 1
    print(f"最近 {len(rows)} 个 danmakus 场次：\n")
    failed = 0
    for live_id, title, start_at, cnt in rows:
        t0 = time.perf_counter()
        summary, events = await asyncio.gather(
            fetch_live_summary(live_id), fetch_live_events(live_id))
        dt = time.perf_counter() - t0
        label = (title or "")[:26]
        if summary is None:
            failed += 1
            print(f"  FAIL {live_id} {start_at} 弹幕数={cnt} {dt:5.1f}s → "
                  f"拉取失败（超时/网络/上游异常）| {label}")
            continue
        words = len(summary.get("word_cloud") or [])
        print(f"  OK   {live_id} {start_at} 弹幕数={cnt} {dt:5.1f}s → "
              f"status={summary.get('status')} 上游词条={words} 事件={len(events)} | {label}")

    if WITH_SELF and rows:
        from app.services.danmaku_cloud import build_word_cloud
        live_id, title, _start, _cnt = rows[0]
        print(f"\n自建词云（v3 原始弹幕 + 分词，可能很慢）：{live_id}")
        t0 = time.perf_counter()
        res = await build_word_cloud(live_id)
        dt = time.perf_counter() - t0
        top = "、".join(f"{w}({c})" for w, c in (res.get("words") or [])[:8])
        print(f"  {dt:6.1f}s → status={res.get('status')} 文本={res.get('text_count')} "
              f"记录={res.get('total')} 引擎={res.get('engine')}")
        print(f"  top: {top}")
        if res.get("status") == "fetch_failed":
            failed += 1

    print(f"\n失败 {failed}/{len(rows)}"
          + ("" if failed == 0 else "  ← 详情弹窗会显示「弹幕数据未取到」"))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
