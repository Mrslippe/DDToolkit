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
from app.core.useragent import UA_EDGE

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
# 容量上限（R22，2026-09-16）：原来只管时间不管体积。解析规则与 `config.IMG_CACHE_MAX_MB` 一致，
# 但**放在模块级**是为了让测试能直接改小它（与 CACHE_DIR 一样的处理）。
_CACHE_MAX_BYTES = max(0, int(getattr(settings, "IMG_CACHE_MAX_MB", 300))) * 1024 * 1024

_UA = UA_EDGE       # R26③：UA 全仓单一来源（core/useragent；那边零依赖，不会把 httpx 拽进冷启动）

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


def _cache_entries() -> list[tuple[Path, float, int]]:
    """当前缓存条目：`(bin 路径, mtime, 字节数)`。

    mtime 就是"最后使用时间" —— 命中缓存时会刷新它（见 `img_proxy`），所以它能当 LRU 判据。
    """
    out: list[tuple[Path, float, int]] = []
    try:
        for p in CACHE_DIR.glob("*.bin"):
            try:
                st = p.stat()
                out.append((p, st.st_mtime, st.st_size))
            except OSError:
                continue
    except OSError:
        pass
    return out


def cache_stats() -> dict[str, int]:
    """缓存现状（给日志与「关于」页的占用显示用）。"""
    entries = _cache_entries()
    return {
        "files": len(entries),
        "bytes": sum(e[2] for e in entries),
        "max_bytes": _CACHE_MAX_BYTES,
    }


def clear_cache() -> dict[str, int]:
    """**清空**缓存（用户在「关于」页主动点的那个按钮；口径 = 全清）。

    缓存是可再生数据：删掉只是下次看图时重新拉一遍。顺手清掉"只有元数据没有图"的
    孤立 `.json`（那次写入被打断留下的），否则它们会一直躺在体检数字里。
    """
    files = 0
    freed = 0
    for p, _mtime, size in _cache_entries():
        try:
            p.unlink(missing_ok=True)
            p.with_suffix(".json").unlink(missing_ok=True)
            files += 1
            freed += size
        except OSError:
            continue
    try:
        for j in CACHE_DIR.glob("*.json"):
            if not j.with_suffix(".bin").exists():
                j.unlink(missing_ok=True)
                files += 1
    except OSError:
        pass
    if files:
        logger.info(f"图片缓存已清空：{files} 个文件 / {freed / 1048576:.1f}MB")
    return {"files": files, "bytes": freed}


def prune_cache(now: float | None = None) -> dict[str, int]:
    """清缓存：① 过期 ② 仍超容量上限时按**最久未用**淘汰。

    ① 的判据是 `st_mtime > _CACHE_TTL * 2` —— 注意"过期"与"判命中失效"不是一回事：
       命中判定用的是 `.json` 里的 `fetched_at`（7 天），这里再留一个 7 天的窗口才动手删，
       免得刚过期的图片立刻消失、下次看又要回源。
    ② 按 mtime 最旧优先删到上限以下。**为什么不是"抓取时间最旧"**：命中会刷新 mtime，
       于是它近似 LRU —— 左栏头像、常看的封面这类热图不会因为"抓得早"被误删。

    返回 `{"expired": n, "evicted": n, "bytes": b}`；定时清理与手动清理共用这一份。
    """
    now = time.time() if now is None else now
    expired = evicted = freed = 0

    alive: list[tuple[Path, float, int]] = []
    for p, mtime, size in _cache_entries():
        if now - mtime > _CACHE_TTL * 2:
            try:
                p.unlink(missing_ok=True)
                p.with_suffix(".json").unlink(missing_ok=True)
                expired += 1
                freed += size
                continue
            except OSError:
                pass
        alive.append((p, mtime, size))

    total = sum(e[2] for e in alive)
    if _CACHE_MAX_BYTES and total > _CACHE_MAX_BYTES:
        for p, _mtime, size in sorted(alive, key=lambda e: e[1]):
            if total <= _CACHE_MAX_BYTES:
                break
            try:
                p.unlink(missing_ok=True)
                p.with_suffix(".json").unlink(missing_ok=True)
                total -= size
                evicted += 1
                freed += size
            except OSError:
                continue

    if expired or evicted:
        logger.info(
            f"图片缓存清理：过期 {expired} 个 / 超限淘汰 {evicted} 个，释放 "
            f"{freed / 1048576:.1f}MB（现存 {total / 1048576:.1f}MB，"
            f"上限 {_CACHE_MAX_BYTES / 1048576:.0f}MB）")
    return {"expired": expired, "evicted": evicted, "bytes": freed}


def _maybe_cleanup_cache() -> None:
    """按 `_CLEANUP_INTERVAL` 节流地调 `prune_cache()`（避免每次请求都扫目录）。"""
    global _last_cleanup
    now = time.time()
    if now - _last_cleanup < _CLEANUP_INTERVAL:
        return
    _last_cleanup = now
    try:
        prune_cache(now)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"图片缓存清理失败（不影响本次响应）: {e}")


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
                # 刷新"最后使用时间"：容量上限的淘汰判据是 mtime（近似 LRU），
                # 不刷新的话热图会按"抓取时间"排队被删 —— 那正是我们不想要的。
                try:
                    os.utime(body_path, None)
                except OSError:
                    pass
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