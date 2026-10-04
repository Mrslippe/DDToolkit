# -*- coding: utf-8 -*-
"""帖子媒体固化（2026-10-04，devlog/319；计划 `docs/plans/media-pinning-execution.md` 批次 1）。

## 它解决什么

图床地址是**平台签发的带时限地址**（`docs/GLOSSARY.md` 那条实测：库里 181 个小
红书图 URL 签于 10-03 00:50，到 10-04 13:54 **全部 403**，而本地推不出新签名）。
封面已经由 `PIN_POST_COVERS` 固化过一轮（`scheduler._pin_account_covers`），**正文媒体没有** ——
用户点开详情就是一片灰。

用户口径（2026-10-04）：「不论什么平台，未归档的帖子都可以作为轻资产固定下来，
已归档的部分就自动移除」+ 设置里可调（是否固化 / 未归档时长 / 是否清理归档 / 视频默认否）。

## 三条纪律（照抄封面固化那份实测教训）

1. **命中稳定键就一个请求都不发**（那是固化的收益本身）；
2. **每份落盘立刻 `commit()`** —— 绝不把网络下载包在一个长写事务里
   （2026-09-29 实测：只 commit 一次 ⇒ SQLite 写锁被攥住 ⇒ 全进程别的写全部 `database is locked`）；
3. **每轮有张数/字节上限**（B 站原图封面实测平均 1.1MB/张），超了留到下一轮。

## "归档自动移除"为什么不用新写一个清理器

`assets.prune(kind, max_bytes=0)` 的语义就是"**清空未 pin 且未被引用的**"，而媒体类的
"被引用"= **未归档帖**引用的（见 `assets._referenced_keys`）。两条一合：
**帖子一归档 ⇒ 失去保护 ⇒ 下一次清理就把它删掉**。所以这里只是把这件事包一层、
带上开关与报告，不重写淘汰逻辑。
"""
from __future__ import annotations

import logging
from datetime import timedelta

import httpx
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.vtuber import Account, Post
from app.services import assets

logger = logging.getLogger(__name__)

#: 每轮最多固化多少张图 / 多少字节（高级设置里可调；视频另有单文件上限 `assets.MAX_VIDEO_BYTES`）
DEFAULT_PER_ROUND = 20
DEFAULT_MB_PER_ROUND = 24

#: 查候选帖时多取几倍（命中的会跳过，够填满这一轮）
_CANDIDATE_FACTOR = 3


def _media_age_cutoff(days: float):
    """发布时间窗（`None` = 不限）。用户口径里的"未归档时长"就是它。"""
    d = float(days or 0)
    if d <= 0:
        return None
    return assets._now() - timedelta(days=d)


def _wanted_for_post(post_id: int, body_json: str | None, *, video: bool
                     ) -> list[tuple[int, str, list[str]]]:
    """一个帖子的工作项：图片逐张，视频是**镜像链**（一个工作项）。"""
    out: list[tuple[int, str, list[str]]] = []
    for u in assets._media_urls(body_json, video=False):
        out.append((post_id, assets.KIND_POST_IMAGE, [u]))
    if video:
        chain = assets._media_urls(body_json, video=True)
        if chain:
            out.append((post_id, assets.KIND_POST_VIDEO, chain))
    return out


def _caps() -> tuple[int, int, bool]:
    """当前的三条上限/开关：`(每轮份数, 每轮字节, 是否固化视频)`。"""
    per_round = int(getattr(settings, "MEDIA_PIN_PER_ROUND", DEFAULT_PER_ROUND) or DEFAULT_PER_ROUND)
    mb_round = float(getattr(settings, "MEDIA_PIN_MB_PER_ROUND", DEFAULT_MB_PER_ROUND)
                     or DEFAULT_MB_PER_ROUND)
    return per_round, int(mb_round * 1024 * 1024), bool(getattr(settings, "MEDIA_PIN_VIDEO", False))


async def _pin_items(db: Session, wanted: list[tuple[int, str, list[str]]], *,
                     per_round: int, max_bytes: int,
                     client: httpx.AsyncClient | None) -> dict:
    """把工作项逐份固化（**唯一**干活的循环：账号轮与单帖重取共用）。"""
    out = {"images": 0, "videos": 0, "skipped": 0, "bytes": 0, "reason": ""}
    if not wanted:
        out["reason"] = "没有需要固化的媒体"
        return out
    # 先把这一轮要碰的键**一次查完**（命中就跳过 ⇒ 不发请求）
    by_key: dict[tuple[str, str], object] = {}
    for kind in assets.MEDIA_KINDS:
        keys = [assets.key_of(u) for _p, k, us in wanted if k == kind for u in us]
        by_key.update({(kind, k): row for k, row in assets.lookup_keys(db, kind, keys).items()})

    own = False
    if client is None:
        from app.core.http import new_async_client
        client, own = new_async_client(20.0), True
    try:
        for post_id, kind, urls in wanted:
            if out["images"] + out["videos"] >= per_round:
                break
            if out["bytes"] and out["bytes"] >= max_bytes:
                logger.info(f"媒体固化本轮已达字节上限（{out['bytes'] / 1048576:.1f}MB），其余留到下一轮")
                break
            # 这条链里**已经有一份副本** ⇒ 零请求（镜像是同一份视频，不再存第二份）
            if any(assets.key_of(u) in {k for (kk, k) in by_key if kk == kind} for u in urls):
                out["skipped"] += 1
                continue
            got: tuple[str, bytes] | None = None
            for url in urls:
                key = assets.key_of(url)
                if not key:
                    continue
                try:
                    resp = await client.get(url)
                except Exception as e:                 # noqa: BLE001 —— 单份失败不中断整轮
                    logger.warning(f"媒体固化下载失败 post#{post_id} {kind}: "
                                   f"{type(e).__name__}: {e}")
                    continue
                if resp.status_code != 200 or not resp.content:
                    logger.info(f"媒体固化跳过 post#{post_id} {kind}：HTTP {resp.status_code}")
                    continue
                if kind == assets.KIND_POST_VIDEO and len(resp.content) > assets.MAX_VIDEO_BYTES:
                    logger.info(f"媒体固化跳过 post#{post_id} 视频（{len(resp.content) / 1048576:.1f}MB "
                                f"超过 {assets.MAX_VIDEO_BYTES / 1048576:.0f}MB 上限）")
                    continue
                got = (url, resp.content)
                break
            if got is None:
                out["skipped"] += 1
                continue
            url, data = got
            assets.put(db, kind, url, data, hint=f"p{post_id}")
            db.commit()          # ⚠️ 立刻放锁：下一份的下载不许挂在写事务里（见模块头第 2 条）
            by_key[(kind, assets.key_of(url))] = True
            out["videos" if kind == assets.KIND_POST_VIDEO else "images"] += 1
            out["bytes"] += len(data)
    finally:
        if own and client is not None:
            await client.aclose()
    return out


async def pin_post_media(db: Session, post: Post,
                         client: httpx.AsyncClient | None = None) -> dict:
    """只固化**这一帖**的媒体（`devlog/320`）：打开详情重取到新地址之后顺手做一次。

    为什么单独要它：重取拿到的又是**限时地址**，不立刻固化的话，过几小时再打开还是灰的。
    ⚠️ 这里**不看** `MEDIA_PIN_MAX_AGE_DAYS` 时间窗：那个窗是"批量轮该扫多老的帖"的成本闸，
    而这一帖是用户**这会儿正打开着**的（手动重取 = 明确的意图），拿时间窗挡它只会让人莫名其妙。
    """
    out = {"images": 0, "videos": 0, "skipped": 0, "bytes": 0, "reason": ""}
    if not bool(getattr(settings, "MEDIA_PIN_ENABLED", True)):
        out["reason"] = "开关关着"
        return out
    # 已归档的帖**不固化**：保护名单只认未归档帖（`assets._referenced_keys`），
    # 所以刚下下来的字节会被下一次归档清理立刻删掉 —— 白下一趟。重取本身照常
    # （用户这会儿正看着这一帖，新地址照样能画出来），只是不落盘。
    if bool(getattr(post, "is_archived", False)):
        out["reason"] = "帖子已归档（按口径不固化：归档即失去保护，下次清理会删）"
        return out
    per_round, max_bytes, want_video = _caps()
    wanted = _wanted_for_post(post.id, post.body_json, video=want_video)
    return await _pin_items(db, wanted, per_round=per_round, max_bytes=max_bytes, client=client)


async def pin_account_media(db: Session, acc: Account,
                            client: httpx.AsyncClient | None = None) -> dict:
    """把这个账号**未归档、且在时间窗内**的帖子媒体固化到本地。

    返回 `{images, videos, skipped, bytes, reason?}`（给日志与用例看，不写库）。
    `reason` 非空 = 整轮没跑（开关关着 / 没有候选），**不是错误**。
    """
    out = {"images": 0, "videos": 0, "skipped": 0, "bytes": 0, "reason": ""}
    if not bool(getattr(settings, "MEDIA_PIN_ENABLED", True)):
        out["reason"] = "开关关着"
        return out

    per_round, max_bytes, want_video = _caps()
    cutoff = _media_age_cutoff(getattr(settings, "MEDIA_PIN_MAX_AGE_DAYS", 30.0))

    q = (db.query(Post.id, Post.body_json)
         .filter(Post.platform == acc.platform,
                 Post.platform_uid == str(acc.platform_uid),
                 Post.is_archived == False,                     # noqa: E712 —— SQLAlchemy 需要 ==
                 Post.body_json.isnot(None)))
    if cutoff is not None:
        # `published_at` 是 naive UTC 字符串（库内口径），与 `assets._now()` 同源
        q = q.filter(Post.published_at >= cutoff.isoformat(sep=" "))
    rows = q.order_by(Post.published_at.desc(), Post.id.desc()).limit(per_round * _CANDIDATE_FACTOR).all()
    if not rows:
        out["reason"] = "没有候选帖（都归档了 / 都在时间窗之外）"
        return out

    wanted: list[tuple[int, str, list[str]]] = []
    for post_id, body in rows:
        wanted.extend(_wanted_for_post(post_id, body, video=want_video))
    out = await _pin_items(db, wanted, per_round=per_round, max_bytes=max_bytes, client=client)
    if out["images"] or out["videos"]:
        logger.info(f"媒体固化：账号 {acc.platform}:{acc.platform_uid} 本轮新增 "
                    f"{out['images']} 图 / {out['videos']} 视频（{out['bytes'] / 1048576:.1f}MB）")
    return out


def clean_archived(db: Session, *, dry_run: bool = False,
                   kinds: tuple[str, ...] = assets.MEDIA_KINDS) -> dict:
    """**归档就清**：把"只被归档帖引用"的媒体副本删掉（行 + 文件）。

    实现就是 `assets.prune(kind, max_bytes=0)`（"清空未 pin 且未被引用的"）——
    因为媒体类的"被引用"只算**未归档帖**（`assets._referenced_keys`）。

    - `MEDIA_PIN_CLEAN_ARCHIVED=False` ⇒ 直接返回 `{"skipped": "开关关着"}`（**不删任何东西**）；
    - `dry_run=True` ⇒ 只回候选（设置页的"将要清理"用它）；
    - ⚠️ **用户磁盘上的东西只许按这条规则减**：`pinned` 的、以及未归档帖引用的，一律不动。
    """
    if not bool(getattr(settings, "MEDIA_PIN_CLEAN_ARCHIVED", True)):
        return {"skipped": "开关关着（MEDIA_PIN_CLEAN_ARCHIVED）", "kinds": {}}
    report: dict = {"dry_run": bool(dry_run), "kinds": {}}
    for kind in kinds:
        part = assets.prune(db, kind=kind, max_bytes=0, dry_run=dry_run)
        report["kinds"].update(part["kinds"])
    freed = sum(int(k.get("freed_bytes") or 0) for k in report["kinds"].values())
    evicted = sum(len(k.get("evicted") or []) for k in report["kinds"].values())
    if evicted:
        logger.info(f"归档媒体清理：{'将删' if dry_run else '已删'} {evicted} 份"
                    f"（{freed / 1048576:.1f}MB）")
    return report
