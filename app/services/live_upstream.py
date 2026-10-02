"""场次详情里「必须打第三方」的那部分取数（2026-09-13，devlog/063）。

## 为什么独立成模块

详情端点原本把 danmakus 的两个请求（场次摘要 + 中断/继续事件）放在**同一条同步路径**上：
上游慢时整个弹窗一起转圈 —— 只依赖本地库的时间/分区/收益/分类也被拖住，
最坏 `3×30s + 退避 ≈ 93s` 才知道结果（而这段时间里用户无法区分"上游慢"与"上游没响应"）。

现在拆开：

- 详情端点（`/live-sessions/{id}`）**只回本地库数据** → 弹窗秒开；
- 上游取数走独立端点（`/live-sessions/{id}/upstream`）→ 弹幕段与直播动态段各自 loading、
  可就地重试，慢与失败只影响这两格。

本模块是那两格的取数口：并发取 + 进程内缓存。HTTP 与降级契约见 `danmakus.py`。

## 缓存口径

- 键 = `live_id`，值 = `(summary, events, 插入时刻)`；
- TTL `_CACHE_TTL`（10 分钟）：挡"同一场次反复开关弹窗"的重复请求；
- 上限 `_CACHE_MAX` 条，超出按插入顺序淘汰（使用模式是"看几场"，不需要 LRU 精度）；
- **只在拿到 summary 时写缓存**：失败不缓存 —— 用户点「重试」应当真的重试。

## 单飞（single-flight，2026-09-14，devlog/081）

缓存只在**成功之后**才写，所以两个**同时**到达的请求都会 miss、都会各打一轮上游
（用户点一次详情看到 4 个上游请求）。`_INFLIGHT` 让同 liveId 的并发调用共享同一个取数任务：

- 只在**同一个事件循环**内复用（`(loop, task)`）：后端跑在 uvicorn 的单循环里，
  而脚本/测试可能各自 `asyncio.run` —— 跨循环 await 别人的 Task 是 devlog/076 那类事故；
- `asyncio.shield` 包一层：某个调用者被取消（客户端断开）不会把共享任务一起掐掉；
- **失败即清**（`finally` 里只清自己的那条）：失败不进缓存，下次调用会真的重试。
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.http import new_async_client
from app.repositories.vtuber_repo import AccountRepo, LiveSessionRepo
from app.services.externals.danmakus import fetch_live_events, fetch_live_summary
from app.services.externals.registry import get_external_source

logger = logging.getLogger(__name__)

_CACHE: dict[str, tuple[dict, list[dict], float]] = {}
_CACHE_MAX = 64
_CACHE_TTL = 600.0
# live_id → (所属事件循环, 在途任务)：只在同一循环里复用（见模块 docstring）
_INFLIGHT: dict[str, tuple[asyncio.AbstractEventLoop, "asyncio.Task[Any]"]] = {}


def _cache_get(live_id: str) -> tuple[dict, list[dict]] | None:
    hit = _CACHE.get(live_id)
    if not hit:
        return None
    summary, events, at = hit
    if time.monotonic() - at > _CACHE_TTL:
        _CACHE.pop(live_id, None)
        return None
    return summary, events


def _cache_put(live_id: str, summary: dict, events: list[dict]) -> None:
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)), None)   # 插入顺序淘汰（dict 保序）
    _CACHE[live_id] = (summary, events, time.monotonic())


def clear_cache() -> None:
    """清空缓存（测试与排查用）。"""
    _CACHE.clear()


async def load_live_upstream(live_id: str) -> tuple[dict | None, list[dict]]:
    """并发取「场次摘要 + 直播间事件」，返回 `(summary | None, events)`。

    两个请求都是最多 3 次重试、单次 30s 超时（见 `danmakus.fetch_live_summary`），
    **并发**发出，所以这一层的耗时是"较慢的那个"，不是两者相加。
    `summary is None` = 上游这次没拿到（调用方据此报 `fetch_failed`，而不是"本场没弹幕"）。

    ## 单飞（single-flight，2026-09-14，devlog/081）

    没有单飞时，**同一 liveId 的并发调用会各自打一轮上游**：缓存只在**成功返回后**才写入，
    两个同时到达的请求都会 miss、都会发 summary+events —— 用户点一次详情看到 4 个上游请求
    （dev 环境 StrictMode 双挂载会调两次），而上游对同一场次的重复请求纯属浪费。
    现在同 liveId 的并发调用共享同一个取数任务；**失败不共享**（失败立即清掉在途表，
    下次调用会重试）。
    """
    hit = _cache_get(live_id)
    if hit is not None:
        logger.debug(f"live upstream 缓存命中 liveId={live_id}")
        return hit
    loop = asyncio.get_running_loop()
    task = _INFLIGHT.get(live_id)
    if task is not None and task[0] is loop and not task[1].done():
        logger.info(f"live upstream 单飞复用 liveId={live_id}（已有同场次在途请求）")
        return await asyncio.shield(task[1])

    async def _fetch() -> tuple[dict | None, list[dict]]:
        summary, events = await asyncio.gather(
            fetch_live_summary(live_id), fetch_live_events(live_id))
        if summary is not None:
            _cache_put(live_id, summary, events)
        return summary, events

    created = loop.create_task(_fetch())
    _INFLIGHT[live_id] = (loop, created)
    try:
        return await asyncio.shield(created)
    finally:
        # 在途表里仍是自己时才清（并发的第二个调用者不会覆盖它）
        cur = _INFLIGHT.get(live_id)
        if cur is not None and cur[1] is created:
            _INFLIGHT.pop(live_id, None)


def inflight_count() -> int:
    """在途取数条数（测试与排查用）。"""
    return len(_INFLIGHT)


# ── 按需现查（2026-10-02，devlog/275）──────────────────────────────────────
#
# 用户口径：**打开一场没有弹幕记录的详情时，应该回退到 danmakus 去查**
# （原话「即使本地的数据源没有包含弹幕记录但也没有回退到 danmakus」）。
#
# 为什么本地会"没有"：场次行有两个来源 —— feed（B 站 live_rcmd，秒级、只有标题/起止）
# 与 danmakus（第三方的固定化场次，带弹幕数/收益/词云）。后者的入库只靠每日同步，
# 而那次同步会被上游 WAF 拦、且原先失败不重试 ⇒ 一场直播结束后，本地可能**永远**
# 停在 feed 行上，详情里的「弹幕信息」就一直是"没有记录"（即使上游早就有）。
#
# 所以这里在**用户看得见的那一刻**补一次定向拉取：只拉该账号的 channel（全量场次，
# 一次请求），命中就把 danmakus 行补进库、重新定位合并后的场次、接着走正常取数。

LOOKUP_RECORDED = "recorded"     # 现查补到了这一场（调用方拿返回的场次继续取数）
LOOKUP_ABSENT = "absent"         # 问了上游，确实没有这一场
LOOKUP_FAILED = "failed"         # 这次没问成（WAF/网络）—— 与"没有"必须分开说

_LOOKUP_TTL = 600.0              # 同账号 10 分钟内只现查一次（结论沿用上次）
_LOOKUP_ATTEMPTS = 2             # 点击路径：不重试三次，别让一次点击等十几秒
_LOOKUP_MAX_AGE_DAYS = 14        # 太老的纯 feed 场次不必现查（上游早该有）
_LOOKUP: dict[int, tuple[float, str]] = {}
_LOOKUP_INFLIGHT: dict[int, tuple[asyncio.AbstractEventLoop, "asyncio.Task[Any]"]] = {}


def has_danmakus_source(s: dict) -> bool:
    """该场次是否有 danmakus 来源（`source` 是 `+` 连接的组合标记）。"""
    return "danmakus" in (s.get("source") or "").split("+")


def _danmakus_source():
    """注册表里的 danmakus 源（三道开关全开才返回，否则 None）。"""
    src = get_external_source("danmakus")
    if src is None or not settings.EXTERNAL_ENABLED or not src.enabled:
        return None
    return src if getattr(settings, "EXTERNAL_DANMAKUS_ENABLED", True) else None


def clear_lookup_state() -> None:
    """清空现查节流表（测试与排查用）。"""
    _LOOKUP.clear()


def _lookup_throttled(account_id: int) -> str | None:
    hit = _LOOKUP.get(account_id)
    if hit is None:
        return None
    at, outcome = hit
    return outcome if time.monotonic() - at <= _LOOKUP_TTL else None


async def ensure_session_recorded(db: Session, account_id: int,
                                  s: dict, *, force: bool = False
                                  ) -> tuple[str, dict | None]:
    """场次没有 danmakus 来源时，现去 danmakus 查一次（见上面一节的说明）。

    返回 `(结果, 重新定位到的场次 | None)`，结果是 `LOOKUP_RECORDED` /
    `LOOKUP_ABSENT` / `LOOKUP_FAILED` 之一。`RECORDED` 时返回的场次 dict 是**合并后**
    的形态 —— 它的 `live_id` 通常已经变成 danmakus uuid（对外 id 按源优先级定权），
    调用方要用它去取上游，而不是拿原来的 feed 数字 id。

    节流与单飞：同账号 10 分钟一次、并发共享同一个在途任务。**这不是优化而是必须**：
    该路径由"打开详情"触发，而 danmakus 的 channel 端点在连打时会被 WAF 拦
    （实测 9 个账号连打 3 个 302）。

    `force=True`（用户**显式**点重试/查一次）绕过节流：否则点了按钮却不问上游，
    "重试"就成了一句空话。
    """
    live_id = str(s.get("live_id") or "")
    start_at = s.get("start_at")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if not live_id or not isinstance(start_at, datetime):
        return LOOKUP_ABSENT, None
    if start_at < now - timedelta(days=_LOOKUP_MAX_AGE_DAYS):
        # 老场次：上游早该收录了，没有就是没有；不为它出网
        return LOOKUP_ABSENT, None

    last = None if force else _lookup_throttled(account_id)
    if last is not None:
        logger.info(f"场次现查节流命中 account={account_id}（上次结论 {last}）")
        return last, None

    loop = asyncio.get_running_loop()
    task = _LOOKUP_INFLIGHT.get(account_id)
    if task is not None and task[0] is loop and not task[1].done():
        logger.info(f"场次现查单飞复用 account={account_id}")
        return await asyncio.shield(task[1])

    async def _check() -> tuple[str, dict | None]:
        src = _danmakus_source()
        if src is None:
            # 源被用户关了 / 全局关停：不出网，也不谎称"上游没有"
            logger.info("场次现查跳过：danmakus 源未启用")
            return LOOKUP_ABSENT, None
        acc = AccountRepo(db).get(account_id)
        if acc is None:
            return LOOKUP_ABSENT, None
        async with new_async_client(25.0) as client:
            res = await src.sync_account(db, acc, client, attempts=_LOOKUP_ATTEMPTS)
        if res.get("reason"):
            logger.warning(f"场次现查没问成 account={account_id}: {res['reason']}")
            return LOOKUP_FAILED, None
        groups = LiveSessionRepo(db).merged(account_id, with_ids=True)
        hit = next((g for g in groups
                    if live_id in (g.get("src_live_ids") or {}).values()), None)
        if hit is not None and has_danmakus_source(hit):
            logger.info(f"场次现查命中 account={account_id} live_id={live_id} "
                        f"→ {hit.get('live_id')}（新增 {res.get('added')} 行）")
            return LOOKUP_RECORDED, hit
        return LOOKUP_ABSENT, None

    created = loop.create_task(_check())
    _LOOKUP_INFLIGHT[account_id] = (loop, created)
    try:
        outcome, found = await asyncio.shield(created)
    finally:
        cur = _LOOKUP_INFLIGHT.get(account_id)
        if cur is not None and cur[1] is created:
            _LOOKUP_INFLIGHT.pop(account_id, None)
    if outcome != LOOKUP_RECORDED:
        # 只记"没查到/没问成"的结论；命中不需要记（本地已经有 danmakus 行了）
        _LOOKUP[account_id] = (time.monotonic(), outcome)
    return outcome, found


def lookup_inflight_count() -> int:
    """在途现查条数（测试与排查用）。"""
    return len(_LOOKUP_INFLIGHT)
