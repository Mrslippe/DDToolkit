"""
一次性数据修复：回填 posts.published_at（此前大量帖子缺失）。

背景（devlog/015）：抓取动态时只解析了 pub_time 字符串（'2025年04月21日'/'08月09日' 等），
格式不匹配导致 3,450 行 published_at 为空。抓取逻辑已改为优先使用
module_author.pub_ts（unix 时间戳），本脚本回填存量数据。幂等：可重复执行。

用法:
    python scripts/backfill_post_published_at.py --dry-run   # 只统计不修改
    python scripts/backfill_post_published_at.py             # 执行回填
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.config import settings
from app.services.fetcher import _parse_dynamic_pub_time


def main():
    parser = argparse.ArgumentParser(description="回填 posts.published_at（从 raw_json 的 pub_ts）")
    parser.add_argument("--dry-run", action="store_true", help="只统计不修改")
    args = parser.parse_args()

    engine_url = settings.DATABASE_URL
    db_path = engine_url.replace("sqlite:///", "")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    total_null = cur.execute("SELECT COUNT(*) FROM posts WHERE published_at IS NULL").fetchone()[0]
    print(f"published_at IS NULL 总数: {total_null}")

    rows = cur.execute("SELECT id, raw_json FROM posts WHERE published_at IS NULL").fetchall()
    backfilled = 0
    failed = 0
    examples = []

    for row in rows:
        try:
            raw = json.loads(row["raw_json"])
            author = (raw.get("modules") or {}).get("module_author") or {}
            dt = _parse_dynamic_pub_time(author)
        except Exception:
            dt = None
        if dt:
            naive = dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000000")
            if not args.dry_run:
                cur.execute("UPDATE posts SET published_at=? WHERE id=?", (naive, row["id"]))
            backfilled += 1
            if len(examples) < 3:
                examples.append(f"  id={row['id']} → {naive} (pub_ts={author.get('pub_ts')})")
        else:
            failed += 1

    if not args.dry_run:
        conn.commit()

    print(f"可回填: {backfilled}  无法解析: {failed}")
    if examples:
        print("样例:")
        print("\n".join(examples))
    if args.dry_run:
        print("(dry-run) 未做修改")
    conn.close()


if __name__ == "__main__":
    main()
