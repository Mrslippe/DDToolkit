r"""一次性补全：把已入库的小红书笔记用**详情接口**补齐（正文 / 多图 / 标签 / 可用链接）。

背景（devlog/280）：列表接口 `/user_posted` 只给封面预览图与标题 —— 正文与多图只在
`POST /api/sns/web/v1/feed` 的 `note_card` 里。新帖由调度器的 `pf.enrich()` 钩子补，
**已经入库的旧帖**没人管，于是界面上一直是"一张封面 + 没有文字"。

    $env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\com.ddtoolkit.app-dev"   # 必设
    python scripts/backfill_xhs_details.py --limit 20       # 只补前 20 条（先看看效果）
    python scripts/backfill_xhs_details.py                  # 全部

节奏：每条之间 1.5s（详情接口也吃风控）；`--dry-run` 只列出待补的条数，不发请求。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import SessionLocal  # noqa: E402
from app.models.vtuber import Post  # noqa: E402
from app.services.platforms import registry  # noqa: E402
from app.services.post_text import extract_post_text  # noqa: E402

#: 详情补全会覆盖的字段（与 `parse_note_detail` 的输出对齐）
FIELDS = ("title", "summary", "type", "cover_url", "body_json", "stats_json",
          "published_at", "permalink", "raw_json")


def needs_detail(post: Post) -> bool:
    """要不要补：正文缺、或图只有一张（= 只有列表给的封面）。"""
    try:
        body = json.loads(post.body_json or "{}")
    except (TypeError, ValueError):
        body = {}
    images = body.get("images") or []
    return not body.get("desc") or len(images) <= 1


async def main() -> int:
    ap = argparse.ArgumentParser(description="补全小红书笔记详情")
    ap.add_argument("--limit", type=int, default=0, help="最多补多少条（0 = 全部）")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不发请求")
    ap.add_argument("--reparse-only", action="store_true",
                    help="**不联网**：只把已存的 raw_json 重新解析一遍"
                         "（解析逻辑升级后用，例如视频段/新字段 —— devlog/281）")
    ap.add_argument("--relink-only", action="store_true",
                    help="**只刷链接里的令牌**：拉一次列表页（1 个请求/账号）把 `xsec_token` "
                         "写回 raw_json 与 permalink（修「链接打不开」）")
    ap.add_argument("--gap", type=float, default=1.5, help="每条之间的间隔秒数")
    args = ap.parse_args()

    pf = registry.get_fetcher("xiaohongshu")
    if pf is None:
        raise SystemExit("注册表里没有小红书适配器")
    if not os.getenv("DDTOOLKIT_DATA_DIR"):
        print("⚠️ 未设 DDTOOLKIT_DATA_DIR：用的是项目根的裸跑残留库（多半不是真库）")

    db = SessionLocal()
    rows = (db.query(Post)
            .filter(Post.platform == "xiaohongshu")
            .order_by(Post.published_at.desc().nullslast() if hasattr(Post.published_at, "nullslast")
                      else Post.id.desc())
            .all())
    todo = [p for p in rows if args.reparse_only or needs_detail(p)]
    if args.limit:
        todo = todo[:args.limit]
    print(f"小红书帖子 {len(rows)} 条，待处理 {len(todo)} 条"
          f"{'（reparse-only：不联网）' if args.reparse_only else ''}"
          f"{'（dry-run，不发请求）' if args.dry_run else ''}")
    if args.dry_run or not todo:
        db.close()
        return 0

    if args.relink_only:
        from app.services.platforms.xiaohongshu import _explore_url
        fixed = 0
        by_uid: dict[str, list] = {}
        for p in rows:
            by_uid.setdefault(p.platform_uid, []).append(p)
        async with httpx.AsyncClient(timeout=25.0) as client:
            for uid, posts in by_uid.items():
                page = await pf.fetch_post_page(str(uid), None, client=client)
                if not page:
                    print(f"  {uid}: 列表拿不到（{pf.last_error}）")
                    continue
                tokens = {}
                for it in page["items"]:
                    try:
                        note = json.loads(it.get("raw_json") or "{}")
                    except (TypeError, ValueError):
                        continue
                    if note.get("note_id") and note.get("xsec_token"):
                        tokens[str(note["note_id"])] = str(note["xsec_token"])
                for post in posts:
                    tok = tokens.get(str(post.platform_post_id))
                    if not tok:
                        continue
                    try:
                        raw = json.loads(post.raw_json or "{}")
                    except (TypeError, ValueError):
                        raw = {}
                    raw["xsec_token"] = tok
                    post.raw_json = json.dumps(raw, ensure_ascii=False)
                    post.permalink = _explore_url(str(post.platform_post_id), tok)
                    fixed += 1
                db.commit()
                await asyncio.sleep(args.gap)
        print(f"链接令牌已刷新：{fixed} 条（未抓详情）")
        db.close()
        return 0

    if args.reparse_only:
        from app.services.platforms.xiaohongshu import (parse_note_detail,
                                                        token_from_permalink)
        changed = video = 0
        for i, post in enumerate(todo, 1):
            try:
                raw = json.loads(post.raw_json or "{}")
            except (TypeError, ValueError):
                raw = {}
            # ⚠️ 令牌优先从**旧链接**里捞回：详情 card 不含 `xsec_token`，只看 raw_json 会把它丢掉，
            #    链接就成了打不开的裸链（2026-10-03 踩过，devlog/281 §四）
            token = raw.get("xsec_token") or token_from_permalink(post.permalink)
            detail = parse_note_detail(raw, post.platform_uid, fallback_token=token)
            for k in FIELDS:
                if detail.get(k) is not None:
                    setattr(post, k, detail[k])
            post.body_text = extract_post_text(post.body_json)
            body = json.loads(post.body_json or "{}")
            changed += 1
            if body.get("video"):
                video += 1
                print(f"  [{i}/{len(todo)}] {post.platform_post_id} 🎬 "
                      f"{body['video']['width']}x{body['video']['height']} "
                      f"{body['video']['duration_s']}s 档={body['video']['codec']} "
                      f"fallback {len(body['video']['fallbacks'])} 条")
        db.commit()
        db.close()
        print(f"重解析完成：{changed} 条，其中带视频 {video} 条（未发任何网络请求）")
        return 0

    ok = fail = 0
    for i, post in enumerate(todo, 1):
        item = {
            "platform_post_id": post.platform_post_id,
            "raw_json": post.raw_json or "{}",
        }
        try:
            got = await pf.enrich(item)
        except Exception as e:  # noqa: BLE001 —— 单条失败不影响其余
            print(f"  [{i}/{len(todo)}] {post.platform_post_id} 异常：{type(e).__name__}: {e}")
            got = False
        if got:
            for k in FIELDS:
                if item.get(k) is not None:
                    setattr(post, k, item[k])
            # 全文搜索用的派生文本要跟着刷新（落库路径里也是这一步）
            post.body_text = extract_post_text(post.body_json)
            ok += 1
            body = json.loads(post.body_json or "{}")
            print(f"  [{i}/{len(todo)}] {post.platform_post_id} ✓ 图 {len(body.get('images') or [])} 张"
                  f" / 正文 {len(str(body.get('desc') or ''))} 字")
        else:
            fail += 1
            reason = (pf.last_error or {}).get("msg") or (pf.last_error or {}).get("kind") or "未知"
            print(f"  [{i}/{len(todo)}] {post.platform_post_id} ✗ {reason}")
        if i < len(todo):
            await asyncio.sleep(args.gap)
        if i % 10 == 0:
            db.commit()          # 分批提交：中断也不丢已补的
    db.commit()
    db.close()
    print(f"补全完成：成功 {ok}，失败 {fail}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
