"""
一次性数据修复：video / video_dynamic 统计补全（devlog/018）。

问题：
- video（视频投稿，arc/search）：stats_json 键为 play/comment，前端认 view/comment → 播放缺失；
- video_dynamic（投稿动态）：部分行只有动态互动（forward/like/comment），
  播放/投币/收藏/分享/弹幕缺失——这些都在 raw 的 major.archive.stat 里；键名 reply 未归一化。

修复：
- 所有行：_normalize_stats（play→view、reply→comment）；
- video_dynamic 行：从 raw 的 archive.stat + module_stat 重建完整统计
  （_archive_stats，与抓取逻辑同源）。

幂等：可重复执行。用法:
    python scripts/repair_post_stats.py --dry-run
    python scripts/repair_post_stats.py
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.config import settings
from app.services.fetcher import _normalize_stats


def _load(s):
    try:
        return json.loads(s) if s else {}
    except Exception:
        return {}


def _dump(o) -> str:
    return json.dumps(o, ensure_ascii=False, default=str)


def main():
    parser = argparse.ArgumentParser(description="补全 video / video_dynamic 统计")
    parser.add_argument("--dry-run", action="store_true", help="只统计不修改")
    args = parser.parse_args()

    db_path = settings.DATABASE_URL.replace("sqlite:///", "")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    rows = cur.execute(
        "SELECT id, type, stats_json, raw_json FROM posts WHERE type IN ('video', 'video_dynamic')"
    ).fetchall()
    print(f"候选: {len(rows)} 条（video / video_dynamic）")

    n_video_norm = 0      # 键名归一化（play→view / reply→comment）
    n_dyn_filled = 0      # video_dynamic 从 raw 补全
    n_changed = 0

    for r in rows:
        orig = _load(r["stats_json"])
        stats = _normalize_stats(orig)
        changed = stats != orig

        if r["type"] == "video_dynamic":
            raw = _load(r["raw_json"])
            md = (raw.get("modules") or {}).get("module_dynamic") or {}
            major = md.get("major") or {}
            vstat = (major.get("archive") or {}).get("stat") or {}
            dyn_stat = (raw.get("modules") or {}).get("module_stat") or {}

            if vstat:
                # 仅补入 raw 中确实存在的视频统计键，避免用 0 覆盖
                video_stats = {
                    "view": vstat.get("view"), "like": vstat.get("like"),
                    "coin": vstat.get("coin"), "favorite": vstat.get("favorite"),
                    "comment": vstat.get("reply"), "share": vstat.get("share"),
                    "danmaku": vstat.get("danmaku"),
                }
                video_stats = {k: v for k, v in video_stats.items() if v is not None}
                merged = {**stats, **video_stats}
                forward = (dyn_stat.get("forward") or {}).get("count")
                if forward is not None:
                    merged["forward"] = forward
                if merged != stats:
                    stats = merged
                    changed = True
                    n_dyn_filled += 1

        if not changed and r["type"] == "video":
            continue
        if changed:
            n_changed += 1
            if r["type"] == "video":
                n_video_norm += 1
            if not args.dry_run:
                cur.execute("UPDATE posts SET stats_json=? WHERE id=?", (_dump(stats), r["id"]))

    if not args.dry_run:
        conn.commit()

    print(f"将更新: {n_changed} 条（video 归一化 {n_video_norm}，video_dynamic 从 raw 补全 {n_dyn_filled}）")
    if args.dry_run:
        print("(dry-run) 未做修改")
    conn.close()


if __name__ == "__main__":
    main()
