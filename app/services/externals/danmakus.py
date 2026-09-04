"""danmakus.com（弹幕库）适配器 — P4。

已实测（ukamnads.icu / v2 spec）：
- GET /api/v2/vup-list 公开免鉴权 ✅：VTuber 索引（透传 laplace vup-slim.json）
  {code, data: {mid: {name, type, room, group_name}}} — 企划/公会数据即此而来
- GET /api/v2/account/channel-lives 401 需登录 🔒：直播场次列表，
  有登录 token 后可启用（DANMAKUS_TOKEN）；弹幕 v3 端点同属鉴权列（backlog 暂缓）

落库：thirdparty_vtubers（source='danmakus_vup'），整表刷新（周级）。
"""
import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.models.vtuber import ThirdpartyVtuber
from app.services.externals.base import (ExternalJob, ExternalJobSummary,
                                         ExternalSource, INTERVAL_WEEKLY)

logger = logging.getLogger(__name__)

DANMAKUS_BASE = "https://ukamnads.icu"
VUP_LIST_PATH = "/api/v2/vup-list"

# 鉴权端点（本周不启用）：有 token 时在请求头携带
DANMAKUS_TOKEN_ENV = "DANMAKUS_TOKEN"


def _auth_headers(token: str | None) -> dict:
    return {"Authorization": f"Bearer {token}"} if token else {}


class DanmakusSource(ExternalSource):
    name = "danmakus"
    enabled = True
    jobs = [
        ExternalJob("danmakus", "vtuber_index", "VTuber 索引整表刷新（企划/公会）",
                    INTERVAL_WEEKLY),
    ]

    async def run_job(self, kind: str, db: Session,
                      client: httpx.AsyncClient) -> ExternalJobSummary:
        if kind == "vtuber_index":
            return await self._sync_vtuber_index(db, client)
        return ExternalJobSummary(self.name, kind, error=f"未知任务: {kind}")

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
