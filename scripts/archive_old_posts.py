"""
归档规则执行脚本（devlog/016）：published_at 早于 cutoff（默认 30 天前）的帖子 → is_archived=1。

归档后的帖子不再参与更新抓取的遍历（抓取遇到整页已归档即停止）。
幂等：可重复执行。

用法:
    python scripts/archive_old_posts.py --dry-run            # 只统计不修改
    python scripts/archive_old_posts.py --days 30            # 执行（默认 30 天）
"""
import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import create_engine, func, text

from app.core.config import settings


def main():
    parser = argparse.ArgumentParser(description="归档早于 cutoff 的帖子")
    parser.add_argument("--days", type=int, default=30, help="截止天数（默认 30）")
    parser.add_argument("--dry-run", action="store_true", help="只统计不修改")
    args = parser.parse_args()

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    engine = create_engine(settings.DATABASE_URL, connect_args={"check_same_thread": False})

    with engine.connect() as conn:
        total = conn.execute(text("SELECT COUNT(*) FROM posts")).scalar()
        candidates = conn.execute(
            text("SELECT COUNT(*) FROM posts WHERE is_archived=0 AND published_at IS NOT NULL AND published_at < :c"),
            {"c": cutoff.strftime("%Y-%m-%d %H:%M:%S")},
        ).scalar()
        already = conn.execute(
            text("SELECT COUNT(*) FROM posts WHERE is_archived=1")
        ).scalar()

    print(f"cutoff（UTC）: {cutoff.isoformat()}  |  帖子总数: {total}")
    print(f"已归档: {already}  |  本次将归档（早于 cutoff 且未归档）: {candidates}")

    if args.dry_run:
        print("(dry-run) 未做修改")
        return

    with engine.begin() as conn:
        conn.execute(
            text("UPDATE posts SET is_archived=1 "
                 "WHERE is_archived=0 AND published_at IS NOT NULL AND published_at < :c"),
            {"c": cutoff.strftime("%Y-%m-%d %H:%M:%S")},
        )
    with engine.connect() as conn:
        remain = conn.execute(
            text("SELECT COUNT(*) FROM posts WHERE is_archived=0 AND published_at IS NOT NULL AND published_at < :c"),
            {"c": cutoff.strftime("%Y-%m-%d %H:%M:%S")},
        ).scalar()
        unarchived = conn.execute(
            text("SELECT COUNT(*) FROM posts WHERE is_archived=0")
        ).scalar()
    print(f"已归档: {candidates} 条 → 剩余未归档: {unarchived}（cutoff 前残留: {remain}）")


if __name__ == "__main__":
    main()
