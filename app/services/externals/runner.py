"""外部数据采集执行器（P4）。

scheduler.start_scheduler 以 CronTrigger 挂接入口（每日/每周），本模块只负责
统筹：逐源逐任务 → 独立容器/错误隔离 → 汇总结果。
任务级幂等由各源自身保证（去重集合）。
"""
import logging

import httpx

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.http import new_async_client
from app.services.externals.base import INTERVAL_DAILY, INTERVAL_WEEKLY  # noqa: F401
from app.services.externals.registry import iter_external_sources

logger = logging.getLogger(__name__)

_USER_AGENT = "DDtoolkit-archive/0.5.2 (+personal evidence archive; low-frequency pull)"


def _source_enabled(source) -> bool:
    """三层开关：全系统 EXTERNAL_ENABLED → 按源 EXTERNAL_{NAME}_ENABLED → 类内 enabled。"""
    return (
        settings.EXTERNAL_ENABLED
        and source.enabled
        and getattr(settings, f"EXTERNAL_{source.name.upper()}_ENABLED", True)
    )


async def run_external_interval(interval: str,
                                account_ids: list[int] | None = None) -> list[dict]:
    """执行指定周期（daily/weekly）的全部外部任务，返回每任务摘要。

    account_ids：可选账号白名单（收录新 V 时只回填该账号，避免为一条新记录
    全量扫一遍第三方站点）；None = 全部账号（定时任务口径）。
    """
    results: list[dict] = []
    headers = {"User-Agent": _USER_AGENT}
    async with new_async_client(25.0, headers=headers) as client:
        for source in iter_external_sources():
            if not _source_enabled(source):
                continue
            for job in [j for j in source.jobs if j.interval == interval]:
                db = SessionLocal()
                try:
                    summ = await source.run_job(job.kind, db, client, account_ids)
                    results.append({
                        "source": source.name, "kind": job.kind, "label": job.label,
                        "stored": summ.stored, "skipped": summ.skipped,
                        "error": summ.error,
                    })
                    if summ.error:
                        logger.warning(f"外部任务 {source.name}/{job.kind} 未完成: {summ.error}")
                    else:
                        logger.info(f"外部任务 {source.name}/{job.kind} 完成: "
                                    f"新增 {summ.stored}，跳过 {summ.skipped}")
                except Exception as e:
                    db.rollback()
                    logger.error(f"外部任务 {source.name}/{job.kind} 失败: {e}", exc_info=True)
                    results.append({"source": source.name, "kind": job.kind,
                                    "error": str(e), "stored": 0, "skipped": 0})
                finally:
                    db.close()
    return results
