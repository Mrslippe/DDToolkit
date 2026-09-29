# -*- coding: utf-8 -*-
"""强制回源核对本地副本（L4，devlog/262）—— 轻资产那条取舍的**逃生口**。

## 为什么需要它

`assets.get()` 命中稳定键就**不回源**（这是"每轮抓取零图片请求"的来源）。代价写在规格 §2.1：
万一平台"换了图却没换文件名"，我们会一直用旧图。实测微博/B 站换图都会换文件名，
所以这条取舍值 —— 但**必须留一个口子**，这就是它（规格 §7 第 3 条：默认关、间隔 ≥7 天）。

## 三条纪律

- **节流 ≥ `--min-age-days`（默认 7）**：以副本的 `created_at` 为基准 —— 复核是**额外**请求，
  天天跑等于把收益还回去；要立刻全量复核就显式 `--min-age-days 0`；
- **默认只报告**（`--apply` 才用新字节覆盖并更新摘要）—— 图床抽风返回一张错误页时，
  默认行为不该是"把好副本换掉"；
- **取不到只记一笔**：`unreachable` ≠ `mismatch`（图床挂了不等于我们的副本坏了）。

## 用法

    python scripts/verify_assets.py                     # 核对 ≥7 天的副本，只报告
    python scripts/verify_assets.py --kind avatar --limit 20
    python scripts/verify_assets.py --min-age-days 0 --apply    # 立刻全量复核并修复差异
    python scripts/verify_assets.py --all-ages          # = --min-age-days 0
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.database import SessionLocal
from app.core.http import new_async_client
from app.services import assets


async def _run(kind: str | None, min_age_days: int, limit: int, apply: bool) -> int:
    db = SessionLocal()
    try:
        async with new_async_client(20.0) as client:
            async def fetch(url: str):
                resp = await client.get(url)
                return resp.content if resp.status_code == 200 else None

            report = await assets.verify(db, kind, min_age_days=min_age_days, limit=limit,
                                        fetch=fetch, apply=apply)
        print(f"核对 {report['checked']} 份（跳过 {report['skipped_fresh']} 份" 
              f"「还没到 {report['min_age_days']} 天」）：一致 {report['ok']}，"
              f"不一致 {len(report['mismatch'])}，取不到 {len(report['unreachable'])}")
        for m in report["mismatch"]:
            print(f"  [不一致] {m['kind']} {m['path']}")
            print(f"           was={str(m['was'])[:12]}… now={str(m['now'])[:12]}…")
        for u in report["unreachable"]:
            print(f"  [取不到] {u.get('kind')} {u.get('path') or u.get('url')}：{u['why']}")
        if apply:
            db.commit()
            print(f"完成：把 {len(report['mismatch'])} 份不一致的副本换成了刚取回的新字节")
        elif report["mismatch"]:
            print("（只报告，没动任何文件；确认无误后加 --apply 修复）")
        return 0
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="强制回源核对本地副本（≥N 天一次）")
    parser.add_argument("--kind", default=None, choices=list(assets.KINDS))
    parser.add_argument("--min-age-days", type=int, default=assets.VERIFY_MIN_AGE_DAYS,
                        help=f"只核对至少这么旧的副本（默认 {assets.VERIFY_MIN_AGE_DAYS} 天）")
    parser.add_argument("--all-ages", action="store_true", help="= --min-age-days 0（立刻全量）")
    parser.add_argument("--limit", type=int, default=50, help="这次最多核对几份")
    parser.add_argument("--apply", action="store_true", help="用新字节覆盖不一致的副本")
    args = parser.parse_args()
    min_age = 0 if args.all_ages else args.min_age_days
    return asyncio.run(_run(args.kind, min_age, args.limit, args.apply))


if __name__ == "__main__":
    sys.exit(main())
