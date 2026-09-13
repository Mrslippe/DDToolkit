"""词云自建的服务层（2026-09-13，danmakus 断供后的方案 a）。

## 背景与分工

上游 `/api/v2/live` 的 `extra.wordCloud` 已断供（devlog/060），但原始弹幕仍公开可取。
本模块把「拉原始弹幕 → 提取文本 → 分词计数」串起来，供路由层按需调用。

## 决策口径（用户 2026-09-13 定）

- **D1**：上游优先，**不自动回退** —— 上游没给热词时前端显示按钮，用户点了才走自建；
- **D3**：**仅点击时拉取**，且**暂不落库** —— 因此这里只有进程内缓存（见 `_CACHE`）。

## 缓存

单场全量弹幕是**几千~几万条、约 2MB** 的响应（实测某场 18764 条），
一次自建分词约 0.1ms/条。缓存避免"同一场次反复点按钮"重复拉取。
- 键 = `live_id`，值 = `(结果, 插入时刻)`；
- 上限 `_CACHE_MAX` 条，超出按插入顺序淘汰（弹幕会话的使用模式是"看几场"，
  不需要 LRU 精度）；
- **不做持久化**：落库属于「原始弹幕明细库」那条线（见 docs/TODO.md），
  是独立决策，本批不混进来。
"""
from __future__ import annotations

import logging
import time
from typing import Iterable

from app.services.danmaku_words import count_tokens, iter_texts_from_records
from app.services.externals.danmakus import fetch_raw_danmakus

logger = logging.getLogger(__name__)

_CACHE: dict[str, tuple[dict, float]] = {}
_CACHE_MAX = 32
_CACHE_TTL = 6 * 3600.0          # 6 小时：上游对历史场次基本不再变，但别无限攒


def _cache_get(live_id: str) -> dict | None:
    hit = _CACHE.get(live_id)
    if not hit:
        return None
    payload, at = hit
    if time.monotonic() - at > _CACHE_TTL:
        _CACHE.pop(live_id, None)
        return None
    return payload


def _cache_put(live_id: str, payload: dict) -> None:
    if len(_CACHE) >= _CACHE_MAX:
        # 插入顺序淘汰（dict 保序），一次只清一个，避免抖动
        _CACHE.pop(next(iter(_CACHE)), None)
    _CACHE[live_id] = (payload, time.monotonic())


def clear_cache() -> None:
    """清空缓存（测试与排查用）。"""
    _CACHE.clear()


async def build_word_cloud(live_id: str, engine: str | None = None,
                           extra_words: Iterable[str] | None = None) -> dict:
    """按需自建词云。

    `extra_words`（2026-09-13 接线，扩展点 2）：调用方注入的自定义词典条目
    （V 名 / 企划名 / 账号昵称，见 `danmaku_words.build_extra_words`）——
    主播名被 jieba 切碎就等于词云里丢了最重要的那个词。

    返回 dict（**永不抛错**，失败也返回结构完整的结果，字段含义见
    `LiveDanmakuInfo.wc_status`）：

    ```python
    {"status": "ok"|"no_danmaku"|"fetch_failed",
     "words": [(word, count), …],   # 最多 40 条
     "text_count": int,             # 参与统计的文本弹幕数
     "total": int | None,           # 原始记录总条数（含礼物/进场等）
     "engine": str}
    ```
    """
    words = []
    if extra_words:
        # 只做一次去重排序：缓存键要稳定（同一场次同一批词 → 命中同一个缓存）
        words = sorted({w for w in extra_words if w})
    cache_key = f"{live_id}|{'/'.join(words)}" if words else live_id
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    records = await fetch_raw_danmakus(live_id)
    if records is None:
        # 拉取失败：**不要**缓存失败结果（用户重试应当真的重试）
        return {"status": "fetch_failed", "words": [], "text_count": 0,
                "total": None, "engine": engine or "jieba"}

    texts = list(iter_texts_from_records(records))
    top = count_tokens(texts, engine=engine, extra_words=words) if texts else []
    result = {
        "status": "ok" if top else "no_danmaku",
        "words": top,
        "text_count": len(texts),
        "total": len(records),
        "engine": (engine or "jieba"),
    }
    if top:
        _cache_put(cache_key, result)
    return result
