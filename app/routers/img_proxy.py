"""图片代理端点 /img-proxy

用途：混合方案中的兜底链路 —— 前端图片直连 CDN 失败（防盗链/协议/失效）时，
自动重试经本端点转发（服务器侧请求不带浏览器 Referer，可自由设置请求头）。

安全与性能：
- 仅允许 http/https，且主机需匹配 IMG_PROXY_ALLOWED_HOSTS（默认 hdslb.com 后缀）
- 磁盘缓存（static/img-cache/{md5}.bin + .json），命中直接返回，CDN 只拉一次
- 响应带 Cache-Control，浏览器侧再缓存 7 天
"""
import hashlib
import json as _json
import logging
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

CACHE_DIR = Path(settings.IMG_CACHE_DIR)
if not CACHE_DIR.is_absolute():
    CACHE_DIR = settings.DATA_DIR / CACHE_DIR
_ALLOWED_HOSTS = tuple(
    s.strip().lower() for s in settings.IMG_PROXY_ALLOWED_HOSTS.split(",") if s.strip()
)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"
)


async def fetch_remote(url: str) -> tuple[bytes, str] | None:
    """拉取远端图片，返回 (bytes, content-type)；失败返回 None（可注入测试）"""
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": _UA})
            if resp.status_code == 200 and resp.content:
                ctype = resp.headers.get("content-type", "application/octet-stream")
                return resp.content, ctype
    except Exception as e:
        logger.warning(f"图片代理拉取失败: {e}, url={url[:120]}")
    return None


def _validate_url(url: str) -> str:
    if not url or len(url) > 2048:
        raise HTTPException(400, "url 参数缺失或过长")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(400, "仅支持 http/https URL")
    host = parsed.netloc.split(":")[0].lower()
    if not any(host == s or host.endswith("." + s) for s in _ALLOWED_HOSTS):
        raise HTTPException(403, f"不允许代理该主机: {host}")
    return url


@router.get("/img-proxy")
async def img_proxy(url: str = Query(...)):
    url = _validate_url(url)

    # 1. 磁盘缓存命中
    key = hashlib.md5(url.encode("utf-8")).hexdigest()
    body_path = CACHE_DIR / f"{key}.bin"
    meta_path = CACHE_DIR / f"{key}.json"
    if body_path.exists() and meta_path.exists():
        try:
            meta = _json.loads(meta_path.read_text(encoding="utf-8"))
            return Response(
                content=body_path.read_bytes(),
                media_type=meta.get("type", "application/octet-stream"),
                headers={"Cache-Control": "public, max-age=604800"},
            )
        except Exception as e:
            logger.warning(f"图片缓存读取失败，回源拉取: {e}")

    # 2. 回源拉取并落缓存
    fetched = await fetch_remote(url)
    if fetched is None:
        raise HTTPException(502, "图片拉取失败")
    body, ctype = fetched
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        body_path.write_bytes(body)
        meta_path.write_text(_json.dumps({"type": ctype}), encoding="utf-8")
    except Exception as e:
        logger.warning(f"图片缓存写入失败（不影响本次响应）: {e}")

    return Response(
        content=body,
        media_type=ctype,
        headers={"Cache-Control": "public, max-age=604800"},
    )
