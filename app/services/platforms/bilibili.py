"""B 站平台适配：包装 app.services.fetcher 既有实现。

说明：B 站帖子抓取有专属双流循环（视频投稿 + 动态，含归档边界/视频总数比对等
专用逻辑），由 `scheduler._fetch_posts_core` 直接处理，不走通用单流循环；
**平台细节的接线口是 `app/services/platforms/streams.py` 的 `PostStreams`**
（2026-09-27，devlog/229：核心循环已平台无关，B 站那套实现由 `scheduler.BILIBILI_STREAMS`
绑上去）；**B 站专属的帖子实现**（投稿动态合并 / 直播卡路由 / 详情补全 / 置顶刷新）
住在 `app/services/platforms/bilibili_posts.py`（第二刀，devlog/236）；
本适配器提供账号信息抓取（协议完整性见 base.py）。
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from app.services.fetcher import (
    fetch_bilibili_live_batch, fetch_bilibili_user_info, fetch_bilibili_user_stat,
)
from app.services.platforms.base import BasePlatform
from app.services.platforms.bilibili_posts import admit_endpoint, observe_endpoint

logger = logging.getLogger(__name__)


class BilibiliPlatform(BasePlatform):
    platform = "bilibili"
    supports_live_batch = True      # T0 每分钟一次的批量直播状态

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

    async def fetch_live_batch(self, uids: list[str],
                               client: httpx.AsyncClient | None = None) -> dict[str, dict] | None:
        """批量直播状态（第 4 阶段 ⑧，devlog/240：从 `scheduler.py` 搬进来）。

        两件 B 站专属的知识**住在适配器里**（以前它们写在调度核心里）：
        ① 批量接口要 **int uid** —— 非数字 uid 在这儿被挡下并**记日志说明原因**
           （调用方仍会把它们计进 `failed`，所以不是"静默丢弃"）；
        ② **端点记账**（`live_batch` 的熔断检查与结果上报）也归适配器，与小红书同一分层。
        """
        if not admit_endpoint("live_batch"):
            return None                      # 熔断：一个字节都不发
        numeric = [str(u) for u in uids if str(u).strip().isdigit()]
        bad = [str(u) for u in uids if not str(u).strip().isdigit()]
        if bad:
            logger.warning(f"T0 直播状态：跳过 {len(bad)} 个非数字 uid 的 bilibili 账号"
                           f"（批量接口要 int uid）：{bad[:3]}")
        if not numeric:
            return {}
        data = await fetch_bilibili_live_batch([int(u) for u in numeric], client=client)
        observe_endpoint("live_batch", "batch", data is not None)
        return data


fetcher = BilibiliPlatform()
