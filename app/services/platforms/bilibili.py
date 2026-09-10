"""B 站平台适配：包装 app.services.fetcher 既有实现。

说明：B 站帖子抓取有专属双流循环（视频投稿 + 动态，含归档边界/视频总数比对等
专用逻辑），由 scheduler._fetch_posts_core 直接处理，不走通用单流循环；
本适配器提供账号信息抓取（协议完整性见 base.py）。
"""
from __future__ import annotations

import asyncio

import httpx

from app.services.fetcher import (
    fetch_bilibili_user_info, fetch_bilibili_user_stat,
)
from app.services.platforms.base import BasePlatform


class BilibiliPlatform(BasePlatform):
    platform = "bilibili"

    async def fetch_user_info(self, uid: str, client: httpx.AsyncClient | None = None) -> dict | None:
        """账号资料 + 粉丝数：两个接口**并行**发出（v0.9.4 收录提速）。

        原实现串行（acc/info → relation/stat），单账号多付一个往返；两者互不依赖
        （acc/info 走 WBI 签名，relation/stat 不需签名），并行后单账号省 0.3~1s。
        风控判定不变：任一请求置位都会由上层读取 `was_rate_limited()` 并冷却。
        """
        mid = int(uid)
        info, stat = await asyncio.gather(
            fetch_bilibili_user_info(mid, client=client),
            fetch_bilibili_user_stat(mid, client=client),
        )
        merged = dict(info or {})
        if stat:
            merged["followers_count"] = stat.get("follower", merged.get("followers_count", 0))
        if not merged:
            return None
        merged.setdefault("followers_count", 0)
        return merged


fetcher = BilibiliPlatform()
