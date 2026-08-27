"""平台抓取器框架（爬虫框架）。

新平台接入（如抖音/小红书）：
1. 继承 BasePlatform，实现 fetch_user_info / fetch_post_page（enrich 可选）；
2. 在 registry.py 注册 platform 名 → 实例；
3. scheduler 自动获得：账号信息抓取、全量/增量帖子抓取、风控退避、完成报告。
"""
from __future__ import annotations

import httpx


class BasePlatform:
    platform: str = ""

    async def fetch_user_info(self, uid: str, client: httpx.AsyncClient | None = None) -> dict | None:
        """用户信息 → {name, sign, avatar, followers_count, url, ...平台附加字段}；失败 None。

        风控由 was_rate_limited() 判定（调用方统一冷却退避）。
        """
        raise NotImplementedError

    async def fetch_post_page(self, uid: str, page: int, client: httpx.AsyncClient | None = None) -> dict | None:
        """一页帖子流（时间倒序）→ {"items": [...], "has_more": bool}；失败 None。

        item 统一结构：
        {platform, platform_uid, platform_post_id, type(text/image/video/repost/article),
         title, summary, cover_url, permalink, body_json, stats_json,
         published_at(naive UTC), raw_json}
        """
        raise NotImplementedError

    async def enrich(self, item: dict, client: httpx.AsyncClient | None = None) -> bool:
        """详情补全（就地修改 item，如长文全文/视频详情）。
        返回是否发起过网络请求（调用方据此节流）。默认无操作。"""
        return False
