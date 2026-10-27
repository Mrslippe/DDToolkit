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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

from app.core.http import new_async_client
from app.services import wbi

API = "https://api.bilibili.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

#: 主楼最多翻多少页（20 条/页 → 2 万条封顶）
MAX_PAGES = 1000
#: 每页条数（B 站上限 20）
PAGE_SIZE = 20
#: 楼中楼：只对"评论数最多的前 N 条主楼"抓（避免请求数爆炸）
SUB_TOP = 50
#: 请求间隔（秒）—— 评论区接口对高频很敏感
GAP_S = 1.2

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
                "expected", "partial", "error", "target_kind", "target_id",
                "title", "up_name", "cover",
            )
        }
        out["elapsed"] = round(self.elapsed, 1)
        out["users_count"] = len(self.users)
        if with_users:
            out["users"] = self.users
        return out


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


async def _get(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, Any] | None = None,
    *,
    sign: bool = False,
    cookie: str = "",
) -> dict | None:
    """一次 GET（可选 WBI 签名）。失败返回 None，由调用方决定怎么报错。"""
    try:
        p = await wbi.sign_params(dict(params or {})) if sign else dict(params or {})
        headers = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}
        if cookie:
            headers["Cookie"] = cookie
        r = await client.get(url, params=p, headers=headers, timeout=30)
        if r.status_code != 200:
            return None
        data = r.json()
        return data if isinstance(data, dict) else None
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
    total_pages = 0
    while page <= MAX_PAGES:
        if should_stop and should_stop():
            state.state = "cancelled"
            break
        j = await _get(
            client,
            f"{API}/x/v2/reply",
            {"type": rtype, "oid": oid, "sort": 0, "ps": PAGE_SIZE, "pn": page},
            cookie=cookie,
        )
        d = (j or {}).get("data") or {}
        replies = d.get("replies") or []
        if not total_pages:
            state.expected = int((d.get("page") or {}).get("count") or state.expected or 0)
            if state.expected:
                total_pages = max(1, -(-state.expected // PAGE_SIZE))
                state.pages = min(total_pages, MAX_PAGES)
        if not replies:
            break
        for r in replies:
            member = r.get("member") or {}
            mid = str(member.get("mid") or "")
            if not mid:
                continue
            ms = int(r.get("ctime") or 0) * 1000 or None
            add(mid, member.get("uname") or "", ms, sub=False)
            state.fetched += 1

        # 楼中楼：只给"评论数最多的前 SUB_TOP 条主楼"抓，避免请求数爆炸
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
        page += 1
        await asyncio.sleep(GAP_S)

    if state.expected and state.fetched < state.expected:
        state.partial = True
    state.users = sorted(seen.values(), key=lambda u: (-u["cnt"], -u["sub_cnt"]))
    return state.users


def _scan_dir(root: Path) -> Path:
    d = root / "_compare" / "scans"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save(state: ScanState, root: Path) -> Path:
    path = _scan_dir(root) / f"{state.scan_id}.json"
    tmp = path.with_name(path.name + ".tmp")
    payload = state.as_dict(with_users=True)
    payload["saved_at"] = time.time()
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
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
) -> ScanState:
    """完整跑一次：解析 → 抓取 → 落盘。**不抛异常**，失败写进 `state.error`。"""
    st = state or ScanState(scan_id=uuid.uuid4().hex[:12], input=text)
    st.input = text
    st.state = "running"
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
            await fetch_users(
                client, st.target_kind, st.target_id,
                with_sub=with_sub, state=st, should_stop=should_stop, cookie=cookie,
            )
            if st.state != "cancelled":
                st.state = "done"
                st.phase = "write"
        except Exception as exc:  # noqa: BLE001 —— 统一兜成可展示的原因
            st.state = "failed"
            st.error = str(exc) or type(exc).__name__
        finally:
            st.finished_at = time.time()
            save(st, root)
    return st
