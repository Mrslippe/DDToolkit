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
import time
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
#: 每块多大流给前端（64KB 太碎：1080P 一路要几百个 chunk，uvicorn 的写放大之外还多几百次
#: 事件循环切换；256KB 是"首字节够快 + 拷贝次数少"的折中）
_CHUNK = 256 * 1024


# ── 共享客户端（与 `/img-proxy` 同款）──────────────────────────────────────────
#
# ⚠️ 2026-10-04（devlog/300）：以前**每个请求新建一个 `AsyncClient`** —— 媒体播放要发很多次
# Range 请求（拖进度条、切清晰度都会重发），每一次都重做 TCP+TLS 握手，白送几百毫秒；
# 而且旧连接被浏览器中止时留下的清理动作更多（用户日志里那串 ConnectionResetError 就有它）。
_client: httpx.AsyncClient | None = None


def _shared_client() -> httpx.AsyncClient:
    global _client
    # `getattr` 而不是直接 `.is_closed`：用例会用**假客户端**替身（它没这个属性），
    # 代理这边不该因此炸 —— 真实现一定有。
    if _client is None or getattr(_client, "is_closed", False):
        _client = httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT, follow_redirects=True)
    return _client


async def close_client() -> None:
    """lifespan 关闭时释放（与 `img_proxy.close_client` 一起在 `main.lifespan` 里收口）。"""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


# ── 每请求诊断（devlog/306）───────────────────────────────────────────────────
#
# 用户真机反馈："点跳转之后画面先卡在一帧，然后以很低的帧率播一段，再正常；音频全程正常"。
# 那是**视频这一路数据到得不够快**，但"不够快"到底是 CDN、是我们这层代理、还是浏览器，
# 在不看数字的情况下只能猜（前面几批就吃了这个亏）。所以每次转发都记四个数：
#   · **首字节延迟**（CDN 认不认这个 Range、边缘有没有缓存 —— 冷启动就慢在这）
#   · **前 5 秒的吞吐**（够不够撑住实时码率）
#   · 总计字节 / 用时 / 是否被客户端中止
# 一次跳转一行，落在 `logs/app.log`（诊断包里带的就是它）。
_THROUGHPUT_WINDOW = 5.0
_SLOW_TTFB_MS = 1500
#: 低于这个速率就撑不住 1080P（实测片源 ~1900 kbps ⇒ 需要 ~240KB/s）
_SLOW_RATE_BYTES_PER_S = 300_000


def _q_hash(url: str) -> str:
    """URL 的短指纹（**不带签名**）：用来在同一份日志里认出"是不是同一个地址"。"""
    import hashlib

    return hashlib.sha1(url.encode("utf-8", "replace")).hexdigest()[:8]


def _kind_of(url: str) -> str:
    """视频还是音轨（B站的分片文件名以 `-1-302xx.m4s` 收尾，30216/30232/30280 都是音频）。"""
    return "audio" if "-302" in url else "video"


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
    client = _shared_client()
    t0 = time.monotonic()
    try:
        req = client.build_request("GET", url, headers=headers)
        upstream = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        logger.warning(f"视频代理取数失败 {host}: {type(e).__name__}: {e}")
        raise HTTPException(502, f"上游取数失败：{type(e).__name__}") from e
    ttfb_ms = int((time.monotonic() - t0) * 1000)

    if upstream.status_code >= 400:
        code = upstream.status_code
        await upstream.aclose()
        logger.warning(f"视频代理上游 HTTP {code} host={host}")
        raise HTTPException(code, f"上游返回 {code}")

    #: 吞吐采样：`(已送出字节, 相对开始秒数)`，只在前 `_THROUGHPUT_WINDOW` 秒记
    stats = {"sent": 0, "first5": None, "start": time.monotonic()}

    async def _iter():
        """
        ⚠️ **客户端中止是常态，不是错误**（devlog/300）：拖进度条、切清晰度、小窗接管，
        浏览器都会把在飞的那条媒体请求掐掉，这时 `aiter_bytes` 会抛
        `httpx.ReadError` / `ConnectionResetError`（Windows 上是 WinError 10054）。
        旧实现在这里没有任何保护 ⇒ 把它当异常抛回去，uvicorn 的 proactor transport 再记一条
        **ERROR 级 traceback**（用户日志里那一大串就是它），把真问题淹了。
        现在：**中止就当正常收尾**（记一条 debug），真错误才 warning。
        """
        aborted = False
        try:
            async for chunk in upstream.aiter_bytes(_CHUNK):
                yield chunk
                stats["sent"] += len(chunk)
                el = time.monotonic() - stats["start"]
                if stats["first5"] is None and el >= _THROUGHPUT_WINDOW:
                    stats["first5"] = stats["sent"] / el
        except (httpx.HTTPError, ConnectionResetError, OSError) as e:
            aborted = True
            logger.debug(f"视频代理流被中止 host={host}（正常：前端换源/seek）：{type(e).__name__}")
        finally:
            await upstream.aclose()
            _log_stream_done(kind=_kind_of(url), host=host, headers=headers,
                             status=upstream.status_code, ttfb_ms=ttfb_ms,
                             sent=stats["sent"], elapsed=time.monotonic() - stats["start"],
                             first5=stats["first5"], aborted=aborted,
                             url_hash=_q_hash(url))

    out = {k: v for k, v in upstream.headers.items() if k.lower() in _FORWARD_RESP}
    out.setdefault("accept-ranges", "bytes")
    return StreamingResponse(_iter(), status_code=upstream.status_code, headers=out)


def _log_stream_done(*, kind: str, host: str, headers: dict, status: int, ttfb_ms: int,
                     sent: int, elapsed: float, first5: float | None, aborted: bool,
                     url_hash: str) -> None:
    """一条转发结束时的诊断行（跳转/开播各一行，见上面那段注释的动机）。"""
    rate = sent / elapsed if elapsed > 0 else 0.0
    rng = (headers.get("Range") or headers.get("range") or "全量")
    line = (f"[视频代理] {kind} hash={url_hash} host={host} range={rng} status={status} "
            f"首字节={ttfb_ms}ms 前{_THROUGHPUT_WINDOW:.0f}秒={_mb(first5)} 均速={_mb(rate)} "
            f"共={sent / 1048576:.2f}MB 用时={elapsed:.1f}s 中止={'是' if aborted else '否'}")
    # 只把**可疑**的那些提到 WARNING（正常播放每条都 warning 会淹掉真问题）
    slow_ttfb = ttfb_ms > _SLOW_TTFB_MS
    slow_start = first5 is not None and first5 < _SLOW_RATE_BYTES_PER_S
    slow_avg = rate < _SLOW_RATE_BYTES_PER_S and sent > 512 * 1024
    if slow_ttfb or slow_start or slow_avg:
        why = []
        if slow_ttfb:
            why.append(f"首字节 {ttfb_ms}ms（> {_SLOW_TTFB_MS}）—— CDN 认这个 Range 慢/边缘没缓存")
        if slow_start:
            why.append(f"前{_THROUGHPUT_WINDOW:.0f}秒只有 {_mb(first5)} —— 撑不住实时码率会表现为"
                       f"『画面低帧率』")
        if slow_avg:
            why.append(f"均速 {_mb(rate)} 偏低")
        logger.warning(f"{line} ⚠️ {'；'.join(why)}")
    else:
        logger.info(line)


def _mb(bytes_per_s: float | None) -> str:
    if bytes_per_s is None:
        return "未满窗口"
    return f"{bytes_per_s / 1048576:.2f}MB/s"
