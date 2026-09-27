"""B 站专属的**帖子实现**（第 4 阶段的 ① 第二刀，devlog/236）。

## 为什么单独一个模块

`_fetch_posts_core` 现在只认 `PostStreams` 那套通用形状（第一刀，devlog/229），
但 B 站的**实现细节**还留在 `scheduler.py` 里 —— 那里住着编排（锁、会话、批量任务、
风控节流），平台实现混在里面，读的人分不清"哪部分是所有平台都要做的"。

这一刀把 B 站专属的五个函数搬出来：

| 函数 | 干什么 | 谁调它 |
|---|---|---|
| `video_bvid_index` | bvid → 已入库 video 帖（投稿动态合并用） | `BILIBILI_STREAMS.bvid_index` |
| `absorb_video_dynamic` | 把「投稿动态」并进同 bvid 的投稿帖（附言写 note） | `BILIBILI_STREAMS.absorb_video_dynamic` |
| `enrich_dynamic_item` | 动态详情补全（opus / 专栏 delta / 视频统计合并） | `BILIBILI_STREAMS.enrich_item` + 置顶刷新 |
| `refresh_pinned_post` | 置顶帖两档刷新（feed 级免费 / 详情级节流） | `BILIBILI_STREAMS.refresh_pinned` |
| `route_live_item` | 直播开播卡 → `live_sessions`（不进 posts） | `BILIBILI_STREAMS.route_non_post` |

⚠️ **判据盯着这条**：`scheduler.py` 里不许再出现这五个函数的**定义**（`test_posts_core_platform.py`
的 AST 判据），绑定只在 `BILIBILI_STREAMS` 那一处。

## 两条搬家的坑（都实测踩过）

1. `_safe_json_parse` 原先是 `scheduler` 的**私有**函数，新模块 import scheduler 会成环
   ⇒ 提到 `app/core/jsonsafe.py`（语义没动，scheduler 用别名继续用旧名字）；
2. 测试里 `monkeypatch.setattr(sch, "fetch_dynamic_detail", …)` 这类**打在 scheduler 名字上**的
   补丁会**静默失效**（新模块有自己的模块级名字，补丁打不到）⇒ 那 5 处补丁目标跟着实现搬家。
   这也是"整体拆分搁置"的老理由，本刀把它一条条数清并改掉。
"""
import asyncio
import json as _json
import logging
import random
from datetime import datetime, timezone

# ⚠️ 别删：`enrich_dynamic_item(client: httpx.AsyncClient | None)` 的注解要它。
#    本地 .venv 是 3.14（PEP 649 惰性注解）⇒ 少了这行本地照样全绿，CI 的 3.12 腿
#    在 `def` 时就炸 `NameError`（2026-09-27 实测，四条腿全红）。判据见
#    `tests/test_annotations_resolve.py`。
import httpx
from sqlalchemy.orm import Session

from app.core.config import settings
# 搬过来的代码把老的 `_safe_json_parse(...)` 调用换成了新家的名字（同一份实现，
# 语义逐字未动：空/非法/非 dict → 空字典）。scheduler 那边用别名继续叫旧名字。
from app.core.jsonsafe import safe_json_dict
from app.models.vtuber import Account, Post
from app.repositories.vtuber_repo import LiveSessionRepo, PostRepo
from app.services.fetcher import (clear_rate_limit, fetch_article_detail,
                                  fetch_dynamic_detail, fetch_video_detail)
from app.services.pinned_posts import (DETAIL_REFRESH_TYPES, detail_refresh_due,
                                       refresh_fields)

logger = logging.getLogger(__name__)


def video_bvid_index(db: Session, platform_uid: str) -> dict[str, str]:
    """bvid → 已入库 `video` 帖的 platform_post_id（P9-3 合并用）。

    只为「投稿动态」判断该 bvid 是否已有投稿记录；一账号几百条视频，解析
    body_json 的成本可接受（比每次查库便宜）。
    """
    out: dict[str, str] = {}
    rows = db.query(Post.platform_post_id, Post.body_json).filter(
        Post.platform == "bilibili", Post.platform_uid == platform_uid,
        Post.type == "video",
    ).all()
    for pid, body in rows:
        bvid = (safe_json_dict(body) or {}).get("bvid") or pid
        if bvid:
            out[str(bvid)] = str(pid)
    return out


def absorb_video_dynamic(db: Session, platform_uid: str, item: dict,
                          video_by_bvid: dict[str, str]) -> str | None:
    """把「投稿动态」并入同 bvid 的投稿帖：附言写 note，返回被并入的 video pid。

    返回 None 表示这不是「已有投稿的重复动态」（调用方按普通新帖入库）。
    合并口径见 devlog/047：列表里一条视频只出现一次，动态附言以「UP 主附言」展示。
    """
    body = safe_json_dict(item.get("body_json"))
    bvid = str(body.get("bvid") or "")
    pid = video_by_bvid.get(bvid) if bvid else None
    if not pid:
        return None
    text = (body.get("text") or "").strip()
    if text:
        # 只补空缺的附言，不覆盖已有内容（贴文附言可能被作者改过，先到先得更稳）
        row = db.query(Post.note).filter(
            Post.platform == "bilibili", Post.platform_uid == platform_uid,
            Post.platform_post_id == pid,
        ).first()
        if row is not None and not (row[0] or "").strip():
            db.query(Post).filter(
                Post.platform == "bilibili", Post.platform_uid == platform_uid,
                Post.platform_post_id == pid,
            ).update({Post.note: text}, synchronize_session=False)
    return pid


async def enrich_dynamic_item(d: dict, *, client: httpx.AsyncClient | None = None) -> bool:
    """B 站动态条目的详情补全。返回是否**真的拿到了详情**（供置顶刷新判定成败）。

    新帖入库与置顶帖刷新共用同一套合并口径 —— 详情字段的取舍很细（防丢图、
    专栏 delta、视频统计合并），两处各写一遍必然漂移。
    """
    got_detail = False

    # 图文 / 纯文字 → detail API 拿 OPUS 格式完整数据
    if d["type"] in ("text", "image"):
        # 防丢图：detail（opusBigCover 特性）可能只回 1 张封面图，
        # 若 feed 的图片数更多，保留 feed 的 images
        feed_body = safe_json_dict(d.get("body_json", "{}"))
        feed_images = feed_body.get("images") if isinstance(feed_body, dict) else None

        detail = await fetch_dynamic_detail(d["platform_post_id"], client=client)
        if detail:
            for key in ("title", "summary", "cover_url", "body_json", "stats_json",
                         "permalink", "raw_json", "published_at"):
                if key in detail and detail[key] is not None:
                    d[key] = detail[key]
            if feed_images:
                detail_body = safe_json_dict(d.get("body_json", "{}"))
                if len(detail_body.get("images") or []) < len(feed_images):
                    detail_body["images"] = feed_images
                    d["body_json"] = _json.dumps(detail_body, ensure_ascii=False, default=str)
            await asyncio.sleep(random.uniform(0.5, 2.0))
            got_detail = True
        else:
            logger.warning(f"动态详情获取失败 id={d['platform_post_id']}, 使用 feed 数据")

    # 专栏 → 拉取全文
    if d["type"] == "article":
        body = safe_json_dict(d.get("body_json", "{}"))
        cv_id = body.get("cv_id") if isinstance(body, dict) else None
        if cv_id:
            detail = await fetch_article_detail(cv_id, client=client)
            if detail:
                d["body_json"] = _json.dumps({**body, "content": detail["content"]}, ensure_ascii=False, default=str)
                # 修复：Delta 富文本专栏 → 补 delta 字段 + 纯文本（列表摘要用）
                if detail.get("delta"):
                    d["body_json"] = _json.dumps({
                        **safe_json_dict(d["body_json"], {}),
                        "delta": detail["delta"],
                        "text": detail["delta_text"] or body.get("text", ""),
                    }, ensure_ascii=False, default=str)
                d["summary"] = detail["summary"] or detail.get("delta_text") or d["summary"]
                d["stats_json"] = _json.dumps({
                    "view": detail.get("stats", {}).get("view", 0),
                    "like": detail.get("stats", {}).get("like", 0),
                    "comment": detail.get("stats", {}).get("reply", 0),
                    "favorite": detail.get("stats", {}).get("favorite", 0),
                }, ensure_ascii=False, default=str)
                await asyncio.sleep(random.uniform(0.5, 2.0))
                got_detail = True
    elif d["type"] in ("video", "video_dynamic"):
        body = safe_json_dict(d.get("body_json", "{}"))
        bvid = body.get("bvid") if isinstance(body, dict) else None
        if bvid:
            detail = await fetch_video_detail(bvid, client=client)
            if detail:
                d["body_json"] = _json.dumps({
                    **body,
                    "description": detail["desc"],
                    "duration_sec": detail["duration"],
                    "owner": detail["owner_name"],
                    "tags": detail["tname"],
                }, ensure_ascii=False, default=str)
                d["cover_url"] = d["cover_url"] or detail.get("pages", [{}])[0].get("first_frame", "")
                # 合并：详情统计（view/coin/...）+ 动态互动（forward/dyn_like/...）
                feed_stats = safe_json_dict(d.get("stats_json"), {})
                d["stats_json"] = _json.dumps(
                    {**feed_stats, **detail["stat"]}, ensure_ascii=False, default=str
                )
                await asyncio.sleep(random.uniform(0.5, 2.0))
                got_detail = True

    return got_detail

async def refresh_pinned_post(post_repo: PostRepo, platform: str, platform_uid: str,
                               item: dict, *, detail_refresher=None) -> bool:
    """刷新一条**已入库**的置顶帖（R35）。返回是否命中既存行。

    为什么需要单独一条写路径：`_safe_store_post` 遇到唯一约束冲突只
    `rollback` + 跳过，**永远不更新既存行** —— 作者改周表/舰礼图之后，库里还是
    首次抓到的那个版本（用户 2026-09-17 反馈的正是这个）。

    两档刷新（口径见 settings.PINNED_DETAIL_REFRESH_HOURS）：
      · feed 级：每轮都写，零额外请求（标题/摘要/封面/互动数来自列表页响应本身）；
      · 详情级：节流窗口内不重复请求；只有**真的拿到详情**才盖时间戳，失败时
        保留 feed 级刷新并 warn（下轮重试）——"静默失败"不能看起来像"没更新"。
    """
    pid = str(item["platform_post_id"])
    row = post_repo.by_pid(platform, platform_uid, pid)
    if row is None:
        return False

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    fields = refresh_fields(item, with_detail=False)      # feed 级（免费）
    with_detail = (
        detail_refresher is not None
        and row.type in DETAIL_REFRESH_TYPES
        and detail_refresh_due(row.pinned_refreshed_at, now,
                               settings.PINNED_DETAIL_REFRESH_HOURS)
    )
    if with_detail:
        # 详情请求会把新值合并进 item，必须在取 feed 级字段**之后**再取一次详情级字段
        ok = bool(await detail_refresher())
        clear_rate_limit()      # 详情风控标志只用于列表页判定，处理完立即清除
        if ok:
            fields.update(refresh_fields(item, with_detail=True))
            fields["pinned_refreshed_at"] = now
        else:
            logger.warning(f"置顶动态详情刷新失败 {platform}:{platform_uid} pid={pid}"
                           f"（本轮只刷 feed 字段，下轮重试）")

    changed = [k for k, v in fields.items() if getattr(row, k, None) != v]
    if not changed:
        return True
    post_repo.update(row.id, fields)
    logger.info(f"置顶动态已刷新 {platform}:{platform_uid} pid={pid} "
                f"来源={'详情' if with_detail else 'feed'} 字段={','.join(sorted(changed))}")
    return True

# 直播场次路由：mid → account_id（live_sessions 需账号外键；账号表稳定，进程内缓存）
_ACCOUNT_ID_CACHE: dict[str, int | None] = {}


def _account_id(db: Session, mid: int) -> int | None:
    key = str(mid)
    if key not in _ACCOUNT_ID_CACHE:
        acc = (
            db.query(Account)
            .filter(Account.platform == "bilibili", Account.platform_uid == key)
            .first()
        )
        _ACCOUNT_ID_CACHE[key] = acc.id if acc else None
    return _ACCOUNT_ID_CACHE[key]


def route_live_item(db: Session, mid: int, d: dict) -> None:
    """直播开播卡片（type='live'）→ live_sessions 表（v0.9.x M2）。

    数据不进入 posts 档案；live_id（B站场次 key）幂等 upsert；
    秒级开播时间来自 live_play_info.live_start_time；end_at 由
    merged() 用 self 快照/次日 danmakus 同步补全。
    """
    body = safe_json_dict(d.get("body_json") or "{}")
    live_id = str(body.get("live_id") or "")
    start_ts = body.get("live_start_time")
    if not live_id:
        logger.warning(f"直播场次无 live_id，跳过: dyn={d.get('platform_post_id')}")
        return
    if not start_ts:
        logger.warning(f"直播场次无 live_start_time，跳过: live_id={live_id}")
        return
    try:
        start_at = datetime.fromtimestamp(int(start_ts), tz=timezone.utc).replace(tzinfo=None)
    except (TypeError, ValueError, OverflowError, OSError):
        logger.warning(f"直播场次 start_ts 异常: {start_ts}, live_id={live_id}")
        return
    account_id = _account_id(db, mid)
    if account_id is None:
        logger.warning(f"mid={mid} 无对应账号，直播场次未入库: live_id={live_id}")
        return
    added = LiveSessionRepo(db).upsert_feed(account_id, live_id, {
        "title": (d.get("title") or "").strip() or None,
        "room_id": str(body.get("room_id") or "") or None,
        "parent_area_name": body.get("parent_area_name"),
        "area_name": body.get("area_name"),
        "cover_url": d.get("cover_url"),
        "start_at": start_at,
        "raw_json": d.get("raw_json"),
    })
    if added:
        logger.info(f"mid={mid} 直播场次入库 feed: live_id={live_id} title={d.get('title')!r}")
