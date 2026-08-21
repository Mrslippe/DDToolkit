"""
一次性数据修复：帖子内容字段重建（repost 原文 / 直播预约 / 专栏 Delta）。

背景（devlog/015）：
A. 转发帖（repost）顶层 major 为空，原文在 raw.orig —— 此前未提取，
   1,718 条 summary/body_json 为空。抓取逻辑已修复，本脚本重建存量。
B. 直播预约卡片（raw: modules.module_dynamic.additional.reserve）此前未提取，
   补进 body_json.reservation。
C. 专栏 Delta 富文本（body_json.content 为 {"ops":[...]}）补 body_json.delta/text。

幂等：可重复执行（已具备的字段跳过）。
用法:
    python scripts/repair_repost_origin.py --dry-run
    python scripts/repair_repost_origin.py
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.config import settings
from app.services.fetcher import (
    _extract_origin, _extract_reservation,
    _is_delta_content, _delta_to_plain_text,
)


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _load(s: str | None) -> dict:
    if not s:
        return {}
    try:
        return json.loads(s)
    except Exception:
        return {}


def _load_item(raw_json: str | None) -> dict:
    return _load(raw_json)


def main():
    parser = argparse.ArgumentParser(description="重建帖子内容字段（repost/reservation/delta）")
    parser.add_argument("--dry-run", action="store_true", help="只统计不修改")
    args = parser.parse_args()

    db_path = settings.DATABASE_URL.replace("sqlite:///", "")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # ── A. repost 原文重建 ──
    print("=" * 70)
    reposts = cur.execute("SELECT id, title, summary, cover_url, body_json, raw_json "
                          "FROM posts WHERE type='repost'").fetchall()
    n_repost = len(reposts)
    n_fixed = 0
    n_skipped = 0
    for r in reposts:
        item = _load_item(r["raw_json"])
        origin = _extract_origin(item)
        if not origin:
            n_skipped += 1
            continue
        desc_text = ""
        md = (item.get("modules") or {}).get("module_dynamic") or {}
        desc = md.get("desc") or {}
        desc_text = desc.get("text", "") if isinstance(desc, dict) else ""
        full_text = origin["text"] or ""
        if desc_text:
            full_text = (desc_text + "\n" + full_text) if full_text else desc_text
        new_body = _dump({"text": desc_text, "origin": origin})
        new_title = f"转发：{origin['title']}" if origin.get("title") else ""
        new_summary = full_text[:200] if full_text else ""
        new_cover = origin.get("cover_url") or ""
        if (r["summary"] or "") == new_summary and (r["body_json"] or "") == new_body:
            n_skipped += 1
            continue
        if not args.dry_run:
            cur.execute(
                "UPDATE posts SET summary=?, body_json=?, title=?, cover_url=? WHERE id=?",
                (new_summary, new_body, new_title, new_cover, r["id"]),
            )
        n_fixed += 1
    print(f"A. repost: 共 {n_repost} 条，重建 {n_fixed}，跳过(无变化/无origin) {n_skipped}")

    # ── B. 直播预约提取 ──
    rows_b = cur.execute("SELECT id, body_json, raw_json FROM posts "
                         "WHERE raw_json LIKE '%reserve%'").fetchall()
    n_b_fixed = 0
    n_b_skip = 0
    for r in rows_b:
        item = _load_item(r["raw_json"])
        md = (item.get("modules") or {}).get("module_dynamic") or {}
        res = _extract_reservation(md)
        if not res:
            n_b_skip += 1
            continue
        body = _load(r["body_json"])
        if body.get("reservation") == res:
            n_b_skip += 1
            continue
        body["reservation"] = res
        if not args.dry_run:
            cur.execute("UPDATE posts SET body_json=? WHERE id=?", (_dump(body), r["id"]))
        n_b_fixed += 1
    print(f"B. 直播预约: 命中 {len(rows_b)} 条，补全 {n_b_fixed}，跳过 {n_b_skip}")

    # ── C. 专栏 Delta 补全 ──
    rows_c = cur.execute("SELECT id, body_json FROM posts WHERE type='article'").fetchall()
    n_c_fixed = 0
    n_c_skip = 0
    for r in rows_c:
        body = _load(r["body_json"])
        content = body.get("content")
        if not _is_delta_content(content):
            n_c_skip += 1
            continue
        if body.get("delta"):
            n_c_skip += 1
            continue
        body["delta"] = content
        body["text"] = _delta_to_plain_text(content) or body.get("text", "")
        if not args.dry_run:
            cur.execute("UPDATE posts SET body_json=? WHERE id=?", (_dump(body), r["id"]))
        n_c_fixed += 1
    print(f"C. 专栏 Delta: 共 {len(rows_c)} 条，补全 {n_c_fixed}，跳过 {n_c_skip}")

    if not args.dry_run:
        conn.commit()
        print("已提交。")
    else:
        print("(dry-run) 未做修改")
    conn.close()


if __name__ == "__main__":
    main()
