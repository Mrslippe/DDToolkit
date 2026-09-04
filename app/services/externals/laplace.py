"""laplace.live 适配器空壳（P4）。

laplace.live 无公开 API（用户定案）；其数据（vup-slim.json）实际经由
danmakus /api/v2/vup-list 透传获取（见 danmakus.py），无需本源直连。
保留注册位：未来官方 API 就绪后在此实现 run_job。
"""
import httpx
from sqlalchemy.orm import Session

from app.services.externals.base import ExternalJobSummary, ExternalSource


class LaplaceSource(ExternalSource):
    name = "laplace"
    enabled = False  # 无 API，默认禁用
    jobs = []

    async def run_job(self, kind: str, db: Session,
                      client: httpx.AsyncClient) -> ExternalJobSummary:
        return ExternalJobSummary(self.name, kind, error="laplace 暂无可用 API")
