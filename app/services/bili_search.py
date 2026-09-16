"""B 站用户检索：给「添加 V」提供候选池之外的在线来源（R11，devlog/083）。

## 为什么需要它

添加 V 原来只有一条路：本地候选池（`vtubers.csv` 离线快照）⇒ 池里没有的新 V / 小 V
根本加不进来。本模块让用户能**直接按 UID 或名称从 B 站取**。

## 两条路径（口径不同，别混）

| 输入 | 路径 | 请求数 | 说明 |
|---|---|---|---|
| 纯数字（≥5 位） | `x/space/wbi/acc/info` 精确查 UID（+ `x/relation/stat` 取粉丝数） | 2 | B 站**搜索接口搜不到 uid**（实测 `keyword=1265680561` → 0 条），所以数字必须直查 |
| 其余 | `wbi/search/type?search_type=bili_user` | 1/页 | 用户搜索；每页 20 条，最多翻 `MAX_PAGE` 页 |

## 实测结论（2026-09-14 首测，2026-09-15 复核并**更正一处**）

- **必须带"搜索页"请求头**（`Referer: https://search.bilibili.com/upuser?keyword=…` +
  `Origin` + `Accept`）：不带时首轮 `code=-1200 被降级过滤`；**极简头下更坑 —— `code=0` 但静默
  0 条**（连"永雏塔菲"都搜不到）。带上之后命中稳定，首位就是目标 V。
- ⚠️ **需要 B 站登录态**（2026-09-15 更正）：搜索接口本身不校验 cookie，但**WBI 签名密钥要从
  `x/web-interface/nav` 取，而该接口未登录直接回 -101「账号未登录」** ⇒ 没登录时
  `wbi.sign_params()` 抛错，模糊搜与 uid 直查**都会失败**。
  首次测量得出"不需要登录"是**测错了**：那次的进程里 WBI 密钥已缓存（`wbi._cached_keys`，
  或数据目录里带着已登录的 `.env`）⇒ 复现口径必须用**空数据目录 + 全新进程**。
  因此这里把签名失败显式映射成 `error='not_logged_in'` + `LOGIN_HINT`（而不是让异常冒到 500）。
- 2026-09-15 复核（真打上游）：登录态下 `塔菲` → **20 条 / 50 页**、`uid=1265680561` →
  1 条「永雏塔菲」；空数据目录 → `not_logged_in`。
- 连打 5 次（0.6s 间隔）零风控；本模块仍按 `MIN_INTERVAL` 串行 + 每分钟上限收敛。

## 节流与缓存（都不持有 loop-bound 原语 —— devlog/076 的不变量）

- `_MIN_INTERVAL`：两次上游调用之间的**最小间隔**（排队等待，锁外 sleep）；
- `_MAX_PER_MINUTE`：滑动一分钟窗口上限，超了直接返回 `rate_limited`（不排队，避免堆积）；
- `(kw, page)` 结果缓存 `CACHE_TTL` 秒：同一关键词反复搜（含前端重试）不打上游。
"""
from __future__ import annotations

import asyncio
import html
import logging
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass, field

import httpx

from app.core.http import new_async_client
from app.core.useragent import UA_EDGE
from app.services.auth import auth_manager
from app.services.fetcher import fetch_bilibili_user_info, fetch_bilibili_user_stat
from app.services import wbi

logger = logging.getLogger(__name__)

SEARCH_URL = "https://api.bilibili.com/x/web-interface/wbi/search/type"
SEARCH_REFERER = "https://search.bilibili.com/upuser?keyword="
UA = UA_EDGE        # R26③：UA 全仓单一来源（core/http），发版时刷新那一处大版本号

MIN_INTERVAL = 0.8          # 两次上游调用最小间隔（秒）
MAX_PER_MINUTE = 20         # 每分钟上游调用上限
CACHE_TTL = 300.0           # 结果缓存秒数
CACHE_MAX = 64
MAX_PAGE = 3                # 允许翻到第几页（第 1 页 + 加载更多 2 次）

LOGIN_HINT = ("B 站检索需要登录态：WBI 签名密钥要从 nav 接口取，未登录时该接口回 -101 —— "
              "请先在顶栏登录 B 站再试（uid 直查同样需要）")

_TAG_RE = re.compile(r"<[^>]+>")

# ── 节流状态（threading.Lock + 时刻表：**不能**用 asyncio.Lock，见模块 docstring）──
_gate = threading.Lock()
_last_call = [0.0]
_recent: list[float] = []

# ── 结果缓存 ──
_cache: dict[tuple[str, int], tuple[list[dict], int, float]] = {}


@dataclass
class SearchResult:
    """检索结果（前端直接消费；error 非空时 items 必为空）。"""
    items: list[dict] = field(default_factory=list)
    page: int = 1
    total_pages: int = 0
    has_more: bool = False
    error: str | None = None
    hint: str | None = None
    exact: bool = False
    cached: bool = False


def looks_like_uid(kw: str) -> bool:
    """纯数字且 ≥5 位 → 按 UID 直查。

    为什么是 5 位：B 站早期 uid 有 5~6 位的（如 896830）；再短的数字更可能是
    名字里带数字（"1234"），按名称搜更合理。
    """
    kw = (kw or "").strip()
    return kw.isdigit() and 5 <= len(kw) <= 12


def strip_highlight(s: str | None) -> str:
    """剥掉搜索结果的 `<em class="keyword">` 高亮标签并反转义（实测 `uname`/`usign` 会带）。"""
    if not s:
        return ""
    return html.unescape(_TAG_RE.sub("", s)).strip()


def _avatar(url: str | None) -> str:
    """搜索结果里 `upic` 是协议相对地址（`//i0.hdslb.com/...`）→ 补 https。"""
    if not url:
        return ""
    return url if url.startswith("http") else f"https:{url}"


def _headers(kw: str) -> dict:
    """搜索页请求头（**必须**：见模块 docstring 的实测）；有登录态就带上 Cookie。"""
    h = {
        "User-Agent": UA,
        "Referer": SEARCH_REFERER + urllib.parse.quote(kw),
        "Origin": "https://search.bilibili.com",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if auth_manager.cookie_str:
        h["Cookie"] = auth_manager.cookie_str
    return h


def map_search_item(raw: dict) -> dict | None:
    """搜索结果条目 → 本仓统一形状；缺 mid 的条目丢弃（脏数据）。"""
    mid = raw.get("mid")
    if not mid:
        return None
    verify = raw.get("official_verify") or {}
    return {
        "platform": "bilibili",
        "platform_uid": str(mid),
        "name": strip_highlight(raw.get("uname")) or str(mid),
        "sign": strip_highlight(raw.get("usign")),
        "followers": int(raw.get("fans") or 0),
        "avatar": _avatar(raw.get("upic")),
        "verified": strip_highlight(verify.get("desc")),
        "is_live": bool(raw.get("is_live")),
        "room_id": str(raw["room_id"]) if raw.get("room_id") else None,
        "videos": int(raw.get("videos") or 0),
        "level": int(raw.get("level") or 0),
        "exact": False,
    }


# ── 节流 ──────────────────────────────────────────────────────────────

async def _acquire_slot() -> str | None:
    """占一个上游调用名额：放行返回 None，超频返回 `rate_limited`。"""
    while True:
        with _gate:
            now = time.monotonic()
            while _recent and now - _recent[0] > 60.0:
                _recent.pop(0)
            if len(_recent) >= MAX_PER_MINUTE:
                logger.warning(f"B 站检索超出每分钟上限（{MAX_PER_MINUTE}），本轮拒绝")
                return "rate_limited"
            wait = _last_call[0] + MIN_INTERVAL - now
            if wait <= 0:
                _last_call[0] = now
                _recent.append(now)
                return None
        # 锁外等待：不持锁 sleep（也避免把别人堵在锁上）
        await asyncio.sleep(min(wait, 1.0))


def _cache_get(kw: str, page: int) -> tuple[list[dict], int] | None:
    hit = _cache.get((kw.lower(), page))
    if not hit:
        return None
    items, pages, at = hit
    if time.monotonic() - at > CACHE_TTL:
        _cache.pop((kw.lower(), page), None)
        return None
    return items, pages


def _cache_put(kw: str, page: int, items: list[dict], pages: int) -> None:
    if len(_cache) >= CACHE_MAX:
        _cache.pop(next(iter(_cache)), None)      # 插入顺序淘汰
    _cache[(kw.lower(), page)] = (items, pages, time.monotonic())


def clear_cache() -> None:
    """清空缓存与节流窗口（测试用）。"""
    with _gate:
        _cache.clear()
        _recent.clear()
        _last_call[0] = 0.0


# ── 两条路径 ──────────────────────────────────────────────────────────

def _sign_failure(exc: Exception, what: str) -> dict:
    """WBI 签名失败的归类（未登录 vs 其它）。

    `nav` 未登录回 -101「账号未登录」，`wbi.get_wbi_keys` 把它包成 `Exception` 抛出 ——
    靠消息判定不优雅，但比"整类都报未登录"准确：别的签名错误不该给出"去登录"的误导。

    ⚠️ 2026-09-15 起**检索路径已放行匿名签名**（`allow_anonymous=True`），所以这里
    通常只在"匿名也拿不到 wbi_img"或真正的签名故障时触发；文案保持短（异常原文进日志）。
    """
    msg = str(exc)
    if "未登录" in msg or "-101" in msg:
        logger.info(f"B 站检索需要登录态（{what}）：{msg}")
        return {"error": "not_logged_in", "hint": LOGIN_HINT}
    logger.warning(f"B 站检索签名失败（{what}）：{type(exc).__name__}: {msg}")
    return {"error": "upstream_error", "hint": f"取 WBI 签名失败（{type(exc).__name__}），稍后重试"}


async def search_users(kw: str, page: int = 1,
                       client: httpx.AsyncClient | None = None) -> SearchResult:
    """按名称搜索 UP 主（第 `page` 页，1-based；超过 `MAX_PAGE` 不请求，直接说明）。"""
    kw = (kw or "").strip()
    if not kw:
        return SearchResult(error="empty_kw")
    if page > MAX_PAGE:
        return SearchResult(page=page, error="page_limit",
                            hint=f"只支持翻到第 {MAX_PAGE} 页（避免打上游太频繁）")
    hit = _cache_get(kw, page)
    if hit is not None:
        items, pages = hit
        return SearchResult(items=items, page=page, total_pages=pages,
                            has_more=page < pages and page < MAX_PAGE, cached=True)

    limited = await _acquire_slot()
    if limited:
        return SearchResult(page=page, error=limited,
                            hint="请求太频繁，稍后再试或改用候选池")

    # WBI 签名（要 nav 取密钥 ⇒ **未登录会抛**，除非允许匿名）。
    # `allow_anonymous=True`：2026-09-15 实测 nav 匿名也下发 wbi_img，检索类接口
    # 匿名可用（`capabilities.py` 的矩阵）；空间内容接口不能用这条口子（平台 412）。
    try:
        params = await wbi.sign_params({"search_type": "bili_user", "keyword": kw,
                                        "page": page}, allow_anonymous=True)
    except Exception as e:                                   # noqa: BLE001
        return SearchResult(page=page, **_sign_failure(e, kw))
    url = f"{SEARCH_URL}?{urllib.parse.urlencode(params)}"
    own = client is None
    try:
        http = client or new_async_client(15.0)
        try:
            resp = await http.get(url, headers=_headers(kw))
        finally:
            if own:
                await http.aclose()
    except Exception as e:                                   # noqa: BLE001
        logger.warning(f"B 站检索请求失败 kw={kw!r}: {type(e).__name__}: {e}")
        return SearchResult(page=page, error="network_error",
                            hint="网络异常，稍后重试或改用候选池")

    try:
        body = resp.json()
    except ValueError:
        return SearchResult(page=page, error="network_error", hint="上游返回非 JSON")
    code = body.get("code")
    if code in (-1200, -352):
        # 实测：缺搜索页请求头时会出现 -1200「被降级过滤」；-352 是风控
        logger.warning(f"B 站检索被降级/风控 kw={kw!r} code={code} msg={body.get('message')!r}")
        return SearchResult(page=page, error="upstream_degraded",
                            hint="B 站对本次检索做了限制（风控/降级），稍后重试或改用候选池")
    if code != 0:
        logger.warning(f"B 站检索错误 kw={kw!r} code={code} msg={body.get('message')!r}")
        return SearchResult(page=page, error="upstream_error",
                            hint=f"上游返回 code={code}")
    data = body.get("data") or {}
    raw_items = data.get("result") or []
    items = [m for m in (map_search_item(r) for r in raw_items) if m]
    pages = int(data.get("numPages") or 0)
    # ⚠️ code=0 也可能"静默 0 条"（实测缺请求头时）——不当成正常空结果，给一句可重试提示
    hint = ("没有匹配的 UP 主；若确信存在，可能是上游偶发降级，可稍后重试"
            if not items and not raw_items else None)
    if items:
        _cache_put(kw, page, items, pages)
    return SearchResult(items=items, page=page, total_pages=pages,
                        has_more=bool(items) and page < min(pages or 1, MAX_PAGE),
                        error=None if items else "not_found", hint=hint)


async def exact_user(uid: str, client: httpx.AsyncClient | None = None) -> SearchResult:
    """按 UID 精确取人（`acc/info` + `relation/stat`；搜索接口搜不到 uid，必须直查）。"""
    uid = (uid or "").strip()
    if not looks_like_uid(uid):
        return SearchResult(error="bad_uid", hint="UID 必须是 5~12 位数字")
    hit = _cache_get(f"uid:{uid}", 1)
    if hit is not None:
        return SearchResult(items=hit[0], page=1, exact=True, cached=True)

    limited = await _acquire_slot()
    if limited:
        return SearchResult(error=limited, hint="请求太频繁，稍后再试")

    # `acc/info` / `relation/stat`：`acc/info` 是 WBI 签名接口 ⇒ 未登录会抛，
    # 因此这里显式放行匿名签名（与名称搜索同口径）。
    # ⚠️ `fetch_bilibili_user_info` 外面套着 tenacity（`retry_if_result(is_none)`）：
    # **上游拒绝**（风控 -352 / 412）会让它返回 None、重试耗尽后抛 `RetryError` ——
    # 那是"平台拒绝了这次查询"，不是"签名坏了"，归类要分开（否则提示会误导用户去查密钥）。
    try:
        info = await fetch_bilibili_user_info(int(uid), client=client, allow_anonymous=True)
    except Exception as e:                                   # noqa: BLE001
        if "RetryError" in type(e).__name__ or "RetryError" in str(e):
            logger.info(f"B 站 uid={uid} 匿名查询被上游拒绝（风控）：{type(e).__name__}")
            return SearchResult(page=1, exact=True, error="upstream_degraded",
                                hint="B 站拒绝了本次查询（风控/限流），稍后重试；登录后更稳定")
        return SearchResult(page=1, exact=True, **_sign_failure(e, f"uid:{uid}"))
    if not info:
        return SearchResult(error="not_found", hint=f"B 站没有这个 UID（{uid}）或该用户已注销")
    try:
        stat = await fetch_bilibili_user_stat(int(uid), client=client) or {}
    except Exception as e:                                   # noqa: BLE001
        # 粉丝数取不到不算失败：名字已经有了，收录/展示不依赖它
        logger.info(f"B 站 uid={uid} 粉丝数取数失败：{type(e).__name__}: {e}")
        stat = {}
    item = {
        "platform": "bilibili",
        "platform_uid": uid,
        "name": info.get("name") or uid,
        "sign": info.get("sign") or "",
        "followers": int(stat.get("follower") or 0),
        "avatar": _avatar(info.get("avatar")),
        "verified": "",
        "is_live": (info.get("live_status") or 0) == 1,
        "room_id": str(info["room_id"]) if info.get("room_id") else None,
        "videos": 0,
        "level": 0,
        "exact": True,
    }
    _cache_put(f"uid:{uid}", 1, [item], 1)
    return SearchResult(items=[item], page=1, exact=True)


async def search(kw: str, page: int = 1,
                 client: httpx.AsyncClient | None = None) -> SearchResult:
    """统一入口：数字 → 精确路径；其余 → 名称搜索（路由与 adopt 复核都用它）。"""
    kw = (kw or "").strip()
    if looks_like_uid(kw):
        return await exact_user(kw, client=client)
    return await search_users(kw, page=page, client=client)
