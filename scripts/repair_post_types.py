"""
一次性数据修复：posts.type 中的 'dynamic_type_music' → 'music'。

背景（devlog/013）：_map_dynamic_type 此前未覆盖 DYNAMIC_TYPE_MUSIC，
fallback raw.lower() 把原始枚举名泄漏进了 type 字段。映射已修复，
本脚本修复存量数据。幂等：可重复执行。

用法:
    python scripts/repair_post_types.py            # 修复默认库（vtuber.db）
    python scripts/repair_post_types.py --dry-run  # 只统计不修改
"""
import argparse
import sys
from pathlib import Path

# 以脚本方式运行时 sys.path[0] 是 scripts/ 目录，需把项目根加入导入路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import create_engine, text

from app.core.config import settings

BAD_TYPE = "dynamic_type_music"
GOOD_TYPE = "music"


def main():
    parser = argparse.ArgumentParser(description="修复 posts.type 中泄漏的动态类型枚举名")
    parser.add_argument("--dry-run", action="store_true", help="只统计不修改")
    args = parser.parse_args()

    engine = create_engine(settings.DATABASE_URL, connect_args={"check_same_thread": False})
    with engine.begin() as conn:
        total = conn.execute(
            text("SELECT COUNT(*) FROM posts WHERE type = :t"), {"t": BAD_TYPE}
        ).scalar()
        print(f"发现 type='{BAD_TYPE}' 的帖子: {total} 条")

        if total and not args.dry_run:
            conn.execute(
                text("UPDATE posts SET type = :good WHERE type = :bad"),
                {"good": GOOD_TYPE, "bad": BAD_TYPE},
            )
            print(f"已修复: {total} 条 → type='{GOOD_TYPE}'")
        elif total and args.dry_run:
            print("(dry-run) 未做修改")

        remain = conn.execute(
            text("SELECT COUNT(*) FROM posts WHERE type = :t"), {"t": BAD_TYPE}
        ).scalar()
        print(f"修复后剩余 type='{BAD_TYPE}': {remain} 条")

    # 汇总当前类型分布
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT type, COUNT(*) FROM posts GROUP BY type ORDER BY COUNT(*) DESC")
        ).all()
        print("当前 posts.type 分布:")
        for t, n in rows:
            print(f"  {t}: {n}")


if __name__ == "__main__":
    main()
