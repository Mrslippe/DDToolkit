"""B 站评论区抓取（对比页 · 帖子评论模式，2026-10-28）。

只做三件事：

1. **解析**用户给的链接 / BV / 动态号 → 视频或动态的 `oid`；
2. **抓取**主楼（可选楼中楼），按 uid 聚合成"评论名单"；
3. **落盘**成一份快照 JSON —— **不建表**：这类一次性外部数据不该进业务库，
   和 fan 的 raw/stats 一样按文件存，也省一次迁移。

⚠️ 抓取依赖 WBI 签名与登录态（`app/services/wbi.py`）；未登录时详情接口会失败，
这时把原因写进 `error`，**不静默降级**。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

from app.core.http import new_async_client
from app.services import wbi

logger = logging.getLogger(__name__)

API = "https://api.bilibili.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

#: 主楼最多翻多少页（20 条/页）。大帖（8 万条）按 1 页/秒要跑几小时，
#: 默认封在 150 页 = 3000 条，够做名单重叠；超出标 partial 并提示。
MAX_PAGES = 150
#: 每页条数（B 站上限 20）
PAGE_SIZE = 20
#: 楼中楼：只对"评论数最多的前 N 条主楼"抓（避免请求数爆炸）
SUB_TOP = 50
#: 请求间隔（秒）—— 评论区接口对高频很敏感
GAP_S = 0.6

BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
AV_RE = re.compile(r"av(\d+)", re.I)
DYN_RE = re.compile(r"(?:t\.bilibili\.com/|dynamic/|opus/)(\d+)")
URL_RE = re.compile(r"https?://[^\s]+")


@dataclass
class ScanState:
    """一次抓取的进度（前端只读这个结构）。"""

    scan_id: str
    input: str = ""
    state: str = "queued"  # queued|running|done|failed|cancelled
    phase: str = ""  # resolve|replies|sub|write
    page: int = 0
    pages: int = 0
    fetched: int = 0
    expected: int = 0
    partial: bool = False
    error: str = ""
    #: 说明性提示（不是错误）：例如上游只给了一部分、"其余多为已删除/折叠"
    note: str = ""
    target_kind: str = ""
    target_id: str = ""
    title: str = ""
    up_name: str = ""
    cover: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    users: list[dict[str, Any]] = field(default_factory=list)

    @property
    def elapsed(self) -> float:
        return (self.finished_at or time.time()) - self.started_at

    def as_dict(self, *, with_users: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {
            k: getattr(self, k)
            for k in (
                "scan_id", "input", "state", "phase", "page", "pages", "fetched",
                "expected", "partial", "error", "note", "target_kind", "target_id",
                "title", "up_name", "cover",
            )
        }
        out["elapsed"] = round(self.elapsed, 1)
        out["users_count"] = len(self.users)
        if with_users:
            out["users"] = self.users
        return out


# ── 风控防护（2026-10-28）─────────────────────────────────────────────
#: 全局最小间隔：跨任务共享，保证同一时刻只有一条"评论流"在跑（≈1 req/1.2s）
GLOBAL_GAP_S = 1.2
#: 风控冷却：收到 -352/-412 后，所有评论抓取暂停这么久
COOLDOWN_S = 15 * 60
#: 同帖快照复用窗口：30 分钟内重复请求直接返回旧快照（**不打网络**）
REUSE_S = 30 * 60

_throttle_lock = threading.Lock()
_last_request_at = 0.0
_cooldown_until = 0.0


class RiskControl(RuntimeError):
    """上游风控（-352/-412）。调用方应停止本轮并等待冷却。"""


def cooldown_remaining() -> int:
    """还剩多少秒冷却（0 = 不在冷却）。"""
    return max(0, int(_cooldown_until - time.time()))


def _enter_cooldown() -> None:
    global _cooldown_until
    _cooldown_until = time.time() + COOLDOWN_S
    logger.warning("触发上游风控：评论抓取冷却 %d 分钟", COOLDOWN_S // 60)


async def _throttle() -> None:
    """全局节流：保证相邻两次评论请求至少间隔 `GLOBAL_GAP_S`（跨任务）。"""
    global _last_request_at
    with _throttle_lock:
        wait = max(0.0, _last_request_at + GLOBAL_GAP_S - time.time())
        _last_request_at = time.time() + wait
    if wait > 0:
        await asyncio.sleep(wait)


def parse_target(text: str) -> tuple[str, str]:
    """用户输入 → `(kind, value)`。

    kind：`bvid` / `aid` / `dynamic` / `url`（短链等需要再解析）。
    """
    s = (text or "").strip()
    if not s:
        raise ValueError("请输入链接、BV 号或动态号")
    m = BV_RE.search(s)
    if m:
        return "bvid", m.group(1)
    m = AV_RE.search(s)
    if m:
        return "aid", m.group(1)
    m = DYN_RE.search(s)
    if m:
        return "dynamic", m.group(1)
    if URL_RE.match(s):
        return "url", s
    if s.isdigit():
        return "dynamic", s
    raise ValueError(f"认不出这个输入：{s!r}（支持 BV 号、av 号、视频/动态链接）")


#: 进程内缓存的"设备指纹"cookie（buvid3/buvid4）。评论区接口没有它就会回 `code=-352`
_SPI_COOKIE: tuple[str, float] | None = None
_SPI_TTL_S = 12 * 3600


def _auth_cookie() -> str:
    """应用里已登录的 B 站 cookie（含 SESSDATA）。

    ⚠️ 2026-10-28 实测：**未登录时评论区只返回 3 条"热门预览"**（`is_end=true`），
    看起来像"抓取成功但只有 3 条"。要拿到完整名单必须带登录态。
    这里直接复用 `auth.auth_manager`，与其余 B 站抓取同源。
    """
    try:
        from app.services import auth as _auth

        mgr = getattr(_auth, "auth_manager", None)
        if mgr is None:
            return ""
        ck = mgr.cookie_str if isinstance(mgr.cookie_str, str) else mgr.cookie_str()
        return ck if "SESSDATA=" in (ck or "") else ""
    except Exception:  # noqa: BLE001
        return ""


async def _spi_cookie(client: httpx.AsyncClient) -> str:
    """取一份 buvid 指纹 cookie 并缓存（2026-10-28）。

    `/x/v2/reply/main` 不带 `buvid3` 会直接回 **code=-352（风控校验失败）**；
    这个 cookie 不需要登录态，`x/frontend/finger/spi` 就能拿到。
    """
    global _SPI_COOKIE
    now = time.time()
    if _SPI_COOKIE and now - _SPI_COOKIE[1] < _SPI_TTL_S:
        return _SPI_COOKIE[0]
    try:
        r = await client.get(f"{API}/x/frontend/finger/spi",
                             headers={"User-Agent": UA}, timeout=20)
        d = (r.json().get("data") or {}) if r.status_code == 200 else {}
        ck = f"buvid3={d.get('b_3','')}; buvid4={d.get('b_4','')}; b_nut={int(now)}"
        if d.get("b_3"):
            _SPI_COOKIE = (ck, now)
            logger.info("已获取 buvid 指纹 cookie（%s…）", str(d.get("b_3"))[:12])
        return ck
    except Exception:  # noqa: BLE001 —— 拿不到就空着，让上层把 -352 报清楚
        return ""


async def _get(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, Any] | None = None,
    *,
    sign: bool = False,
    cookie: str = "",
) -> dict | None:
    """一次 GET（可选 WBI 签名）。失败返回 None，由调用方决定怎么报错。"""
    if cooldown_remaining():
        raise RiskControl(f"风控冷却中，还需 {cooldown_remaining() // 60} 分钟")
    await _throttle()
    try:
        p = await wbi.sign_params(dict(params or {})) if sign else dict(params or {})
        headers = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}
        # cookie 优先级：调用方传的 → 应用登录态（含 SESSDATA）→ 只有 buvid 的设备指纹。
        # 没登录时评论区只给 3 条预览（is_end=true），必须靠登录态才拿得到全量。
        ck = cookie or _auth_cookie() or await _spi_cookie(client)
        headers["Cookie"] = ck
        r = await client.get(url, params=p, headers=headers, timeout=30)
        if r.status_code != 200:
            logger.warning("bili %s → HTTP %s（%s）", url.rsplit("/", 1)[-1], r.status_code, params)
            return None
        data = r.json()
        if not isinstance(data, dict):
            logger.warning("bili %s → 非 JSON 对象", url.rsplit("/", 1)[-1])
            return None
        code = data.get("code")
        if code not in (0, None):
            if code in (-352, -412):
                _enter_cooldown()
                raise RiskControl(f"上游风控（code={code}），已冷却 {COOLDOWN_S // 60} 分钟")
            hint = ""
            logger.warning("bili %s → code=%s message=%s%s", url.rsplit("/", 1)[-1], code,
                           str(data.get("message"))[:80], hint)
        return data
    except Exception:  # noqa: BLE001 —— 网络/解析失败统一吞成 None
        return None


async def resolve_target(
    client: httpx.AsyncClient, text: str, *, cookie: str = ""
) -> dict[str, Any]:
    """输入 → `{kind, oid, title, up_name, cover, expected}`。"""
    kind, value = parse_target(text)

    if kind == "url":
        try:
            r = await client.get(
                value, headers={"User-Agent": UA}, timeout=20, follow_redirects=True
            )
            final = str(r.url)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"短链解析失败：{type(exc).__name__}") from exc
        return await resolve_target(client, final, cookie=cookie)

    if kind in ("bvid", "aid"):
        params = {"bvid": value} if kind == "bvid" else {"aid": value}
        j = await _get(client, f"{API}/x/web-interface/view", params, cookie=cookie)
        d = (j or {}).get("data") or {}
        if not d.get("aid"):
            raise ValueError("拿不到这条视频的信息（可能需要登录态，或视频不存在）")
        return {
            "kind": "video",
            "oid": str(d["aid"]),
            "title": d.get("title") or "",
            "up_name": (d.get("owner") or {}).get("name") or "",
            "cover": d.get("pic") or "",
            "expected": int((d.get("stat") or {}).get("reply") or 0),
        }

    # dynamic / opus
    j = await _get(
        client,
        f"{API}/x/polymer/web-dynamic/v1/detail",
        {"id": value, "timezone_offset": -480},
        sign=True,
        cookie=cookie,
    )
    item = ((j or {}).get("data") or {}).get("item") or {}
    oid = (item.get("basic") or {}).get("comment_id_str") or ""
    if not oid:
        raise ValueError("拿不到这条动态的信息（可能需要登录态）")
    modules = item.get("modules") or {}
    desc = (modules.get("module_dynamic") or {}).get("desc") or {}
    stat = (modules.get("module_stat") or {}).get("comment") or {}
    return {
        "kind": "dynamic",
        "oid": str(oid),
        "title": desc.get("text") or "动态",
        "up_name": (modules.get("module_author") or {}).get("name") or "",
        "cover": "",
        "expected": int(stat.get("count") or 0),
    }


async def fetch_users(
    client: httpx.AsyncClient,
    kind: str,
    oid: str,
    *,
    with_sub: bool,
    state: ScanState,
    should_stop: Callable[[], bool] | None = None,
    cookie: str = "",
    max_pages: int = MAX_PAGES,
) -> list[dict[str, Any]]:
    """分页抓主楼（可选楼中楼），按 uid 聚合成评论名单。"""
    rtype = "1" if kind == "video" else "11"
    seen: dict[str, dict[str, Any]] = {}
    state.phase = "replies"

    def add(uid: str, name: str, ms: int | None, *, sub: bool) -> None:
        u = seen.get(uid)
        if u is None:
            u = seen[uid] = {
                "uid": uid, "name": name, "cnt": 0, "sub_cnt": 0,
                "first_ms": None, "last_ms": None, "is_up": False,
            }
        if name and not u["name"]:
            u["name"] = name
        if sub:
            u["sub_cnt"] += 1
        else:
            u["cnt"] += 1
            if ms is not None:
                u["first_ms"] = ms if u["first_ms"] is None else min(u["first_ms"], ms)
                u["last_ms"] = ms if u["last_ms"] is None else max(u["last_ms"], ms)

    page = 1
    cursor: int | None = None
    while page <= max_pages:
        if should_stop and should_stop():
            state.state = "cancelled"
            break
        # ⚠️ 用 `/x/v2/reply/main`（带 cursor）而不是老的 `/x/v2/reply`：
        # 2026-10-28 实测老接口对未登录请求返回 code=0 但 **replies 为空**，
        # 表现成"抓取成功但一条没有"，很难查。
        params: dict[str, Any] = {"type": rtype, "oid": oid, "mode": 3, "ps": PAGE_SIZE}
        if cursor is not None:
            params["next"] = cursor
        j = await _get(client, f"{API}/x/v2/reply/main", params, cookie=cookie)
        d = (j or {}).get("data") or {}
        cur = d.get("cursor") or {}
        replies = d.get("replies") or []
        if not state.expected:
            state.expected = int(cur.get("all_count") or 0)
            if state.expected:
                state.pages = min(max_pages, max(1, -(-state.expected // PAGE_SIZE)))
        logger.info("评论第 %d 页：%d 条（all_count=%s is_end=%s）",
                    page, len(replies), cur.get("all_count"), cur.get("is_end"))
        if not replies:
            if not _auth_cookie():
                state.error = state.error or (
                    "未登录 B 站：评论区接口只返回热门预览（3 条）。"
                    "请在设置里登录 B 站账号后再抓取。")
            if page == 1:
                logger.warning("第 1 页就是空的：oid=%s type=%s（可能被风控或接口变了）", oid, rtype)
                state.error = state.error or "上游第 1 页就没有评论（可能被风控或帖子已关闭评论）"
            break
        for r in replies:
            member = r.get("member") or {}
            mid = str(member.get("mid") or "")
            if not mid:
                continue
            ms = int(r.get("ctime") or 0) * 1000 or None
            add(mid, member.get("uname") or "", ms, sub=False)
            state.fetched += 1

        if with_sub and page == 1:
            top = sorted(replies, key=lambda r: int(r.get("rcount") or 0), reverse=True)[:SUB_TOP]
            state.phase = "sub"
            for r in top:
                if should_stop and should_stop():
                    break
                root = str(r.get("rpid_str") or r.get("rpid") or "")
                if not root:
                    continue
                sj = await _get(
                    client,
                    f"{API}/x/v2/reply/reply",
                    {"type": rtype, "oid": oid, "root": root, "ps": PAGE_SIZE, "pn": 1},
                    cookie=cookie,
                )
                for sub in ((sj or {}).get("data") or {}).get("replies") or []:
                    member = sub.get("member") or {}
                    smid = str(member.get("mid") or "")
                    if smid:
                        add(smid, member.get("uname") or "", None, sub=True)
            state.phase = "replies"

        state.page = page
        if cur.get("is_end"):
            break
        nxt = cur.get("next")
        if not nxt:
            break
        cursor = int(nxt)
        page += 1
        await asyncio.sleep(GAP_S)

    if state.expected and state.fetched < state.expected:
        state.partial = True
        if not state.note:
            state.note = (
                f"上游只返回 {state.fetched}/{state.expected} 条："
                "差额多为已删除、被折叠或审核中的评论（接口翻到 is_end 也拿不到）")
        if not state.error and page > max_pages:
            state.error = f"只抓到前 {max_pages} 页（{state.fetched}/{state.expected} 条），已标为部分数据"
    state.users = sorted(seen.values(), key=lambda u: (-u["cnt"], -u["sub_cnt"]))
    return state.users


def _scan_dir(root: Path) -> Path:
    d = root / "_compare" / "scans"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _index_path(root: Path) -> Path:
    return _scan_dir(root) / "index.json"


def find_recent(root: Path, kind: str, oid: str, *, max_age_s: int = REUSE_S) -> dict[str, Any] | None:
    """同一 `(kind, oid)` 在 `max_age_s` 内抓过就复用快照（避免重复深分页 → 风控）。"""
    try:
        idx = json.loads(_index_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    item = (idx.get(f"{kind}:{oid}") or {})
    saved_at = float(item.get("saved_at") or 0)
    if not saved_at or time.time() - saved_at > max_age_s:
        return None
    snap = load(str(item.get("scan_id") or ""), root)
    if not snap or snap.get("state") != "done":
        return None
    logger.info("复用 30 分钟内的同帖快照：%s:%s → %s", kind, oid, snap.get("scan_id"))
    return snap


def find_recent_by_input(root: Path, text: str, *, max_age_s: int = REUSE_S) -> dict[str, Any] | None:
    """按"用户输入原文"复用快照（同帖 30 分钟内不重复打网络）。"""
    try:
        idx = json.loads(_index_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    item = (idx.get(f"input:{(text or '').strip()}") or {})
    saved_at = float(item.get("saved_at") or 0)
    if not saved_at or time.time() - saved_at > max_age_s:
        return None
    snap = load(str(item.get("scan_id") or ""), root)
    if not snap or snap.get("state") != "done":
        return None
    logger.info("复用 30 分钟内的同帖快照（按输入）：%r → %s", text, snap.get("scan_id"))
    return snap


def _remember(root: Path, state: ScanState) -> None:
    if state.state != "done" or not state.target_id:
        return
    path = _index_path(root)
    try:
        idx = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except (OSError, ValueError):
        idx = {}
    stamp = {"scan_id": state.scan_id, "saved_at": time.time()}
    idx[f"{state.target_kind}:{state.target_id}"] = stamp
    # 同时按"用户输入的原文"记一份：这样**再点一次同样的链接**也能直接复用，
    # 不用先解析一次 oid（解析本身也是一次请求，会加重风控）。
    if state.input:
        idx[f"input:{state.input.strip()}"] = stamp
    path.write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")


def save(state: ScanState, root: Path) -> Path:
    path = _scan_dir(root) / f"{state.scan_id}.json"
    tmp = path.with_name(path.name + ".tmp")
    payload = state.as_dict(with_users=True)
    payload["saved_at"] = time.time()
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    _remember(root, state)
    return path


def load(scan_id: str, root: Path) -> dict[str, Any] | None:
    path = _scan_dir(root) / f"{scan_id}.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


async def run_scan(
    text: str,
    *,
    root: Path,
    with_sub: bool = True,
    state: ScanState | None = None,
    should_stop: Callable[[], bool] | None = None,
    cookie: str = "",
    max_pages: int = MAX_PAGES,
) -> ScanState:
    """完整跑一次：解析 → 抓取 → 落盘。**不抛异常**，失败写进 `state.error`。"""
    st = state or ScanState(scan_id=uuid.uuid4().hex[:12], input=text)
    st.input = text
    st.state = "running"
    logger.info("评论抓取开始：input=%r with_sub=%s scan_id=%s", text, with_sub, st.scan_id)
    async with new_async_client() as client:
        try:
            st.phase = "resolve"
            info = await resolve_target(client, text, cookie=cookie)
            st.target_kind = info["kind"]
            st.target_id = info["oid"]
            st.title = info.get("title") or ""
            st.up_name = info.get("up_name") or ""
            st.cover = info.get("cover") or ""
            st.expected = int(info.get("expected") or 0)
            logger.info("解析成功：kind=%s oid=%s title=%r expected=%d",
                        st.target_kind, st.target_id, st.title[:40], st.expected)
            await fetch_users(
                client, st.target_kind, st.target_id,
                with_sub=with_sub, state=st, should_stop=should_stop, cookie=cookie,
                max_pages=max_pages,
            )
            if st.state != "cancelled":
                st.state = "done"
                st.phase = "write"
        except Exception as exc:  # noqa: BLE001 —— 统一兜成可展示的原因
            st.state = "failed"
            st.error = str(exc) or type(exc).__name__
            logger.warning("评论抓取失败：%s（scan_id=%s）", st.error, st.scan_id)
        finally:
            st.finished_at = time.time()
            save(st, root)
            logger.info("评论抓取结束：state=%s 抓取 %d 条 / 期望 %s · 用户 %d · %.1fs",
                        st.state, st.fetched, st.expected or "?", len(st.users), st.elapsed)
    return st
