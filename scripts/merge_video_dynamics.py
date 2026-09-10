"""
一次性数据归并：B 站「投稿动态」并入同 bvid 的「投稿」（P9-3，v0.9.6）。

背景：一条视频有两个来源 —— `arc/search` 投稿列表（type=video，
platform_post_id=bvid）与动态流的投稿动态（type=video_dynamic，
platform_post_id=动态 id，body_json.bvid 指向同一 bvid）。本地实测 322 个 bvid
同时存在两条记录 → 列表里同一条视频出现两次。

归并口径（2026-09-10 用户定案）：**只保留 video 一条**；动态里的附言
（body_json.text，实测 369 条动态里 47 条有附言）写进 `posts.note`，
video_dynamic 行删除。删除而非标记：抓取侧遇到「bvid 已作为 video 入库」
就不会再插入 video_dynamic（见 scheduler._absorb_video_dynamic），所以不会复活。

用法:
    python scripts/merge_video_dynamics.py --dry-run   # 只统计不动库
    python scripts/merge_video_dynamics.py             # 执行（默认先备份）
    python scripts/merge_video_dynamics.py --no-backup # 跳过备份（自己已备份时）

幂等：按 (platform, platform_uid, bvid) 归并，二次执行不会再匹配到 video_dynamic。
注意：数据库位置以 DDTOOLKIT_DATA_DIR 为准，桌面端开发库为
    $env:DDTOOLKIT_DATA_DIR = "$env:APPDATA/com.ddtoolkit.app-dev"
"""
import argparse
import json
import shutil
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.config import settings


def _bvid(body_json: str | None) -> str:
    try:
        return str((json.loads(body_json or "{}") or {}).get("bvid") or "")
    except Exception:
        return ""


def _note_text(body_json: str | None) -> str:
    try:
        return str((json.loads(body_json or "{}") or {}).get("text") or "").strip()
    except Exception:
        return ""


def main() -> None:
    ap = argparse.ArgumentParser(description="把 B 站投稿动态归并进同 bvid 的投稿帖（附言写 posts.note）")
    ap.add_argument("--dry-run", action="store_true", help="只统计不修改")
    ap.add_argument("--no-backup", action="store_true", help="跳过备份（默认先复制一份 .bak-<时间戳>）")
    args = ap.parse_args()

    db_path = settings.DATABASE_URL.replace("sqlite:///", "")
    print(f"目标数据库: {db_path}")

    if not args.dry_run and not args.no_backup:
        bak = f"{db_path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(db_path, bak)
        print(f"已备份: {bak}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 1) 各账号的 video：bvid → (id, note)
    videos: dict[tuple[str, str], dict[str, sqlite3.Row]] = defaultdict(dict)
    for row in cur.execute(
            "SELECT id, platform_uid, platform_post_id, body_json, note FROM posts "
            "WHERE platform='bilibili' AND type='video'"):
        bv = _bvid(row["body_json"]) or row["platform_post_id"]
        if bv:
            videos[row["platform_uid"]][bv] = row

    # 2) 与 video 同 bvid 的 video_dynamic
    mergeable: list[tuple[sqlite3.Row, sqlite3.Row | None, str]] = []
    for row in cur.execute(
            "SELECT id, platform_uid, platform_post_id, body_json FROM posts "
            "WHERE platform='bilibili' AND type='video_dynamic'"):
        bv = _bvid(row["body_json"])
        video = videos.get(row["platform_uid"], {}).get(bv) if bv else None
        if video is not None:
            mergeable.append((row, video, _note_text(row["body_json"])))

    total_dyn = cur.execute(
        "SELECT COUNT(*) FROM posts WHERE platform='bilibili' AND type='video_dynamic'"
    ).fetchone()[0]
    note_writes = sum(1 for _d, v, note in mergeable
                      if note and not (v["note"] or "").strip())

    print(f"投稿(video) {sum(len(v) for v in videos.values())} 条 · "
          f"投稿动态(video_dynamic) {total_dyn} 条")
    print(f"可归并 {len(mergeable)} 条（其中 {note_writes} 条会写入附言到 posts.note）")

    if args.dry_run:
        for d, v, note in mergeable[:5]:
            print(f"  dyn={d['platform_post_id']} → video={v['platform_post_id']}"
                  f"{'  (附言: ' + note[:30] + '…)' if note else ''}")
        print("(dry-run) 未做修改")
        conn.close()
        return

    written = deleted = 0
    for d, v, note in mergeable:
        if note and not (v["note"] or "").strip():
            cur.execute("UPDATE posts SET note=? WHERE id=?", (note, v["id"]))
            written += 1
        cur.execute("DELETE FROM posts WHERE id=?", (d["id"],))
        deleted += 1
    conn.commit()
    conn.close()
    print(f"完成：写入附言 {written} 条，删除重复的投稿动态 {deleted} 条")


if __name__ == "__main__":
    main()
