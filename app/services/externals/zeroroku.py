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
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.vtuber import Account, AccountStatSnapshot, LiveGiftDay
from app.repositories.vtuber_repo import AppMetaRepo
from app.services.externals.base import (ExternalJob, ExternalJobSummary,
                                         ExternalSource, FailureBudget, INTERVAL_DAILY)

logger = logging.getLogger(__name__)

ZEROROKU_BASE = "https://zeroroku.com/api/bilibili"

# R44（devlog/165）：`gift_days`（直播礼物日聚合）的**专用短超时**。
# 它响应很小，而 runner 建的客户端默认 25s —— 2026-09-23 实测 7 个账号全 ReadTimeout、
# 每个 25~29 秒 ⇒ 外部补抓的 3 分钟全花在等超时上。8 秒对这个小接口足够。
# ⚠️ 只有这一个接口调小：`fan_history` 合法就要 5~15 秒（一次返回全量），不能一起调。
GIFT_DAYS_TIMEOUT = 8.0


def fan_history_marker_key(account_id: int) -> str:
    """账号级"上次成功抓取粉丝历史"的标记键（R43-B，devlog/163）。

    ⚠️ 为什么不用 `AccountStatSnapshot.captured_at` 的最大值当"上次抓取时间"：
    那是**数据点自己的日期**（可能是 2019 年），上游停更时会永远"看起来刚抓过" ✗。
    这里显式记一次运行时间（存 `app_meta`，与 `external.startup.last_run` 同一套做法）。
    """
    return f"external.zeroroku.fan_history.last.{account_id}"


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


async def fetch_gift_days(mid: str, client: httpx.AsyncClient,
                          timeout: float | None = GIFT_DAYS_TIMEOUT) -> dict | None:
    # R44（devlog/165）：**这个接口带自己的短超时**。它响应很小（几十 KB 量级），
    # 而客户端默认是 25s —— 2026-09-23 实测 7 个账号全 ReadTimeout、每个 25~29s
    # ⇒ 3 分钟全在等超时。`fan_history` 不许跟着调小：那个合法就要 5~15 秒（一次返回全量）。
    resp = await client.get(f"{ZEROROKU_BASE}/author/{mid}/live-paid-aggregations",
                            timeout=timeout)
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
                      client: httpx.AsyncClient,
                      account_ids: list[int] | None = None) -> ExternalJobSummary:
        if kind == "fan_history":
            return await self._sync_fan_history(db, client, account_ids)
        if kind == "gift_days":
            return await self._sync_gift_days(db, client, account_ids)
        return ExternalJobSummary(self.name, kind, error=f"未知任务: {kind}")

    def _bili_accounts(self, db: Session,
                       account_ids: list[int] | None = None) -> list[Account]:
        q = db.query(Account).filter(
            Account.platform == "bilibili",
            Account.platform_uid != None,  # noqa: E711
            Account.platform_uid != "",
        )
        if account_ids:
            q = q.filter(Account.id.in_(account_ids))
        return q.all()

    async def _sync_fan_history(self, db: Session,
                                client: httpx.AsyncClient,
                                account_ids: list[int] | None = None) -> ExternalJobSummary:
        summary = ExternalJobSummary(self.name, "fan_history")
        accounts = self._bili_accounts(db, account_ids)
        # R43-B（devlog/163）：**账号级新鲜度跳过** —— 这个接口一次返回全量
        # （实测 197KB / 5~15s，单账号一次上千条），而历史数据本来就变得慢
        # ⇒ 窗口内抓过的账号**一个请求都不发**。窗口见 `EXTERNAL_FAN_HISTORY_STALE_HOURS`。
        meta = AppMetaRepo(db)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        cutoff = now - timedelta(hours=settings.EXTERNAL_FAN_HISTORY_STALE_HOURS)
        # R44：连续失败预算 —— 这个接口一次返回全量（5~15s/次），端点挂了时逐个等满太贵
        budget = FailureBudget()
        for acc in accounts:
            if not budget.ok():
                logger.warning(f"zeroroku fan_history: {budget.reason()}")
                summary.skipped += len(accounts) - accounts.index(acc)
                break
            last = meta.get_dt(fan_history_marker_key(acc.id))
            if last is not None and last > cutoff:
                summary.skipped += 1
                logger.info(f"zeroroku fan_history: {acc.platform_uid} 跳过"
                            f"（{last} 抓过，窗口 {settings.EXTERNAL_FAN_HISTORY_STALE_HOURS}h）")
                continue
            try:
                items = await fetch_fan_history(str(acc.platform_uid), client)
                budget.record(items is not None)
            except Exception as e:
                # 账号级隔离：网络异常只影响本账号，其余账号继续
                # （带上异常类型：TimeoutException 的 str 为空，只打 {e} 看不出原因）
                logger.warning(f"zeroroku history 账号异常 {acc.platform_uid}: "
                               f"{type(e).__name__}: {e}")
                summary.skipped += 1
                # ⚠️ 失败**不打时间戳** —— 否则一次网络抖动会让这个账号 7 天不再重试
                continue
            if not items:
                summary.skipped += 1
                continue
            # 成功才记时间（在写入之前打：写库失败也不该让它 7 天不再重试）
            meta.set_dt(fan_history_marker_key(acc.id))
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
                              client: httpx.AsyncClient,
                              account_ids: list[int] | None = None) -> ExternalJobSummary:
        summary = ExternalJobSummary(self.name, "gift_days")
        accounts = self._bili_accounts(db, account_ids)
        # R44：连续失败预算 —— 端点整体挂掉时不该逐个账号等满超时（见 `FailureBudget`）
        budget = FailureBudget()
        for acc in accounts:
            if not budget.ok():
                logger.warning(f"zeroroku gift_days: {budget.reason()}")
                summary.skipped += len(accounts) - accounts.index(acc)
                break
            try:
                payload = await fetch_gift_days(str(acc.platform_uid), client)
                budget.record(payload is not None)
            except Exception as e:
                logger.warning(f"zeroroku gifts 账号异常 {acc.platform_uid}: "
                               f"{type(e).__name__}: {e}")
                summary.skipped += 1
                budget.record(False)
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
