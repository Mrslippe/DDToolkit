"""平台注册表：platform 名 → BasePlatform 实现。"""
from __future__ import annotations

from app.services.platforms import base, bilibili, weibo

_REGISTRY: dict[str, base.BasePlatform] = {
    "bilibili": bilibili.fetcher,
    "weibo": weibo.fetcher,
}


def get_fetcher(platform: str) -> base.BasePlatform | None:
    return _REGISTRY.get((platform or "").strip().lower())


def supported_platforms() -> list[str]:
    return list(_REGISTRY.keys())
