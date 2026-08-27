"""图片代理端点 /img-proxy

用途：混合方案中的兜底链路 —— 前端图片直连 CDN 失败（防盗链/协议/失效）时，
自动重试经本端点转发（服务器侧请求不带浏览器 Referer，可自由设置请求头）。

安全与性能：
- 仅允许 http/https，且主机需匹配 IMG_PROXY_ALLOWED_HOSTS（默认 hdslb.com 后缀）
- 重定向逐跳重新校验主机（防 SSRF 跳转绕过），最多跟随 3 跳
- 限制响应大小（10MB）与 content-type（仅图片/octet-stream，防存储型 XSS）
- 磁盘缓存（static/img-cache/{md5}.bin + .json），原子写入、带 TTL 清理
- 模块级共享 AsyncClient 复用连接池
- 响应带 Cache-Control，浏览器侧再缓存 7 天
"""
from __future__ import annotations

import hashlib
import json as _json
import logging
import os
import time
from pathlib import Path
from urllib.parse import urlparse

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

_MAX_REDIRECTS = 3
_MAX_BODY = 10 * 1024 * 1024  # 10MB：防上游投喂超大响应撑爆磁盘
_ALLOWED_CTYPES = {
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
    "image/bmp", "image/x-icon", "application/octet-stream",
}
_CACHE_TTL = 7 * 24 * 3600      # 缓存有效期（与 Cache-Control 一致）
_CLEANUP_INTERVAL = 3600        # 过期文件清理的最短间隔

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"
)

# httpx 延迟加载（冷启动优化：本模块路由注册不触发 httpx 导入）
_httpx_mod = None


def _httpx():
    global _httpx_mod
    if _httpx_mod is None:
        import httpx
        _httpx_mod = httpx
    return _httpx_mod


# 模块级共享 client（连接池复用，避免每请求新建 TCP/TLS 连接）
_client: httpx.AsyncClient | None = None
_last_cleanup = 0.0


def _shared_client():
    global _client
    if _client is None or _client.is_closed:
        _client = _httpx().AsyncClient(timeout=15.0, follow_redirects=False)
    return _client


async def close_client() -> None:
    """应用关闭时释放共享连接池（main.py lifespan 调用）。"""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
        _client = None


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


def _host_of(url: str) -> str:
    return (urlparse(url).netloc.split(":")[0] or "").lower()


def _referer_for(host: str) -> str | None:
    """防盗链 Referer：微博图床（sinaimg/wbcdn）要求带合法来源才 200，否则 403
    （实测：无 Referer 或非微博域来源 → 403）；B 站图床（hdslb）无需但带上也无害。"""
    h = (host or "").lower()
    if h.endswith(".sinaimg.cn") or h.endswith(".wbcdn.cn"):
        return "https://weibo.com/"
    if h.endswith(".hdslb.com") or h == "hdslb.com":
        return "https://www.bilibili.com/"
    return None


async def fetch_remote(url: str, client: httpx.AsyncClient | None = None) -> tuple[bytes, str] | None:
    """拉取远端图片，返回 (bytes, content-type)；失败返回 None（可注入测试）。

    修复（SSRF）：原来 follow_redirects=True 只校验初始 URL，302 跳转到内网
    地址（如 127.0.0.1、169.254.169.254）会直接跟随。改为逐跳重新 _validate_url，
    任一跳不通过即拒绝；同时限制跳数、响应大小与 content-type。

    防盗链：按请求主机动态带 Referer（sinaimg/wbcdn → weibo.com，hdslb → bilibili），
    否则微博图床返回 403（修复：此前不带 Referer，全部 403，图片代理形同虚设）。
    """
    if client is None:
        client = _shared_client()
    current = url
    for _ in range(_MAX_REDIRECTS + 1):
        _validate_url(current)
        try:
            # 防盗链 Referer 按当前主机动态附带（含重定向跳转后的新主机）
            ref = _referer_for(_host_of(current))
            headers = {"User-Agent": _UA}
            if ref:
                headers["Referer"] = ref
            resp = await client.get(current, headers=headers)
        except Exception as e:
            logger.warning(f"图片代理拉取失败: {e}, url={current[:120]}")
            return None
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("location")
            if not location:
                logger.warning(f"图片代理重定向无 location，url={url[:120]}")
                return None
            current = str(_httpx().URL(resp.url).join(location))
            continue
        if resp.status_code != 200 or not resp.content:
            logger.warning(f"图片代理响应异常 status={resp.status_code}, url={url[:120]}")
            return None
        if len(resp.content) > _MAX_BODY:
            logger.warning(f"图片代理响应过大，拒绝: {len(resp.content)} bytes, url={url[:120]}")
            return None
        ctype = resp.headers.get("content-type", "application/octet-stream").split(";")[0].strip().lower()
        if ctype not in _ALLOWED_CTYPES:
            # 拒绝 text/html 等非图片类型：防缓存命中后以本应用源回吐恶意 HTML（存储型 XSS）
            logger.warning(f"图片代理拒绝非图片 content-type: {ctype!r}, url={url[:120]}")
            return None
        return resp.content, ctype
    logger.warning(f"图片代理重定向超过 {_MAX_REDIRECTS} 跳，拒绝: url={url[:120]}")
    return None


def _atomic_write(path: Path, data: bytes | str) -> None:
    """临时文件 + os.replace 原子落盘，避免进程中断留下半写文件。"""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    if isinstance(data, str):
        tmp.write_text(data, encoding="utf-8")
    else:
        tmp.write_bytes(data)
    os.replace(tmp, path)


def _maybe_cleanup_cache() -> None:
    """过期缓存文件清理（按 _CLEANUP_INTERVAL 节流，避免每次请求都扫描）。"""
    global _last_cleanup
    now = time.time()
    if now - _last_cleanup < _CLEANUP_INTERVAL:
        return
    _last_cleanup = now
    try:
        if not CACHE_DIR.exists():
            return
        for p in CACHE_DIR.glob("*.bin"):
            try:
                if now - p.stat().st_mtime > _CACHE_TTL * 2:
                    p.unlink(missing_ok=True)
                    p.with_suffix(".json").unlink(missing_ok=True)
            except OSError:
                pass
    except OSError:
        pass


@router.get("/img-proxy")
async def img_proxy(url: str = Query(...)):
    url = _validate_url(url)

    # 1. 磁盘缓存命中（带 TTL；破损缓存回源重拉）
    key = hashlib.md5(url.encode("utf-8")).hexdigest()
    body_path = CACHE_DIR / f"{key}.bin"
    meta_path = CACHE_DIR / f"{key}.json"
    if body_path.exists() and meta_path.exists():
        try:
            meta = _json.loads(meta_path.read_text(encoding="utf-8"))
            if time.time() - meta.get("fetched_at", 0) <= _CACHE_TTL:
                return Response(
                    content=body_path.read_bytes(),
                    media_type=meta.get("type", "application/octet-stream"),
                    headers={"Cache-Control": "public, max-age=604800"},
                )
        except Exception as e:
            logger.warning(f"图片缓存读取失败，回源拉取: {e}")

    # 2. 回源拉取并落缓存（原子写入）
    _maybe_cleanup_cache()
    fetched = await fetch_remote(url)
    if fetched is None:
        raise HTTPException(502, "图片拉取失败")
    body, ctype = fetched
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _atomic_write(body_path, body)
        _atomic_write(meta_path, _json.dumps({"type": ctype, "fetched_at": time.time()}))
    except Exception as e:
        logger.warning(f"图片缓存写入失败（不影响本次响应）: {e}")

    return Response(
        content=body,
        media_type=ctype,
        headers={"Cache-Control": "public, max-age=604800"},
    )