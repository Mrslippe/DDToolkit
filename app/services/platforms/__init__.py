"""平台抓取器框架（爬虫框架）。"""
from app.services.platforms.registry import get_fetcher, supported_platforms

__all__ = ["get_fetcher", "supported_platforms"]
