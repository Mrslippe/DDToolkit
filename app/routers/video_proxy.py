"""视频代理（2026-10-02，devlog/281 补丁）：把平台 CDN 的视频**经本机后端**流给 WebView。

## 为什么必须有它（真机实测）

小红书 CDN 对**任何带 `Referer` 的请求**一律 **403**：

```
无头 / UA+Range / 只有 Origin  → 200 / 206 ✓
+ Referer: http://localhost:1420/   → 403 ✗
+ Referer: tauri://localhost/       → 403 ✗
+ Sec-Fetch-Dest: video（浏览器形状）→ 403 ✗
```

而 WebView 加载媒体子资源**必然带 Referer**（页面级 `<meta name="referrer">` 能不能救活媒体
请求在各版本上并不一致）⇒ 直连在前端这条路不可靠。这个代理发请求时**不带 Referer**
（头由我们控制），且**同源**（CSP 的 `media-src 'self'` 天然放行）。

## 口径

- **域名白名单**（`ALLOWED_HOSTS`）：只代理平台 CDN —— 不做开放代理（本机端口也是端口）；
- **Range 直通**：`<video>` 靠它拖进度条；上游的 `206`/`Content-Range`/`Accept-Ranges` 原样回；
- **不落盘**：视频体积大、版权也敏感，只做流式转发（与图片代理 `img-cache` 的取舍不同）；
- 超时 30s、连接失败如实回上游状态码（别把 403 说成"没有这个视频"）。
"""
from __future__ import annotations

import logging
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["media"])

#: 允许代理的主机（后缀匹配）：平台视频 CDN。**新增平台时在这里加**，别放宽成通配。
ALLOWED_HOSTS: tuple[str, ...] = (
    "xhscdn.com",              # 小红书（图片/视频同域）
    "sns-video-v4.xhscdn.com",
)

_UPSTREAM_TIMEOUT = 30.0
#: 只转发这些请求头给上游（**刻意不带 Referer/Origin/Cookie** —— 就是它们惹的 403）
_FORWARD_REQ = ("range",)
#: 回给浏览器的响应头（`accept-ranges` 必须留：否则播放器以为不能拖进度）
_FORWARD_RESP = ("content-type", "content-length", "content-range", "accept-ranges",
                 "last-modified", "etag", "cache-control")


def host_allowed(url: str) -> str:
    """URL 的主机在白名单里吗（是 → 返回 host；否则抛 400）。"""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        host = ""
    if not host:
        raise HTTPException(400, "url 不合法")
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS):
        raise HTTPException(400, f"这个主机不在视频代理的白名单里：{host}")
    return host


@router.get("/video-proxy")
async def video_proxy(request: Request, url: str = Query(...)):
    """流式转发一个白名单内的视频 URL（Range 直通、不落盘）。"""
    host = host_allowed(url)
    headers = {k: v for k, v in request.headers.items() if k.lower() in _FORWARD_REQ}
    client = httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT, follow_redirects=True)
    try:
        req = client.build_request("GET", url, headers=headers)
        upstream = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        logger.warning(f"视频代理取数失败 {host}: {type(e).__name__}: {e}")
        raise HTTPException(502, f"上游取数失败：{type(e).__name__}") from e

    if upstream.status_code >= 400:
        code = upstream.status_code
        await upstream.aclose()
        await client.aclose()
        logger.warning(f"视频代理上游 HTTP {code} host={host}")
        raise HTTPException(code, f"上游返回 {code}")

    async def _iter():
        try:
            async for chunk in upstream.aiter_bytes(64 * 1024):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    out = {k: v for k, v in upstream.headers.items() if k.lower() in _FORWARD_RESP}
    out.setdefault("accept-ranges", "bytes")
    return StreamingResponse(_iter(), status_code=upstream.status_code, headers=out)
