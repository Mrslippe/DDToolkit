"""danmakus.com（弹幕库）适配器 — P4。

已实测（ukamnads.icu / v2 spec）：
- GET /api/v2/vup-list 公开免鉴权 ✅：VTuber 索引（透传 laplace vup-slim.json）
  {code, data: {mid: {name, type, room, group_name}}} — 企划/公会数据即此而来
- GET /api/v2/channel?uId=&includeLive=true 公开免鉴权 ✅（v0.9.x M1 实测）：
  单场次全量列表 {channel, lives: [APILiveInfo], fansHistory} —
  title/startDate/stopDate/parentArea/area/totalIncome/maxOnlineCount/
  danmakusCount，2021-10 起（七海 1193 场实测）；liveId(uuid) 为场次唯一键
- GET /api/v2/account/channel-lives 401/需登录 🔒：账号贡献维度（token 配置位
  DANMAKUS_TOKEN 保留，M1 端点已实测免登录，暂不需要）；弹幕 v3 端点同属
  鉴权列（backlog 暂缓）

落库：
- vup-list → thirdparty_vtubers（source='danmakus_vup'），整表刷新（周级）
- channel lives → live_sessions（source='danmakus'，LiveSessionRepo.upsert_danmakus，
  幂等 by (account_id, live_id)）
"""
import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.models.vtuber import Account, ThirdpartyVtuber
from app.repositories.vtuber_repo import LiveSessionRepo
from app.services.externals.base import (ExternalJob, ExternalJobSummary,
                                         ExternalSource, INTERVAL_DAILY,
                                         INTERVAL_WEEKLY)

logger = logging.getLogger(__name__)

DANMAKUS_BASE = "https://ukamnads.icu"
VUP_LIST_PATH = "/api/v2/vup-list"
CHANNEL_PATH = "/api/v2/channel"

# 鉴权端点（当前未启用）：有 token 时在请求头携带（Token: <token>，实测有效）
DANMAKUS_TOKEN_ENV = "DANMAKUS_TOKEN"

# WAF 过滤（实测 2026-09-07）：缺 Origin/Referer 或非浏览器 UA 会被直接 RST
BROWSER_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": "https://ukamnads.icu",
    "Referer": "https://ukamnads.icu/",
}


async def fetch_channel(mid: str, client: httpx.AsyncClient) -> dict | None:
    """公开端点：单主播全量场次（channel + lives + fansHistory）。

    返回原始 data dict（{channel, lives, fansHistory}）或 None；
    调用方经 LiveSessionRepo.upsert_danmakus 落库。
    """
    resp = await client.get(
        f"{DANMAKUS_BASE}{CHANNEL_PATH}",
        params={"uId": mid, "includeLive": "true"},
        headers=BROWSER_HEADERS,
    )
    if resp.status_code != 200:
        logger.warning(f"danmakus channel 失败 HTTP {resp.status_code} mid={mid}")
        return None
    data = resp.json()
    if not isinstance(data, dict) or data.get("code") != 200:
        logger.warning(f"danmakus channel 响应异常 mid={mid}: "
                       f"code={data.get('code') if isinstance(data, dict) else '?'}")
        return None
    payload = data.get("data")
    return payload if isinstance(payload, dict) else None


def _auth_headers(token: str | None) -> dict:
    return {"Token": token} if token else {}


class DanmakusSource(ExternalSource):
    name = "danmakus"
    enabled = True
    jobs = [
        ExternalJob("danmakus", "vtuber_index", "VTuber 索引整表刷新（企划/公会）",
                    INTERVAL_WEEKLY),
        ExternalJob("danmakus", "live_sessions", "直播场次同步（标题/起止/分区/收益）",
                    INTERVAL_DAILY),
    ]

    async def run_job(self, kind: str, db: Session,
                      client: httpx.AsyncClient) -> ExternalJobSummary:
        if kind == "vtuber_index":
            return await self._sync_vtuber_index(db, client)
        if kind == "live_sessions":
            return await self._sync_live_sessions(db, client)
        return ExternalJobSummary(self.name, kind, error=f"未知任务: {kind}")

    def _bili_accounts(self, db: Session) -> list[Account]:
        return (
            db.query(Account)
            .filter(Account.platform == "bilibili",
                    Account.platform_uid != None,  # noqa: E711
                    Account.platform_uid != "")
            .all()
        )

    async def _sync_live_sessions(self, db: Session,
                                  client: httpx.AsyncClient) -> ExternalJobSummary:
        """直播场次每日同步（v0.9.x M2）：公开端点全量拉取 → 幂等 upsert。

        场次含标题/起止/分区/收益/峰值在线/弹幕数；直播中场次 stopDate=0，
        end_at 由 merged() 用 self 快照补齐（当日即准确）。
        """
        summary = ExternalJobSummary(self.name, "live_sessions")
        accounts = self._bili_accounts(db)
        for acc in accounts:
            try:
                payload = await fetch_channel(str(acc.platform_uid), client)
            except Exception as e:
                # 账号级隔离：网络异常只影响本账号，其余账号继续
                logger.warning(f"danmakus lives 账号异常 {acc.platform_uid}: {e}")
                summary.skipped += 1
                continue
            if not payload:
                summary.skipped += 1
                continue
            lives = payload.get("lives") or []
            res = LiveSessionRepo(db).upsert_danmakus(acc.id, lives)
            summary.stored += res["added"]
            logger.info(f"danmakus live_sessions: {acc.platform_uid} "
                        f"新增 {res['added']} 刷新 {res['updated']}")
        return summary

    async def _sync_vtuber_index(self, db: Session,
                                 client: httpx.AsyncClient) -> ExternalJobSummary:
        summary = ExternalJobSummary(self.name, "vtuber_index")
        resp = await client.get(f"{DANMAKUS_BASE}{VUP_LIST_PATH}")
        if resp.status_code != 200:
            summary.error = f"HTTP {resp.status_code}"
            logger.warning(f"danmakus vup-list 失败 HTTP {resp.status_code}")
            return summary
        data = resp.json()
        if not isinstance(data, dict) or not isinstance(data.get("data"), dict):
            summary.error = "响应结构异常"
            return summary
        mapping = data["data"]

        # 整表刷新：同一 source 先清后插（周级低频；单事务原子提交）
        db.query(ThirdpartyVtuber).filter(
            ThirdpartyVtuber.source == self.name).delete(synchronize_session=False)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        for mid, info in mapping.items():
            if not isinstance(info, dict):
                continue
            db.add(ThirdpartyVtuber(
                platform="bilibili",
                platform_uid=str(mid),
                name=str(info.get("name") or ""),
                type=info.get("type"),
                room_id=str(info.get("room") or "") or None,
                group_name=info.get("group_name") or None,
                source=self.name,
                updated_at=now,
            ))
        db.commit()
        summary.stored = len(mapping)
        logger.info(f"danmakus vtuber_index: 整表刷新 {len(mapping)} 条")
        return summary
