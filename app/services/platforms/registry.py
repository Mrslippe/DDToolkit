"""平台注册表：platform 名 → BasePlatform 实现。"""
from __future__ import annotations

from app.services.platforms import base, bilibili, weibo, xiaohongshu

_REGISTRY: dict[str, base.BasePlatform] = {
    "bilibili": bilibili.fetcher,
    "weibo": weibo.fetcher,
    # 第 4 阶段 ④ 第一刀（devlog/230）：小红书。⚠️ 它是**可选依赖**驱动的
    # （签名要 `xhshow`，见 `signing.py`）；没装/没配 cookie 时抓取会返回
    # **结构化失败**（`last_error`），不是静默空结果。
    "xiaohongshu": xiaohongshu.fetcher,
}


def get_fetcher(platform: str) -> base.BasePlatform | None:
    return _REGISTRY.get((platform or "").strip().lower())


def supported_platforms() -> list[str]:
    return list(_REGISTRY.keys())
