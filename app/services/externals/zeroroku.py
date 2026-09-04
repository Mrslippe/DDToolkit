"""zeroroku.com（06 数据观测站）适配器 — P4 实测公开免鉴权。

端点（官方仓库 server/api/bilibili 同名路径，线上 zeroroku.com 直接可用）：
- /api/bilibili/author/{mid}/history
    → 粉丝历史 [{id, mid, fans, createdAt, rate1, rate7}]，2023 至今全量
- /api/bilibili/author/{mid}/live-paid-aggregations
    → 直播礼物日聚合 {roomId, columns, items:[{bucket_start, gift_amount,
      guard_amount, sc_amount, total_amount}]}（日粒度，非单场起止）

落库：
- fan_history → account_stat_snapshots（source='zeroroku'，captured_at=该行时间）
- gift_days   → live_gift_days（金额以原始字符串保精度）
幂等：按 (account_id, source, 时间/日期) 与库中已有集合去重，重跑不重复。
"""
import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.models.vtuber import Account, AccountStatSnapshot, LiveGiftDay
from app.services.externals.base import (ExternalJob, ExternalJobSummary,
                                         ExternalSource, INTERVAL_DAILY)

logger = logging.getLogger(__name__)

ZEROROKU_BASE = "https://zeroroku.com/api/bilibili"


def parse_zeroroku_ts(raw: str) -> datetime | None:
    """'2026-09-04 14:28:37.73199+00'（UTC 偏移 +00）→ naive UTC datetime。

    库内时间约定（devlog/021）：所有时间列存 naive UTC。
    """
    try:
        dt = datetime.fromisoformat(raw)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


async def fetch_fan_history(mid: str, client: httpx.AsyncClient) -> list[dict] | None:
    resp = await client.get(f"{ZEROROKU_BASE}/author/{mid}/history")
    if resp.status_code != 200:
        logger.warning(f"zeroroku history 失败 HTTP {resp.status_code} mid={mid}")
        return None
    data = resp.json()
    items = data.get("items") if isinstance(data, dict) else None
    return items if isinstance(items, list) else None


async def fetch_gift_days(mid: str, client: httpx.AsyncClient) -> dict | None:
    resp = await client.get(f"{ZEROROKU_BASE}/author/{mid}/live-paid-aggregations")
    if resp.status_code != 200:
        logger.warning(f"zeroroku gifts 失败 HTTP {resp.status_code} mid={mid}")
        return None
    data = resp.json()
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return None
    return data


class ZerorokuSource(ExternalSource):
    name = "zeroroku"
    enabled = True
    jobs = [
        ExternalJob("zeroroku", "fan_history", "粉丝历史回填/增量", INTERVAL_DAILY),
        ExternalJob("zeroroku", "gift_days", "直播礼物日聚合", INTERVAL_DAILY),
    ]

    async def run_job(self, kind: str, db: Session,
                      client: httpx.AsyncClient) -> ExternalJobSummary:
        if kind == "fan_history":
            return await self._sync_fan_history(db, client)
        if kind == "gift_days":
            return await self._sync_gift_days(db, client)
        return ExternalJobSummary(self.name, kind, error=f"未知任务: {kind}")

    def _bili_accounts(self, db: Session) -> list[Account]:
        return (
            db.query(Account)
            .filter(Account.platform == "bilibili",
                    Account.platform_uid != None,  # noqa: E711
                    Account.platform_uid != "")
            .all()
        )

    async def _sync_fan_history(self, db: Session,
                                client: httpx.AsyncClient) -> ExternalJobSummary:
        summary = ExternalJobSummary(self.name, "fan_history")
        accounts = self._bili_accounts(db)
        for acc in accounts:
            try:
                items = await fetch_fan_history(str(acc.platform_uid), client)
            except Exception as e:
                # 账号级隔离：网络异常只影响本账号，其余账号继续
                logger.warning(f"zeroroku history 账号异常 {acc.platform_uid}: {e}")
                summary.skipped += 1
                continue
            if not items:
                summary.skipped += 1
                continue
            # 已有 (captured_at) 集合：按 source 去重（幂等）
            existing = {
                s.captured_at for s in db.query(AccountStatSnapshot.captured_at).filter(
                    AccountStatSnapshot.account_id == acc.id,
                    AccountStatSnapshot.source == self.name,
                ).all()
            }
            added = 0
            for it in items:
                cap = parse_zeroroku_ts(str(it.get("createdAt", "")))
                fans = it.get("fans")
                if cap is None or fans is None:
                    continue
                if cap in existing:
                    continue
                db.add(AccountStatSnapshot(
                    account_id=acc.id,
                    followers_count=int(fans),
                    captured_at=cap,
                    source=self.name,
                ))
                existing.add(cap)
                added += 1
            db.commit()
            summary.stored += added
            logger.info(f"zeroroku fan_history: {acc.platform_uid} 新增 {added} 行")
        return summary

    async def _sync_gift_days(self, db: Session,
                              client: httpx.AsyncClient) -> ExternalJobSummary:
        summary = ExternalJobSummary(self.name, "gift_days")
        accounts = self._bili_accounts(db)
        for acc in accounts:
            try:
                payload = await fetch_gift_days(str(acc.platform_uid), client)
            except Exception as e:
                logger.warning(f"zeroroku gifts 账号异常 {acc.platform_uid}: {e}")
                summary.skipped += 1
                continue
            if not payload:
                summary.skipped += 1
                continue
            existing = {
                g.gift_date for g in db.query(LiveGiftDay.gift_date).filter(
                    LiveGiftDay.account_id == acc.id,
                    LiveGiftDay.source == self.name,
                ).all()
            }
            added = 0
            for it in payload.get("items") or []:
                d = str(it.get("bucket_start") or "")
                if not d or d in existing:
                    continue
                db.add(LiveGiftDay(
                    account_id=acc.id,
                    source=self.name,
                    gift_date=d,
                    gift_amount=it.get("gift_amount"),
                    guard_amount=it.get("guard_amount"),
                    sc_amount=it.get("sc_amount"),
                    total_amount=it.get("total_amount"),
                    room_id=str(payload.get("roomId") or ""),
                ))
                existing.add(d)
                added += 1
            db.commit()
            summary.stored += added
            logger.info(f"zeroroku gift_days: {acc.platform_uid} 新增 {added} 行")
        return summary
