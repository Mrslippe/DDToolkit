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


def _codec_rank(stream: dict) -> int:
    """同档里哪条编码先播：**AVC 优先**（0），其余（HEVC/AV1）次之。

    为什么：`dash.video` 里同一档常有两条（实测 2026-10-03：`avc1.640032` 与
    `hvc1.1.6.L150.90` 各一条，码率差一倍）。HEVC/AV1 要看 WebView2 有没有那个解码器
    （Windows 的 HEVC 要单独装扩展），AVC 则到处都能解 —— 拿不准就选能解的。
    """
    codecs = (stream.get("codecs") or "").lower()
    if codecs.startswith("avc"):
        return 0
    return 1


def prefer_quality(streams: list[dict], quality) -> list[dict]:
    """把**实际交付的那一档**排到第一（`dash.video[0]` 就是它），其余保持上游顺序。

    ⚠️ **这是 2026-10-03 真机抓出来的 bug**：`playurl` 的 `dash.video` 列的是**所有可用档**
    （实测顺序恒为降序 80,80,64,64,32,32,16,16），而交付档在 `data.quality` 里。
    前端原来直接取 `[0]` ⇒ 用户在菜单里选 720P（`qn=64`）时，**交付的是 64、播的还是 80**
    （菜单显示 720P、画面却是 1080P）。所以"选哪档"必须按 `quality` 对齐，不能靠顺序。
    """
    if quality is None:
        return streams
    order = sorted(range(len(streams)),
                   key=lambda i: (0 if streams[i].get("id") == quality else 1,
                                  _codec_rank(streams[i]), i))
    return [streams[i] for i in order]


def normalize(data: dict, *, bvid: str, cid: int) -> dict:
    """playurl 的 `data` → 我们的返回形状（**纯函数**，可单测）。"""
    q = data.get("quality")
    accept = [{"id": i, "label": lbl} for i, lbl in
              zip(data.get("accept_quality") or [], data.get("accept_description") or [])]
    dash = parse_dash(data)
    dash["video"] = prefer_quality(dash["video"], q)
    return {
        "bvid": bvid, "cid": cid, "quality": q, "accept": accept,
        "dash": dash, "durl": parse_durl(data),
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
    """bvid → `{cid, title, duration, pages}`（带 1 小时缓存：这些字段不会变）。

    ⚠️ **分P**（2026-10-04，`devlog/329`）：`view` 顶层的 `cid` **就是第 1 P**，
    而 `duration` 是**各 P 之和**（实测 `BV1esa36qEPX`：7 P 共 28526s，P1 只有 4587s）。
    所以这里把 `pages` 一起带出来 —— 上层据此播"用户选的那一 P"，并且**别拿 duration 当片长**。
    """
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
    pages = [{"cid": int(p.get("cid") or 0),
              "page": int(p.get("page") or 0),
              "part": p.get("part") or "",
              "duration_s": int(p.get("duration") or 0)}
             for p in (data.get("pages") or []) if p.get("cid")]
    info = {"title": data.get("title"), "duration": data.get("duration"), "pages": pages}
    cid = int(data.get("cid") or 0)
    if not cid:
        raise PlayError("拿不到 cid（视频信息不完整）", kind="failed")
    _view_cache[bvid] = (cid, info, time.monotonic())
    return {"cid": cid, **info}


def _pick_page(pages: list[dict], cid: int | None, default_cid: int) -> int:
    """用户要哪一 P：没指定 ⇒ 第 1 P（`pages[0]`，与上游顶层 `cid` 同义）。

    指定了但不在这个视频里 ⇒ 如实报 `not_found`（别静默播第 1 P —— 那会让人以为切成功了）。
    ⚠️ 上游没给 `pages` 时**退回顶层 `cid`**（老行为）：缺一个可选字段不该让视频播不了。
    """
    if not pages:
        return int(cid) if cid is not None else int(default_cid)
    if cid is None:
        return int(pages[0]["cid"])
    for p in pages:
        if int(p["cid"]) == int(cid):
            return int(cid)
    raise PlayError(f"这一 P（cid={cid}）不在该视频里", kind="not_found")


async def play_info(bvid: str, *, qn: int | None = None, durl_fallback: bool = False,
                    cid: int | None = None,
                    client: httpx.AsyncClient | None = None) -> dict:
    """取流：**默认 DASH（fnval=16）+ 显式要最高档**。

    ⚠️ **durl 与 DASH 互斥**：`fnval=16` 时 API **不返回** `durl`（实测 `durl=0`）——
    所以"回落"不是同一次就带着，而是 `durl_fallback=True` 时**另发一次 `fnval=1`**
    （单 mp4、720P 封顶、不需要 MSE，给"浏览器不支持 MSE"或 DASH 播不动时用）。

    `qn` 只表达"我想要哪档"；B站按**账号权益 + 片源**给（实测本账号最高 1080P），
    返回值里的 `quality` 才是**实际拿到的档**，前端照它显示。

    `cid` 指定**哪一 P**（`devlog/329`）；不传 = 第 1 P（老行为）。⚠️ 缓存键必须带上它 ——
    少了它，"切到 P2"会命中 P1 的缓存、播的还是 P1（这正是"分P 只有第一段能看"的一半原因）。
    """
    resolved = await resolve_video(bvid, client=client)
    pages = resolved["pages"]
    want = _pick_page(pages, cid, resolved["cid"])
    key = (f"{bvid}:{want}:{qn or DEFAULT_QN}:{'durl' if durl_fallback else 'dash'}")
    hit = _play_cache.get(key)
    if hit and time.monotonic() - hit[1] < CACHE_TTL:
        return hit[0]
    params = {"bvid": bvid, "cid": want, "fourk": 1,
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
    out = normalize(data, bvid=bvid, cid=want)
    out["kernel"] = "durl" if durl_fallback else "dash"
    # 分P 信息随取流一起下发（前端要拿它渲染"分P"菜单；少一次往返）
    out["pages"] = pages
    out["page"] = next((p["page"] for p in pages if p["cid"] == want), 1)
    if not out["dash"]["video"] and not out["durl"]:
        raise PlayError("这次没有拿到任何播放地址（可重试）", kind="failed")
    _play_cache[key] = (out, time.monotonic())
    return out
