# -*- coding: utf-8 -*-
"""多平台「按名字搜人」（B1，需求 8，`devlog/463`）。

## 为什么要它

「添加 V」原来只有三条来源：本地候选池、本地 danmakus 索引、**B 站在线检索**。
用户口径（2026-10-08）：输入名字时**同时在"已开启的平台"上做模糊检索**，
有结果就展示，**全都没有**才显示一行「没找到」。

## 四家的接口（2026-10-11 全部真机实测，`devlog/463` 有取证过程）

| 平台 | 接口 | 结果在哪 | 备注 |
|---|---|---|---|
| B 站 | `wbi/search/type?search_type=bili_user` | `data.result[]` | **已有**（`bili_search`），这里只转发 |
| 微博 | `weibo.com/ajax/side/search?q=` | `data.users[]` | ⚠️ **只回最匹配的 1 条**（它是建议型接口）；必须 **PC 域** |
| 小红书 | `POST /api/sns/web/v1/search/usersearch` | `data.users[]` | 要签名；请求体是**嵌套**的 `{"search_user_request": {...}}`，且 `biz_type`/`request_id` 是必填 |
| 抖音 | `/aweme/v1/web/discover/search/?search_channel=aweme_user_web` | `data.user_list[].user_info` | 要签名（`a_bogus`） |

⚠️ 三条**踩过的坑**（都不是"接口没有"，是路径/域/参数不对 —— 每一坑都先得出过错误结论）：

1. **微博**第一轮打 `m.weibo.cn`（移动站）恒定 `ok=-100`，一度以为"微博搜人做不到"。
   真因写在 `platforms/weibo.py` 的文件头：**扫码产出的 SUB cookie 只对 PC 域有效**，
   移动站要 wapssowb 链路。换到 `weibo.com` 就成了。
2. **小红书**我猜的三个路径全是 404。真路径是从**官网前端 bundle** 里 grep 出来的
   （`/api/sns/web/v1/search/usersearch`）；参数名也是接口一条条"要"出来的
   （先要 `search_user_request` → 再要 `biz_type` → 再要 `request_id`）。
3. **抖音** `general/search/single` 配 `search_channel=aweme_user_web` 回的是**视频卡**
   （9 视频 + 1 相关词），用户卡在**另一个端点**：`discover/search` → `user_list[]`。

## 与适配器的关系（为什么不各写一份请求管道）

签名、身份、UA、公共参数**各平台的唯一真源在 `platforms/*.py` 里**。
本模块**复用**那些管道（小红书 `_signed_headers`、抖音 `_base_params`/`_signed`），
只负责"搜人的业务语义"（关键词 → 统一结果形状 + 诚实的失败分类）。
另起一份请求实现就会长出第二个签名源 —— 那正是本仓最忌讳的形状。

## 口径

- **平台关着 ⇒ 一个请求都不发**（`platform_switches`），结果里带 `skipped=True` + 原因；
- **失败不静默**：每个平台各自带 `error`/`hint`（没登录就直说去登录，缺依赖就说缺依赖）；
- **单平台失败不影响其余**（各打各的，`asyncio.gather` 里逐平台兜异常）；
- 结果缓存 5 分钟 + 每平台最小间隔（添加 V 是用户驱动的低流量路径，但"边打边搜"会连发）。
"""
from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import quote

from app.core.http import new_async_client
from app.services import platform_switches
from app.services import bili_search
from app.services.platforms import registry
from app.services.platforms.xiaohongshu import BASE as XHS_BASE

logger = logging.getLogger(__name__)

WEIBO_SEARCH_URL = "https://weibo.com/ajax/side/search"

#: 结果缓存秒数（同一关键词反复搜 —— 含前端重试与来回切平台 —— 不打上游）
CACHE_TTL = 300.0
CACHE_MAX = 128
#: 每个平台两次上游调用之间的最小间隔（秒）。四家共用一把锁、按平台各记时刻。
MIN_INTERVAL = 1.0

#: 平台 → 给用户的失败补救话术（与 `bili_search` 的 hint 同风格：一句话说清"该做什么"）
_LOGIN_HINT: dict[str, str] = {
    "bilibili": "B 站检索需要登录态（WBI 密钥要从 nav 取）：先在顶栏登录 B 站再试",
    "weibo": ("微博检索要用 PC 域登录态（扫码产出的 SUB cookie）："
              "到「设置 → 登录」里重新扫码或粘贴 Cookie"),
    "xiaohongshu": "小红书检索要签名 + 登录态：到「设置 → 登录」里粘贴 Cookie 后重试",
    "douyin": "抖音检索要签名 + 登录态（cookie 里的 uifid 也要）：到「设置 → 登录」里粘贴 Cookie",
}

#: 「只要个位数粉丝」这类脏值解析用（`fans` 在小红书是**字符串** "17.3万"）
_FANS_RE = re.compile(r"^\s*([\d.]+)\s*(万|亿|w|W|k|K)?\s*$")


def parse_fans(raw: Any) -> int:
    """小红书那种**格式化过的粉丝数**（`"17.3万"` / `"1234"` / `""`）→ 整数。

    ⚠️ 不能 `int(raw)`：真机回的是 `"17.3万"` 这种串，直接转会抛；而"抛了就当作 0"
    会让 17.3 万粉的人显示成 0 粉（用户据此判断"这是不是那个大 V"，答错代价高）。
    认不出 ⇒ 0（与"没有这个字段"同义，前端本来就不显示 0 粉）。
    """
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return max(0, int(raw))
    m = _FANS_RE.match(str(raw or ""))
    if not m:
        return 0
    try:
        n = float(m.group(1))
    except ValueError:
        return 0
    unit = (m.group(2) or "").lower()
    scale = {"万": 10_000, "w": 10_000, "亿": 100_000_000, "k": 1_000}.get(unit, 1)
    return max(0, int(n * scale))


@dataclass
class PlatformHits:
    """一个平台这一轮的检索结果（**失败也返回它**：失败要如实带到界面上）。"""
    platform: str
    label: str
    items: list[dict] = field(default_factory=list)
    #: 失败分类：`not_logged_in` / `rate_limited` / `unsupported` / `not_found` /
    #: `network_error` / `upstream_degraded` / `upstream_error` / `skipped`
    error: str | None = None
    hint: str | None = None
    #: 平台总开关关着 ⇒ 这一个请求都没发（与"发了但失败"要分得开）
    skipped: bool = False
    #: 该平台**只给最匹配的一条**（微博）—— 界面据此把话说准，别让人以为"就一条结果"
    best_match_only: bool = False

    def as_dict(self) -> dict:
        return {"platform": self.platform, "label": self.label, "items": self.items,
                "error": self.error, "hint": self.hint, "skipped": self.skipped,
                "best_match_only": self.best_match_only}


# ── 节流与缓存（threading + 时刻表：不持有 loop-bound 原语，同 `bili_search`）──
_gate = threading.Lock()
_last_call: dict[str, float] = {}
_cache: dict[tuple[str, str], tuple[list[dict], float]] = {}


async def _acquire(platform: str) -> None:
    """占一个名额（同一平台两次调用至少隔 `MIN_INTERVAL`；锁外 sleep）。"""
    while True:
        with _gate:
            now = time.monotonic()
            wait = _last_call.get(platform, 0.0) + MIN_INTERVAL - now
            if wait <= 0:
                _last_call[platform] = now
                return
        await asyncio.sleep(min(wait, 0.5))


def _cache_get(platform: str, kw: str) -> list[dict] | None:
    hit = _cache.get((platform, kw.lower()))
    if not hit:
        return None
    items, at = hit
    if time.monotonic() - at > CACHE_TTL:
        _cache.pop((platform, kw.lower()), None)
        return None
    return items


def _cache_put(platform: str, kw: str, items: list[dict]) -> None:
    if len(_cache) >= CACHE_MAX:
        _cache.pop(next(iter(_cache)), None)
    _cache[(platform, kw.lower())] = (items, time.monotonic())


def clear_cache() -> None:
    """清缓存与节流窗口（测试用）。"""
    with _gate:
        _cache.clear()
        _last_call.clear()


# ── 统一条目形状 ──────────────────────────────────────────────────────

def _item(platform: str, uid: Any, name: Any, *, sign: Any = "", followers: int = 0,
          avatar: Any = "", verified: Any = "") -> dict | None:
    """→ 本仓统一形状（与 `bili_search.map_search_item` **逐字同形**，前端一套渲染）。

    缺 uid 或名字的条目不产出（脏数据；前端拿它建不了库）。
    """
    uid_s, name_s = str(uid or "").strip(), str(name or "").strip()
    if not uid_s or not name_s:
        return None
    return {
        "platform": platform,
        "platform_uid": uid_s,
        "name": name_s,
        "sign": str(sign or "").strip(),
        "followers": int(followers or 0),
        "avatar": str(avatar or "").strip(),
        "verified": str(verified or "").strip(),
        "is_live": False,
        "room_id": None,
        "videos": 0,
        "level": 0,
        "exact": False,
    }


# ── 四家的实现 ────────────────────────────────────────────────────────

async def _search_bilibili(kw: str, page: int) -> PlatformHits:
    """B 站：直接转发既有实现（它自带节流/缓存/错误分类）。

    ⚠️ 用 `search()` 而**不是** `search_users()`：前者在输入是纯数字（≥5 位）时走
    **UID 精确查**（`acc/info` + `relation/stat`）—— B 站搜索接口搜不到 uid（实测），
    而"按 UID 添加"是既有能力，不能因为换成多平台入口就丢掉。
    """
    res = await bili_search.search(kw, page=page)
    if res.items:
        return PlatformHits("bilibili", platform_switches.LABELS["bilibili"],
                            items=res.items)
    err = res.error or "not_found"
    hint = res.hint
    if err == "not_logged_in" and not hint:
        hint = _LOGIN_HINT["bilibili"]
    return PlatformHits("bilibili", platform_switches.LABELS["bilibili"],
                        error=err, hint=hint)


async def _search_weibo(kw: str, page: int) -> PlatformHits:
    """微博：`weibo.com/ajax/side/search`（**PC 域**；移动站恒 -100，见模块头）。"""
    from app.services.weibo_auth import weibo_auth_manager

    label = platform_switches.LABELS["weibo"]
    if not weibo_auth_manager.cookie:
        return PlatformHits("weibo", label, error="not_logged_in",
                            hint=_LOGIN_HINT["weibo"])
    cached = _cache_get("weibo", kw)
    if cached is not None:
        return PlatformHits("weibo", label, items=cached)
    await _acquire("weibo")
    headers = weibo_auth_manager.build_headers({"Referer": "https://weibo.com/"})
    try:
        async with new_async_client(15.0) as client:
            resp = await client.get(WEIBO_SEARCH_URL, params={"q": kw}, headers=headers)
    except Exception as e:                                     # noqa: BLE001
        logger.warning("微博检索请求失败 kw=%r: %s: %s", kw, type(e).__name__, e)
        return PlatformHits("weibo", label, error="network_error", hint="网络异常，稍后重试")
    if resp.status_code != 200:
        return PlatformHits("weibo", label, error="upstream_error",
                            hint=f"微博返回 HTTP {resp.status_code}")
    try:
        body = resp.json()
    except ValueError:
        return PlatformHits("weibo", label, error="upstream_error",
                            hint="微博返回非 JSON（多半要重新登录）")
    if body.get("ok") != 1:
        # ⚠️ `-100` 是"这条 cookie 在 PC 域也不认了"——如实说去重登，别说"没找到这个人"
        if body.get("ok") == -100:
            weibo_auth_manager.mark_invalid("搜索 ok=-100")
            return PlatformHits("weibo", label, error="not_logged_in",
                                hint=_LOGIN_HINT["weibo"])
        return PlatformHits("weibo", label, error="upstream_error",
                            hint=f"微博返回 ok={body.get('ok')}")
    data = body.get("data") or {}
    items = [it for it in (
        _item("weibo", u.get("idstr") or u.get("id"), u.get("screen_name"),
              sign=u.get("description"),
              followers=int(u.get("followers_count") or 0),
              avatar=u.get("profile_image_url"),
              verified=("微博认证" if u.get("verified") else ""))
        for u in (data.get("users") or []) if isinstance(u, dict)) if it]
    if items:
        _cache_put("weibo", kw, items)
    # ⚠️ 只回最匹配的一条：这是**接口形态**（建议型），不是我们只取第一条
    return PlatformHits("weibo", label, items=items, best_match_only=True,
                        error=None if items else "not_found",
                        hint=None if items else "微博没给出匹配的用户")


async def _search_xiaohongshu(kw: str, page: int) -> PlatformHits:
    """小红书：`/api/sns/web/v1/search/usersearch`（嵌套请求体 + 签名）。"""
    from app.services.platforms.signing import SignerUnavailable

    label = platform_switches.LABELS["xiaohongshu"]
    cached = _cache_get("xiaohongshu", kw)
    if cached is not None:
        return PlatformHits("xiaohongshu", label, items=cached)
    pf = registry.get_fetcher("xiaohongshu")
    if pf is None:                                             # pragma: no cover
        return PlatformHits("xiaohongshu", label, error="unsupported",
                            hint="本版本没有小红书适配器")
    await _acquire("xiaohongshu")
    # ⚠️ 请求体形状是接口"要"出来的：外层 `search_user_request`、内层 `biz_type` + `request_id`
    #    三个都是必填（少一个就 400 并逐个点名，见 devlog/463 的取证过程）
    import uuid

    payload = {"search_user_request": {
        "keyword": kw, "page": page, "page_size": 20, "search_id": "",
        "biz_type": "web_search_user", "request_id": str(uuid.uuid4()),
    }}
    path = "/api/sns/web/v1/search/usersearch"
    try:
        headers = pf._signed_headers("POST", path, payload)      # noqa: SLF001（复用它的签名管道）
        async with new_async_client(20.0) as client:
            resp = await client.post(f"{XHS_BASE}{path}", json=payload, headers=headers)
    except SignerUnavailable as e:
        return PlatformHits("xiaohongshu", label, error="not_logged_in",
                            hint=_LOGIN_HINT["xiaohongshu"] if "cookie" in str(e).lower()
                            else f"小红书签名器不可用：{e}")
    except Exception as e:                                     # noqa: BLE001
        logger.warning("小红书检索请求失败 kw=%r: %s: %s", kw, type(e).__name__, e)
        return PlatformHits("xiaohongshu", label, error="network_error",
                            hint="网络异常，稍后重试")
    try:
        body = resp.json()
    except ValueError:
        return PlatformHits("xiaohongshu", label, error="upstream_error",
                            hint=f"小红书返回非 JSON（HTTP {resp.status_code}）")
    if not body.get("success"):
        code = body.get("code")
        msg = str(body.get("msg") or "")[:120]
        # 461/471 是验证码/风控（调研 §1.3）：**不绕**，如实说
        if code in (461, 471) or "验证" in msg:
            return PlatformHits("xiaohongshu", label, error="upstream_degraded",
                                hint=f"小红书要验证码/正在风控（code={code}），本次不重试")
        if code in (-100, 300012):
            return PlatformHits("xiaohongshu", label, error="not_logged_in",
                                hint=_LOGIN_HINT["xiaohongshu"])
        return PlatformHits("xiaohongshu", label, error="upstream_error",
                            hint=f"小红书返回 code={code}：{msg}")
    data = body.get("data") or {}
    raw = data.get("users") or data.get("items") or []
    items = [it for it in (
        _item("xiaohongshu", u.get("id"), u.get("name") or u.get("nickname")
              or (u.get("sub_title") or "").replace("小红书号：", "").strip(),
              sign=u.get("desc") or u.get("description"),
              followers=parse_fans(u.get("fans")),
              avatar=u.get("image") or u.get("avatar"),
              verified=("小红书认证" if u.get("red_official_verified") else ""))
        for u in raw if isinstance(u, dict)) if it]
    if items:
        _cache_put("xiaohongshu", kw, items)
    return PlatformHits("xiaohongshu", label, items=items,
                        error=None if items else "not_found",
                        hint=None if items else "小红书没给出匹配的用户")


async def _search_douyin(kw: str, page: int) -> PlatformHits:
    """抖音：`/aweme/v1/web/discover/search/?search_channel=aweme_user_web` → `user_list[]`。"""
    from app.services.platforms.signing import SignerUnavailable

    label = platform_switches.LABELS["douyin"]
    cached = _cache_get("douyin", kw)
    if cached is not None:
        return PlatformHits("douyin", label, items=cached)
    pf = registry.get_fetcher("douyin")
    if pf is None:                                             # pragma: no cover
        return PlatformHits("douyin", label, error="unsupported",
                            hint="本版本没有抖音适配器")
    await _acquire("douyin")
    path = "/aweme/v1/web/discover/search/"
    params = {**pf._base_params(), "search_channel": "aweme_user_web",  # noqa: SLF001
              "keyword": kw, "offset": str((max(1, page) - 1) * 10), "count": "10",
              "search_source": "normal_search", "query_correct_type": "1", "search_id": ""}
    try:
        query, extra_headers = pf._signed(params)               # noqa: SLF001
    except SignerUnavailable as e:
        return PlatformHits("douyin", label, error="not_logged_in",
                            hint=_LOGIN_HINT["douyin"] if "cookie" in str(e).lower()
                            else f"抖音签名器不可用：{e}")
    headers = {"User-Agent": pf._ua(), "Accept": "application/json, text/plain, */*",  # noqa: SLF001
               "Referer": f"https://www.douyin.com/search/{quote(kw)}?type=user",
               "Cookie": pf._cookie_header(), "x-tt-argus": "1", **extra_headers}  # noqa: SLF001
    try:
        async with new_async_client(20.0) as client:
            resp = await client.get(f"https://www.douyin.com{path}?{query}", headers=headers)
    except Exception as e:                                     # noqa: BLE001
        logger.warning("抖音检索请求失败 kw=%r: %s: %s", kw, type(e).__name__, e)
        return PlatformHits("douyin", label, error="network_error", hint="网络异常，稍后重试")
    body_bytes = resp.content
    try:
        import json as _json

        body = _json.loads(body_bytes.decode("utf-8"))
    except Exception:                                          # noqa: BLE001
        # ⚠️ 抖音签名被拒的形态是 **HTTP 200 + 空体**（`devlog/333`），所以"非 JSON"与
        #    "0 字节"都归到"签名/身份不被认"，而不是 upstream_error
        if len(body_bytes) == 0:
            return PlatformHits("douyin", label, error="not_logged_in",
                                hint=_LOGIN_HINT["douyin"])
        return PlatformHits("douyin", label, error="upstream_error",
                            hint=f"抖音返回非 JSON（HTTP {resp.status_code}）")
    # ⚠️ **不能**用 `classify_payload(..., expect="list")` 判这一发：那个 expect 判的是
    #    `aweme_list`（作品列表），而搜人回的是 `user_list` ⇒ 成功也会被判成
    #    `signature_invalid`。这里只复用它的**前两层**（验证码 / 空体 / 风控码），
    #    结构判据用本端点自己的（`user_list` 在不在）。
    from app.services.platforms.douyin import (_captcha_evidence, NOT_LOGIN_STATUS,
                                              RISK_STATUS_CODES)

    if _captcha_evidence(resp.status_code, dict(resp.headers), body):
        return PlatformHits("douyin", label, error="upstream_degraded",
                            hint="抖音要验证码/正在风控，本次不重试（本工具不绕验证码）")
    if len(body_bytes) == 0:
        return PlatformHits("douyin", label, error="not_logged_in",
                            hint=_LOGIN_HINT["douyin"])
    code = body.get("status_code")
    if isinstance(code, str) and code.strip().isdigit():
        code = int(code)
    if code in RISK_STATUS_CODES:
        return PlatformHits("douyin", label, error="upstream_degraded",
                            hint=f"抖音风控（status_code={code}），稍后再试")
    if code == NOT_LOGIN_STATUS:
        return PlatformHits("douyin", label, error="not_logged_in",
                            hint=_LOGIN_HINT["douyin"])
    data = body.get("data")
    users = (data or {}).get("user_list") if isinstance(data, dict) else body.get("user_list")
    items = []
    for entry in users or []:
        if not isinstance(entry, dict):
            continue
        # ⚠️ 每个条目**包了一层**：`{"user_info": {...}, "position": …}` —— 直接当用户对象读
        #    会一个字段都取不到（第一版就这么写的，用例当场抓到）
        u = entry.get("user_info") if isinstance(entry.get("user_info"), dict) else entry
        got = _item("douyin", u.get("sec_uid") or u.get("uid"), u.get("nickname"),
                    sign=u.get("signature"),
                    followers=int(u.get("follower_count") or 0),
                    avatar=((u.get("avatar_thumb") or {}).get("url_list") or [""])[0],
                    verified=(u.get("custom_verify") or u.get("enterprise_verify_reason") or ""))
        if got:
            items.append(got)
    if items:
        _cache_put("douyin", kw, items)
    return PlatformHits("douyin", label, items=items,
                        error=None if items else "not_found",
                        hint=None if items else "抖音没给出匹配的用户")


_SEARCHERS: dict[str, Callable[[str, int], Any]] = {
    "bilibili": _search_bilibili,
    "weibo": _search_weibo,
    "xiaohongshu": _search_xiaohongshu,
    "douyin": _search_douyin,
}


def supported_platforms() -> tuple[str, ...]:
    """哪几家支持「按名字搜人」（= 四个开关平台，顺序与设置界面一致）。"""
    return platform_switches.PLATFORMS


async def search_platform(platform: str, kw: str, *, page: int = 1) -> PlatformHits:
    """单平台检索（**总开关关着 ⇒ 一个请求都不发**）。"""
    platform = (platform or "").strip().lower()
    label = platform_switches.LABELS.get(platform, platform)
    searcher = _SEARCHERS.get(platform)
    if searcher is None:
        return PlatformHits(platform, label, error="unsupported",
                            hint=f"「{label}」暂不支持按名字搜索")
    kw = (kw or "").strip()
    if not kw:
        return PlatformHits(platform, label, error="empty_kw", hint="请输入要搜的名字")
    reason = platform_switches.disabled_reason(platform)
    if reason:
        # ⚠️ 关着是**用户的设置**，不是失败：`skipped` 与 `error` 分得开，界面文案也不同
        return PlatformHits(platform, label, skipped=True, error=None, hint=reason)
    try:
        return await searcher(kw, page)
    except Exception as e:                                     # noqa: BLE001
        # 单平台炸了不许拖垮其余（`search_all` 是并发的）：如实归类
        logger.warning("平台检索异常 platform=%s kw=%r: %s: %s",
                       platform, kw, type(e).__name__, e)
        return PlatformHits(platform, label, error="upstream_error",
                            hint=f"{label}检索出错（{type(e).__name__}）")


async def search_all(kw: str, platforms: list[str] | None = None, *,
                     page: int = 1) -> list[PlatformHits]:
    """并发搜多个平台（默认 = 四家全部；关着的会被 `search_platform` 标成 skipped）。

    ⚠️ **纯数字输入（≥5 位）只搜 B 站**：那是一条 UID（"按 UID 添加"的既有能力），
    另外三家拿数字当关键词搜只会白发三发请求、还可能把无关的人排上来。
    （判定与后端 `bili_search.looks_like_uid`、前端 `inputLooksLikeUid` 同口径。）

    顺序恒为 `platform_switches.PLATFORMS`（界面分组顺序稳定，不随完成先后跳）。
    """
    if platforms is None and bili_search.looks_like_uid((kw or "").strip()):
        platforms = ["bilibili"]
    wanted = [p for p in (platforms or list(platform_switches.PLATFORMS))
              if p in _SEARCHERS]
    if not wanted:
        return []
    hits = await asyncio.gather(*(search_platform(p, kw, page=page) for p in wanted))
    order = {p: i for i, p in enumerate(platform_switches.PLATFORMS)}
    return sorted(hits, key=lambda h: order.get(h.platform, 99))
