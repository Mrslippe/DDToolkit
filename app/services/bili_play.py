"""B站视频取流（2026-10-03，devlog/289）：`view`（bvid→cid） + `playurl`（拿播放地址）。

## 口径（全部来自真机实测，不是推测）

| 请求 | 格式 | 游客 | 登录（非大会员） |
|---|---|---|---|
| `playurl fnval=1` | durl 单 mp4 | 720P | **仍 720P（封顶）** |
| `playurl fnval=16` | DASH（音视频分离） | 720P | **1080P**（`quality=80`） |
| 要 1080P+ / 1080P60 / 4K | — | — | **回落到 1080P**（要大会员） |
| 媒体 CDN | — | **不带 Referer → 403**，带 `Referer: bilibili.com` → 206 | 同 |

⇒ ① **默认取 DASH**（只有它能到 1080P），durl 一起带回去当回落；
② 媒体地址**短时效且绑 IP** ⇒ 只在用户点播放时取，本层加**短缓存**（120s）挡住连点；
③ **凭据只在请求头**：不打印、不进返回值（判据里植哨兵断言）。
"""
from __future__ import annotations

import logging
import time

import httpx

from app.core.http import new_async_client
from app.core.useragent import UA_CHROME
from app.services.auth import auth_manager

logger = logging.getLogger(__name__)

VIEW_URL = "https://api.bilibili.com/x/web-interface/view"
PLAYURL_URL = "https://api.bilibili.com/x/player/playurl"

CACHE_TTL = 120.0
_VIEW_TTL = 3600.0

#: 默认"想要的档"：**显式要最高**，由 B站按账号权益回落。
#: ⚠️ 实测（2026-10-03）：**不传 `qn` 只给 720P**；传 `qn=120` 时 B站回落到账号上限（本账号 1080P）。
#: 所以"默认选账号可得的最高档"的正确做法是**要最高 + 读回 `quality`**，而不是猜。
DEFAULT_QN = 120
FNVAL_DASH = 16          # DASH：音视频分离（登录后有 1080P）
FNVAL_DURL = 1           # durl：单个 mp4（720P 封顶）—— **与 DASH 互斥**，回落时另发一次

_headers_ref: dict | None = None


class PlayError(RuntimeError):
    """取流失败：带**如实的**原因（别把"没权限"说成"取不到"）。"""

    def __init__(self, message: str, *, code: int | None = None, kind: str = "failed"):
        super().__init__(message)
        self.message = message
        self.code = code
        self.kind = kind          # not_found / forbidden / risk_control / failed


def reason_of(code: int | None, message: str = "") -> str:
    """B站业务码 → 给用户看的原因（**如实**，别一律说"没拉到"）。"""
    if code == -404:
        return "视频不存在或已被删除"
    if code == -403:
        return "没有观看权限（充电专属 / 地区限制 / 需要登录）"
    if code == -352:
        return "B站风控中（请求过于频繁），稍后再试"
    return message or f"取流失败（code={code}）"


def _kind_of(code: int | None) -> str:
    return {-404: "not_found", -403: "forbidden", -352: "risk_control"}.get(code, "failed")


def _headers() -> dict:
    """请求头：会话凭据 + **Referer**（媒体 CDN 与部分接口都要求）。**绝不打印**。"""
    return {**auth_manager.build_headers(), "Referer": "https://www.bilibili.com/",
            "User-Agent": UA_CHROME}


def parse_dash(data: dict) -> dict:
    """DASH 段 → 只留前端要用的字段（URL 原样，带签名）。

    ⚠️ **候选要排过序**（2026-10-03 真机，devlog/294）：B站给的 `baseUrl` 常常是
    P2P/mcdn 镜像（`xy*.mcdn.bilivideo.cn`），而 `/video-proxy` 的白名单只认平台自家域名
    —— 实测某个视频**每一条流**的 `baseUrl` 都是 mcdn、`backupUrl[1]` 才是普通 CDN。
    不排序的话，前端拿 `baseUrl` 去代理 ⇒ 400「主机不在白名单」⇒ "全部都播不了"。
    所以这里把 `[baseUrl, *backupUrl]` 排成 `urls`：**先能过代理的、且不是 mcdn 的**。
    """
    dash = data.get("dash") or {}

    def streams(items) -> list[dict]:
        out = []
        for s in items or []:
            if not isinstance(s, dict):
                continue
            base = s.get("baseUrl") or s.get("base_url")
            if not base:
                continue
            backups = s.get("backupUrl") or s.get("backup_url") or []
            if isinstance(backups, str):
                backups = [backups]
            urls = rank_urls([base, *[b for b in backups if b]])
            out.append({
                "id": s.get("id"),
                "base_url": urls[0],
                "urls": urls,
                "backup_url": urls[1] if len(urls) > 1 else None,
                "bandwidth": s.get("bandwidth"),
                "codecs": s.get("codecs"),
                "width": s.get("width"),
                "height": s.get("height"),
                "mime": s.get("mimeType") or s.get("mime_type"),
            })
        return out

    return {"video": streams(dash.get("video")), "audio": streams(dash.get("audio"))}


def _host_rank(url: str) -> int:
    """越小越优先：0 = 代理白名单里的普通 CDN，1 = 白名单里的 mcdn/P2P 镜像，2 = 过不了代理。"""
    from app.routers.video_proxy import _host_of, is_allowed_url

    if not is_allowed_url(url):
        return 2
    return 1 if "mcdn" in _host_of(url) else 0


def rank_urls(urls: list[str]) -> list[str]:
    """把同一个流的多个镜像按"能不能过代理"排序（**稳定**：同档保持上游给的顺序）。"""
    seen: set[str] = set()
    uniq = [u for u in urls if u and not (u in seen or seen.add(u))]
    return sorted(uniq, key=_host_rank)


def parse_durl(data: dict) -> list[dict]:
    """durl 段（回落内核）：同样排过序 —— 实测 `url` 可以是 P2P 的 `edge.mountaintoys.cn`，
    而 `backup_url` 里才有能过代理的 `upos-*.bilivideo.com`。"""
    out = []
    for d in data.get("durl") or []:
        if not isinstance(d, dict) or not d.get("url"):
            continue
        backups = d.get("backup_url") or d.get("backupUrl") or []
        if isinstance(backups, str):
            backups = [backups]
        urls = rank_urls([d["url"], *[b for b in backups if b]])
        out.append({"url": urls[0], "urls": urls,
                    "size": d.get("size"), "length": d.get("length")})
    return out


def normalize(data: dict, *, bvid: str, cid: int) -> dict:
    """playurl 的 `data` → 我们的返回形状（**纯函数**，可单测）。"""
    q = data.get("quality")
    accept = [{"id": i, "label": lbl} for i, lbl in
              zip(data.get("accept_quality") or [], data.get("accept_description") or [])]
    return {
        "bvid": bvid, "cid": cid, "quality": q, "accept": accept,
        "dash": parse_dash(data), "durl": parse_durl(data),
        # 前端据此判断"这次取到的地址还能用多久"（到期就重取一次）
        "expires_in": CACHE_TTL,
    }


async def _get(client: httpx.AsyncClient, url: str, params: dict) -> dict:
    try:
        resp = await client.get(url, params=params, headers=_headers())
    except httpx.HTTPError as e:
        raise PlayError(f"网络失败：{type(e).__name__}", kind="failed") from e
    try:
        body = resp.json()
    except ValueError as e:
        raise PlayError(f"响应不是 JSON（HTTP {resp.status_code}）", kind="failed") from e
    code = body.get("code")
    if code != 0:
        raise PlayError(reason_of(code, str(body.get("message") or "")),
                        code=code, kind=_kind_of(code))
    return body.get("data") or {}


# 进程内缓存：`{bvid: (cid, 视频信息, 时刻)}` / `{bvid:qn: (取流结果, 时刻)}`
_view_cache: dict[str, tuple[int, dict, float]] = {}
_play_cache: dict[str, tuple[dict, float]] = {}


def clear_cache() -> None:
    _view_cache.clear()
    _play_cache.clear()


async def resolve_video(bvid: str, *, client: httpx.AsyncClient | None = None) -> dict:
    """bvid → `{cid, title, duration}`（带 1 小时缓存：这些字段不会变）。"""
    hit = _view_cache.get(bvid)
    if hit and time.monotonic() - hit[2] < _VIEW_TTL:
        return {"cid": hit[0], **hit[1]}
    own = client is None
    if own:
        client = new_async_client(15.0)
    try:
        data = await _get(client, VIEW_URL, {"bvid": bvid})
    finally:
        if own:
            await client.aclose()
    info = {"title": data.get("title"), "duration": data.get("duration")}
    cid = int(data.get("cid") or 0)
    if not cid:
        raise PlayError("拿不到 cid（视频信息不完整）", kind="failed")
    _view_cache[bvid] = (cid, info, time.monotonic())
    return {"cid": cid, **info}


async def play_info(bvid: str, *, qn: int | None = None, durl_fallback: bool = False,
                    client: httpx.AsyncClient | None = None) -> dict:
    """取流：**默认 DASH（fnval=16）+ 显式要最高档**。

    ⚠️ **durl 与 DASH 互斥**：`fnval=16` 时 API **不返回** `durl`（实测 `durl=0`）——
    所以"回落"不是同一次就带着，而是 `durl_fallback=True` 时**另发一次 `fnval=1`**
    （单 mp4、720P 封顶、不需要 MSE，给"浏览器不支持 MSE"或 DASH 播不动时用）。

    `qn` 只表达"我想要哪档"；B站按**账号权益 + 片源**给（实测本账号最高 1080P），
    返回值里的 `quality` 才是**实际拿到的档**，前端照它显示。
    """
    key = f"{bvid}:{qn or DEFAULT_QN}:{'durl' if durl_fallback else 'dash'}"
    hit = _play_cache.get(key)
    if hit and time.monotonic() - hit[1] < CACHE_TTL:
        return hit[0]
    cid = (await resolve_video(bvid, client=client))["cid"]
    params = {"bvid": bvid, "cid": cid, "fourk": 1,
              "fnval": FNVAL_DURL if durl_fallback else FNVAL_DASH,
              "qn": qn or DEFAULT_QN}
    own = client is None
    if own:
        client = new_async_client(20.0)
    try:
        data = await _get(client, PLAYURL_URL, params)
    finally:
        if own:
            await client.aclose()
    out = normalize(data, bvid=bvid, cid=cid)
    out["kernel"] = "durl" if durl_fallback else "dash"
    if not out["dash"]["video"] and not out["durl"]:
        raise PlayError("这次没有拿到任何播放地址（可重试）", kind="failed")
    _play_cache[key] = (out, time.monotonic())
    return out
