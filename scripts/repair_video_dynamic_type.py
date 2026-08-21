"""
一次性数据修复：拆分 video 类型为 video（视频投稿）与 video_dynamic（附带视频的投稿动态）。

背景（devlog/017）：video 类型混有两种来源——
- 视频投稿（arc/search 列表）：无文字内容，标题 = 视频标题；
- 附带视频的投稿动态（feed 的 DYNAMIC_TYPE_AV）：有自己的文字内容（附言，raw 的
  modules.module_dynamic.desc.text），标题规则为「有附言 → 附言前 20 字，否则视频标题」。

判定：动态型 body_json 恒含 "text" 键（投稿型没有）。存量迁移：
1. type='video' 且 body_json 含 "text" 键 → type='video_dynamic'；
2. 附言从 raw_json 的 desc.text 恢复（body_json.text 里存的是旧逻辑的视频简介）；
   有附言 → body.text=附言、title=附言前 20 字；无附言 → body.text=''、title 保持视频标题。

幂等：可重复执行。用法:
    python scripts/repair_video_dynamic_type.py --dry-run
    python scripts/repair_video_dynamic_type.py
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.config import settings


def _load(s):
    try:
        return json.loads(s) if s else {}
    except Exception:
        return {}


def _dump(o) -> str:
    return json.dumps(o, ensure_ascii=False, default=str)


def main():
    parser = argparse.ArgumentParser(description="拆分 video / video_dynamic 类型")
    parser.add_argument("--dry-run", action="store_true", help="只统计不修改")
    args = parser.parse_args()

    db_path = settings.DATABASE_URL.replace("sqlite:///", "")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 候选：type='video' 且 body_json 含 "text" 键（动态型）
    rows = cur.execute(
        "SELECT id, title, body_json, raw_json FROM posts "
        "WHERE type='video' AND body_json LIKE '%\"text\"%'"
    ).fetchall()
    print(f"待迁移（video 含 text 键）: {len(rows)} 条")

    n_type = 0
    n_title_from_comment = 0
    n_title_keep_video = 0
    for r in rows:
        body = _load(r["body_json"])
        raw = _load(r["raw_json"])
        md = (raw.get("modules") or {}).get("module_dynamic") or {}
        desc = md.get("desc") or {}
        comment = desc.get("text", "") if isinstance(desc, dict) else ""

        new_body = dict(body)
        if comment and comment.strip():
            new_body["text"] = comment
            new_title = comment.strip()[:20]
            n_title_from_comment += 1
        else:
            new_body["text"] = ""
            new_title = r["title"]  # 保持视频标题
            n_title_keep_video += 1

        if not args.dry_run:
            cur.execute(
                "UPDATE posts SET type='video_dynamic', title=?, body_json=? WHERE id=?",
                (new_title, _dump(new_body), r["id"]),
            )
        n_type += 1

    if not args.dry_run:
        conn.commit()

    print(f"将迁移: {n_type}  其中标题取附言前20字: {n_title_from_comment}  保留视频标题: {n_title_keep_video}")
    if args.dry_run:
        print("(dry-run) 未做修改")
    conn.close()


if __name__ == "__main__":
    main()
