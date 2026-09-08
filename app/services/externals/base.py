"""外部数据源抽象（P4）。

ExternalSource 契约：
- name    来源标识（注册键）
- jobs    声明支持的任务清单（kind + 周期 + 说明），供调度器发现
- run_job 执行单个任务：拉取 → 归一化 → 幂等落库，返回本批摘要

幂等纪律：重复执行不产生重复行（按 (account_id, source, 时间/日期) 去重）。
所有外部请求低频（每日/每周），不做并发批量放大，节制访问第三方站点。
"""
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import httpx
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# 调度周期标识（runner 按此过滤任务）
INTERVAL_DAILY = "daily"
INTERVAL_WEEKLY = "weekly"


@dataclass
class ExternalJob:
    """一个可调度任务：kind 与周期由 run_job 的 job_id 参数匹配。"""
    source: str
    kind: str
    label: str
    interval: str = INTERVAL_DAILY


@dataclass
class ExternalJobSummary:
    source: str
    kind: str
    stored: int = 0
    skipped: int = 0
    error: str | None = None


class ExternalSource(ABC):
    name: str = ""
    enabled: bool = True
    jobs: list[ExternalJob] = field(default_factory=list)

    @abstractmethod
    async def run_job(self, kind: str, db: Session,
                      client: httpx.AsyncClient,
                      account_ids: list[int] | None = None) -> ExternalJobSummary:
        """执行任务。抛出异常由 runner 捕获（记日志、继续其他源）。

        account_ids：可选账号白名单（收录新 V 时只回填该账号，避免全量拉取
        第三方站点）；None = 全部账号（定时任务口径）。
        """
        raise NotImplementedError
