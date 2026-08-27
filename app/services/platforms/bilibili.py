"""B 站平台适配：包装 app.services.fetcher 既有实现。

说明：B 站帖子抓取有专属双流循环（视频投稿 + 动态，含归档边界/视频总数比对等
专用逻辑），由 scheduler._fetch_posts_core 直接处理，不走通用单流循环；
本适配器提供账号信息抓取（协议完整性见 base.py）。
"""
from __future__ import annotations

import httpx

from app.services.fetcher import (
    fetch_bilibili_user_info, fetch_bilibili_user_stat, was_rate_limited,
)
from app.services.platforms.base import BasePlatform


class BilibiliPlatform(BasePlatform):
    platform = "bilibili"

    async def fetch_user_info(self, uid: str, client: httpx.AsyncClient | None = None) -> dict | None:
        info = await fetch_bilibili_user_info(int(uid), client=client)
        merged = dict(info or {})
        if not was_rate_limited():
            stat = await fetch_bilibili_user_stat(int(uid), client=client)
            if stat:
                merged["followers_count"] = stat.get("follower", merged.get("followers_count", 0))
        if not merged:
            return None
        merged.setdefault("followers_count", 0)
        return merged


fetcher = BilibiliPlatform()
