"""
一次性回填：danmakus 直播场次全量 → live_sessions 表（v0.9.x 内容管道 M1）。

背景：live_sessions 表（e006）为直播日历内容管道的事实源；danmakus
/api/v2/channel（公开免鉴权，WAF 需浏览器头）给出 2021-10 起全量场次
（标题/起止/分区/收益/峰值在线/弹幕数），实测（2026-09-07）：
七海 1193 场、星尘 480 场、小仓鼠 1122 场等；未收录主播（如 16548039）
返回空 lives，由 self 快照/礼物日兜底。

幂等：按 (account_id, live_id) upsert（LiveSessionRepo.upsert_danmakus），
可重复执行；重跑仅刷新可变字段（收益/在线数等）。

用法:
    python scripts/backfill_live_sessions.py                 # 全部 bilibili 账号
    python scripts/backfill_live_sessions.py --uid 434334701 # 指定账号
    python scripts/backfill_live_sessions.py --dry-run       # 只统计不写库
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx

from app.core.database import SessionLocal
from app.models.vtuber import Account
from app.repositories.vtuber_repo import LiveSessionRepo
from app.services.externals.danmakus import fetch_channel


async def _run(uid_filter: str | None, dry_run: bool) -> None:
    db = SessionLocal()
    try:
        q = db.query(Account).filter(
            Account.platform == "bilibili",
            Account.platform_uid != None,  # noqa: E711
            Account.platform_uid != "",
        )
        if uid_filter:
            q = q.filter(Account.platform_uid == uid_filter)
        accounts = q.all()
        print(f"bilibili 账号 {len(accounts)} 个")
        async with httpx.AsyncClient(timeout=30.0) as client:
            for acc in accounts:
                try:
                    payload = await fetch_channel(str(acc.platform_uid), client)
                except Exception as e:  # 账号级隔离：异常只影响本账号
                    print(f"[跳过] uid={acc.platform_uid} 拉取异常: {e}")
                    continue
                if not payload:
                    print(f"[跳过] uid={acc.platform_uid} 无数据/响应异常")
                    continue
                lives = payload.get("lives") or []
                if dry_run:
                    print(f"[dry-run] uid={acc.platform_uid} lives={len(lives)}")
                    continue
                res = LiveSessionRepo(db).upsert_danmakus(acc.id, lives)
                print(f"[OK] uid={acc.platform_uid} "
                      f"added={res['added']} updated={res['updated']} "
                      f"skipped={res['skipped']}")
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="回填 danmakus 直播场次 → live_sessions")
    parser.add_argument("--uid", default=None, help="仅回填指定 platform_uid")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写库")
    args = parser.parse_args()
    asyncio.run(_run(args.uid, args.dry_run))


if __name__ == "__main__":
    main()
