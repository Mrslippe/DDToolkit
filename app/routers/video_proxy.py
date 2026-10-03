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

from app.core.useragent import UA_CHROME

logger = logging.getLogger(__name__)

router = APIRouter(tags=["media"])

#: 允许代理的主机（后缀匹配）：平台视频 CDN。**新增平台时在这里加**，别放宽成通配。
#:
#: ⚠️ **2026-10-03 真机补的 `.cn`**：B站的 `baseUrl` 常常给 P2P/mcdn 镜像
#: （`xy*.mcdn.bilivideo.cn`，实测某视频**每一条流**都是它），而 `backupUrl` 里才是普通 CDN。
#: 只认 `.com` 时，前端把 `baseUrl` 递过来 → **400「不在白名单」**，表现为"全部都播不了"。
ALLOWED_HOSTS: tuple[str, ...] = (
    "xhscdn.com",              # 小红书（图片/视频同域）
    "bilivideo.com",           # B站媒体 CDN（cn-*.bilivideo.com / upos-*.bilivideo.com …）
    "bilivideo.cn",            # B站 mcdn/P2P 镜像（xy*.mcdn.bilivideo.cn）
    "weibocdn.com",            # 微博视频 CDN（f.video.weibocdn.com）
    "sinaimg.cn",              # 微博图床（gif 转的 mp4 也叫这个域）
)

#: **按主机分请求头**（2026-10-03 实测：两家要求正好相反）
#:
#: | CDN | 不带 Referer | 带 `Referer: bilibili.com` |
#: |---|---|---|
#: | `bilivideo.com` | **403** | 206 ✓ |
#: | `xhscdn.com` | 206 ✓ | **403** |
#:
#: 所以这里是一张**策略表**，不是一刀切。
HOST_POLICY: tuple[tuple[str, dict[str, str]], ...] = (
    ("xhscdn.com", {}),
    ("bilivideo.com", {"Referer": "https://www.bilibili.com/", "User-Agent": UA_CHROME}),
    ("bilivideo.cn", {"Referer": "https://www.bilibili.com/", "User-Agent": UA_CHROME}),
    # 微博（实测 2026-10-03，devlog/291）：**裸请求 200，但带 UA+Range 而无 Referer → 403**，
    # 带 `Referer: https://weibo.com/` → 206 ⇒ 与 B站 同款策略
    ("weibocdn.com", {"Referer": "https://weibo.com/", "User-Agent": UA_CHROME}),
    ("sinaimg.cn", {"Referer": "https://weibo.com/", "User-Agent": UA_CHROME}),
)

_UPSTREAM_TIMEOUT = 30.0
#: 只转发这些请求头给上游（**刻意不带 Referer/Origin/Cookie** —— 就是它们惹的 403）
_FORWARD_REQ = ("range",)
#: 回给浏览器的响应头（`accept-ranges` 必须留：否则播放器以为不能拖进度）
_FORWARD_RESP = ("content-type", "content-length", "content-range", "accept-ranges",
                 "last-modified", "etag", "cache-control")


def _host_of(url: str) -> str:
    """URL 的主机名（小写）；解析不了就空串。"""
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def is_allowed_url(url: str) -> bool:
    """这个 URL 的主机在白名单里吗（**纯函数**）。

    为什么单独抽出来：取流侧（`services/bili_play.py`）要在**多个镜像里挑一个能过代理的**
    —— 它需要的是"能不能过"，不是"抛不抛 HTTPException"。
    """
    host = _host_of(url)
    return bool(host) and any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)


def host_allowed(url: str) -> str:
    """URL 的主机在白名单里吗（是 → 返回 host；否则抛 400）。"""
    host = _host_of(url)
    if not host:
        raise HTTPException(400, "url 不合法")
    if not is_allowed_url(url):
        raise HTTPException(400, f"这个主机不在视频代理的白名单里：{host}")
    return host


def policy_for(host: str) -> dict[str, str]:
    """该主机要附带的请求头（策略表按后缀匹配；未命中 → 什么都不带）。"""
    for suffix, headers in HOST_POLICY:
        if host == suffix or host.endswith("." + suffix):
            return dict(headers)
    return {}


@router.get("/video-proxy")
async def video_proxy(request: Request, url: str = Query(...)):
    """流式转发一个白名单内的视频 URL（Range 直通、不落盘、**按主机补/剥请求头**）。"""
    host = host_allowed(url)
    headers = {k: v for k, v in request.headers.items() if k.lower() in _FORWARD_REQ}
    # 策略头**最后合并**：CDN 要什么由我们决定，不听浏览器的（`Referer`/`Origin`/`Cookie` 一律不转发）
    headers.update(policy_for(host))
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
