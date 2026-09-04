"""
一次性数据回填：posts.body_text（P2 全文搜索的正文字段）。

背景：v0.5.1 之前入库的帖子没有正文纯文本列（body_text），关键词搜索仅能
命中 title/summary（前 200 字摘要）。写入路径（scheduler 两个 _flush_pending、
路由 create_post）已在 v0.5.2 起自动派生新帖的 body_text，本脚本为存量数据
补齐。提取逻辑与写入路径共用 app/services/post_text.py，语义单一。

用法:
    python scripts/backfill_post_body_text.py --dry-run   # 只统计不修改
    python scripts/backfill_post_body_text.py             # 执行回填

幂等：只处理 body_text IS NULL 的行，可重复执行。
注意：数据库位置以 DDTOOLKIT_DATA_DIR 为准（默认 = 项目根 vtuber.db），
桌面端开发库为 %APPDATA%/com.ddtoolkit.app-dev/vtuber.db，执行前设置：
    $env:DDTOOLKIT_DATA_DIR = "$env:APPDATA/com.ddtoolkit.app-dev"
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.config import settings
from app.services.post_text import extract_post_text


def main():
    parser = argparse.ArgumentParser(description="回填 posts.body_text（从 body_json 提取纯文本）")
    parser.add_argument("--dry-run", action="store_true", help="只统计不修改")
    parser.add_argument("--limit", type=int, default=0, help="仅处理前 N 行（调试用，0=全部）")
    args = parser.parse_args()

    engine_url = settings.DATABASE_URL
    db_path = engine_url.replace("sqlite:///", "")
    print(f"目标数据库: {db_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    total_null = cur.execute(
        "SELECT COUNT(*) FROM posts WHERE body_text IS NULL AND body_json IS NOT NULL"
    ).fetchone()[0]
    print(f"待回填（body_text IS NULL 且 body_json 非空）: {total_null}")

    limit_sql = f" LIMIT {int(args.limit)}" if args.limit > 0 else ""
    rows = cur.execute(
        "SELECT id, body_json FROM posts "
        "WHERE body_text IS NULL AND body_json IS NOT NULL"
        f"{limit_sql}"
    ).fetchall()

    backfilled = 0
    failed = 0
    empty = 0
    examples = []

    for row in rows:
        text = None
        try:
            text = extract_post_text(row["body_json"])
        except Exception:
            text = None
        if text:
            if not args.dry_run:
                cur.execute("UPDATE posts SET body_text=? WHERE id=?", (text, row["id"]))
            backfilled += 1
            if len(examples) < 3:
                examples.append(f"  id={row['id']} → {text[:50]}…")
        else:
            empty += 1  # 无文本（仅图片等）：保持 NULL 属于预期
            failed += 1

    if not args.dry_run:
        conn.commit()

    print(f"可回填: {backfilled}  无文本(保持 NULL): {empty}")
    if examples:
        print("样例:")
        print("\n".join(examples))
    if args.dry_run:
        print("(dry-run) 未做修改")
    conn.close()


if __name__ == "__main__":
    main()
