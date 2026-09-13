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
"""
from __future__ import annotations

import asyncio
import logging
import time

from app.services.externals.danmakus import fetch_live_events, fetch_live_summary

logger = logging.getLogger(__name__)

_CACHE: dict[str, tuple[dict, list[dict], float]] = {}
_CACHE_MAX = 64
_CACHE_TTL = 600.0


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
    """
    hit = _cache_get(live_id)
    if hit is not None:
        logger.debug(f"live upstream 缓存命中 liveId={live_id}")
        return hit
    summary, events = await asyncio.gather(
        fetch_live_summary(live_id), fetch_live_events(live_id))
    if summary is not None:
        _cache_put(live_id, summary, events)
    return summary, events
