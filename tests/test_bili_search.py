# -*- coding: utf-8 -*-
"""B 站检索（R11，devlog/083）：UID 分流 / 名称搜索 / 缓存 / 节流 / 错误映射 / adopt 复核。

上游用 `httpx.MockTransport` 打桩，**不发真实请求**；`acc/info` 与 `relation/stat`
走 `fetch_bilibili_user_info/stat` 的 monkeypatch。
"""
import asyncio
import json
import urllib.parse

import httpx
import pytest

from app.services import bili_search


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """每个用例前后清缓存与节流窗口（模块级状态，别互相串）。"""
    bili_search.clear_cache()
    yield
    bili_search.clear_cache()


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _search_body(items: list[dict], pages: int = 3) -> dict:
    return {"code": 0, "message": "OK",
            "data": {"result": items, "numResults": len(items) * 20, "numPages": pages}}


def _raw(mid: int, uname: str, **kw) -> dict:
    return {"type": "bili_user", "mid": mid, "uname": uname,
            "usign": kw.get("usign", ""), "fans": kw.get("fans", 100),
            "upic": kw.get("upic", "//i0.hdslb.com/bfs/face/x.jpg"),
            "videos": kw.get("videos", 3), "level": kw.get("level", 6),
            "is_live": kw.get("is_live", 0), "room_id": kw.get("room_id", 0),
            "official_verify": {"type": 0, "desc": kw.get("verified", "")}}


# ── 纯函数 ────────────────────────────────────────────────────────────

def test_looks_like_uid_only_for_pure_digits_of_reasonable_length():
    """数字分流判据：纯数字且 5~12 位才当 UID（B 站早期 uid 有 5~6 位的）。"""
    assert bili_search.looks_like_uid("1265680561") is True
    assert bili_search.looks_like_uid("896830") is True        # 早期 6 位
    assert bili_search.looks_like_uid("1234") is False         # 太短 → 更可能是名字里的数字
    assert bili_search.looks_like_uid("塔菲") is False
    assert bili_search.looks_like_uid("1265680561a") is False
    assert bili_search.looks_like_uid("") is False


def test_strip_highlight_and_unescape():
    """搜索结果的 uname/usign 带 `<em class="keyword">` 高亮 → 剥标签 + 反转义。"""
    assert bili_search.strip_highlight('永雏<em class="keyword">塔菲</em>') == "永雏塔菲"
    assert bili_search.strip_highlight("a &amp; b") == "a & b"
    assert bili_search.strip_highlight(None) == ""


def test_map_search_item_normalizes_fields():
    """字段归一化：头像补 https、mid 缺失丢弃、认证与直播字段对齐。"""
    it = bili_search.map_search_item(_raw(1265680561, "永雏塔菲",
                                          verified="bilibili 知名游戏UP主",
                                          is_live=1, room_id=22603245))
    assert it["platform_uid"] == "1265680561"
    assert it["avatar"] == "https://i0.hdslb.com/bfs/face/x.jpg"
    assert it["verified"] == "bilibili 知名游戏UP主"
    assert it["is_live"] is True and it["room_id"] == "22603245"
    assert bili_search.map_search_item({"uname": "没有 mid"}) is None


# ── 名称搜索路径 ──────────────────────────────────────────────────────

def test_search_users_sends_search_page_headers():
    """**必须带搜索页请求头**：缺了会 `-1200 降级过滤` 或静默 0 条（实测，devlog/083）。"""
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["referer"] = req.headers.get("referer", "")
        seen["origin"] = req.headers.get("origin", "")
        seen["accept"] = req.headers.get("accept", "")
        seen["ua"] = req.headers.get("user-agent", "")
        return httpx.Response(200, json=_search_body([_raw(1, "永雏塔菲")]))

    async def run():
        async with _client(handler) as c:
            return await bili_search.search_users("塔菲", client=c)

    res = asyncio.run(run())
    assert res.error is None and len(res.items) == 1
    assert seen["referer"].startswith("https://search.bilibili.com/upuser?keyword=")
    # 关键词按 URL 编码进 Referer（中文关键词 → %E5%A1%94%E8%8F%B2），与真实搜索页一致
    assert urllib.parse.quote("塔菲") in seen["referer"]
    assert seen["origin"] == "https://search.bilibili.com"
    assert "application/json" in seen["accept"] and "Mozilla" in seen["ua"]


def test_search_users_caches_and_skips_second_upstream_call():
    """同关键词第二页也不同？不 —— 同一 (kw,page) 走缓存，**不打第二次上游**。"""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=_search_body([_raw(1, "永雏塔菲")]))

    async def run():
        async with _client(handler) as c:
            first = await bili_search.search_users("塔菲", client=c)
            second = await bili_search.search_users("塔菲", client=c)
            return first, second

    first, second = asyncio.run(run())
    assert calls["n"] == 1
    assert first.cached is False and second.cached is True
    assert [i["platform_uid"] for i in first.items] == [i["platform_uid"] for i in second.items]


def test_search_users_maps_degraded_and_rate_limit_codes():
    """`-1200`（降级过滤）/`-352`（风控）→ upstream_degraded；其它 code → upstream_error。"""
    def make(code: int):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"code": code, "message": "被降级过滤的请求"})
        return handler

    async def run(code: int):
        async with _client(make(code)) as c:
            bili_search.clear_cache()
            return await bili_search.search_users(f"kw{code}", client=c)

    for code in (-1200, -352):
        res = asyncio.run(run(code))
        assert res.error == "upstream_degraded", code
        assert res.items == [] and res.hint and "重试" in res.hint
    res = asyncio.run(run(-404))
    assert res.error == "upstream_error" and res.items == []


def test_search_users_empty_result_is_not_silent_success():
    """`code=0` 且 0 条 → `not_found` + 可重试提示（实测缺请求头会**静默 0 条**）。"""
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_search_body([]))

    async def run():
        async with _client(handler) as c:
            return await bili_search.search_users("查无此人", client=c)

    res = asyncio.run(run())
    assert res.items == []
    assert res.error == "not_found"
    assert res.hint and "重试" in res.hint


def test_search_users_page_limit_and_min_interval():
    """翻页上限：超过 MAX_PAGE 直接不请求；节流：两次上游调用间隔 ≥ MIN_INTERVAL。"""
    import time as _time

    stamps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        stamps.append(_time.monotonic())
        return httpx.Response(200, json=_search_body([_raw(1, "x")]))

    async def run():
        async with _client(handler) as c:
            over = await bili_search.search_users("塔菲", page=bili_search.MAX_PAGE + 1, client=c)
            await bili_search.search_users("关键词A", client=c)
            await bili_search.search_users("关键词B", client=c)
            return over

    over = asyncio.run(run())
    assert over.error == "page_limit" and over.items == []
    assert len(stamps) == 2, "超页那次不该发请求"
    assert stamps[1] - stamps[0] >= bili_search.MIN_INTERVAL * 0.9


# ── UID 精确路径 ──────────────────────────────────────────────────────

def test_exact_user_merges_info_and_stat(monkeypatch):
    """UID 直查：`acc/info`（名字/签名/头像）+ `relation/stat`（粉丝数）合并成一条 exact 结果。"""
    async def fake_info(mid, client=None, allow_anonymous=False):
        return {"name": "永雏塔菲", "sign": "王牌级偶像", "avatar": "https://x/a.jpg",
                "live_status": 1, "room_id": 22603245}

    async def fake_stat(mid, client=None):
        return {"follower": 2753531}

    from app.services import bili_search as bs
    monkeypatch.setattr(bs, "fetch_bilibili_user_info", fake_info)
    monkeypatch.setattr(bs, "fetch_bilibili_user_stat", fake_stat)

    res = asyncio.run(bs.exact_user("1265680561"))
    assert res.exact is True and len(res.items) == 1
    it = res.items[0]
    assert (it["platform_uid"], it["name"], it["followers"]) == ("1265680561", "永雏塔菲", 2753531)
    assert it["is_live"] is True and it["room_id"] == "22603245"


def test_exact_user_not_found_and_bad_uid(monkeypatch):
    """查不到 / UID 不合法：都给明确 error，不让前端以为"搜到但没显示"。"""
    from app.services import bili_search as bs

    async def fake_none(mid, client=None, allow_anonymous=False):
        return None
    monkeypatch.setattr(bs, "fetch_bilibili_user_info", fake_none)
    res = asyncio.run(bs.exact_user("99999999"))
    assert res.error == "not_found" and res.items == []

    res2 = asyncio.run(bs.exact_user("123"))
    assert res2.error == "bad_uid"


def test_search_dispatches_numeric_to_exact(monkeypatch):
    """统一入口：纯数字走精确路径（名称搜索接口搜不到 uid —— 实测 0 条）。"""
    from app.services import bili_search as bs
    called = {"search": 0, "exact": 0}

    async def fake_exact(uid, client=None):
        called["exact"] += 1
        return bs.SearchResult(items=[{"platform_uid": uid}], exact=True)

    async def fake_search(kw, page=1, client=None):
        called["search"] += 1
        return bs.SearchResult(items=[])

    monkeypatch.setattr(bs, "exact_user", fake_exact)
    monkeypatch.setattr(bs, "search_users", fake_search)
    r1 = asyncio.run(bs.search("1265680561"))
    r2 = asyncio.run(bs.search("塔菲"))
    assert r1.exact is True and r2.exact is False
    assert called == {"search": 1, "exact": 1}


# ── 未登录（WBI 取密钥失败）：必须是一条"能给用户看的原因"，不是异常 ────

def _search_handler(request) -> httpx.Response:
    """搜索接口的 mock 处理器（放模块级，多个用例共用）。"""
    return httpx.Response(200, json=_search_body([_raw(1, "x")]))


def test_search_and_exact_pass_allow_anonymous(monkeypatch):
    """两条检索路径都必须**显式放行匿名签名**（devlog/086）。

    这是"未登录也能加 V"的接线点：`nav` 匿名也下发 `wbi_img`（实测），
    所以检索不该被登录态挡住；内容抓取路径**保持严格默认**（另有闸门与用例）。
    接线断了的话，未登录用户一点搜索就看到"需要登录" —— 正是要避免的。
    """
    from app.services import bili_search as bs

    seen: dict[str, bool] = {}

    async def fake_sign(params, allow_anonymous=False):
        seen["sign"] = allow_anonymous
        return {**params, "w_rid": "x" * 32, "wts": 0}

    async def fake_info(mid, client=None, allow_anonymous=False):
        seen["info"] = allow_anonymous
        return {"name": "永雏塔菲", "sign": "", "avatar": "", "live_status": 0, "room_id": 0}

    async def fake_stat(mid, client=None):
        return {"follower": 1}

    monkeypatch.setattr(bs.wbi, "sign_params", fake_sign)
    monkeypatch.setattr(bs, "fetch_bilibili_user_info", fake_info)
    monkeypatch.setattr(bs, "fetch_bilibili_user_stat", fake_stat)

    async def run():
        async with _client(_search_handler) as c:
            await bs.search_users("塔菲", client=c)
        await bs.exact_user("1265680561")

    asyncio.run(run())
    assert seen.get("sign") is True, "名称搜索没放行匿名签名"
    assert seen.get("info") is True, "UID 直查没放行匿名签名"


def test_search_users_maps_wbi_failure_to_not_logged_in(monkeypatch):
    """**2026-09-15 实测更正**：搜索接口不校验 cookie，但 WBI 签名密钥要从 `nav` 取，
    而 `nav` 未登录直接回 -101 ⇒ 没登录时模糊搜必然失败。

    旧实现里 `await wbi.sign_params(...)` 在 try 之外 —— 异常一路冒到端点变 500，
    用户看到的是栈而不是"请先登录"。这里锁死：**不抛异常**，返回 `not_logged_in` + 提示。
    """
    from app.services import bili_search as bs

    async def boom(params, allow_anonymous=False):
        raise Exception("获取WBI密钥失败: 账号未登录")

    monkeypatch.setattr(bs.wbi, "sign_params", boom)
    res = asyncio.run(bs.search_users("塔菲"))
    assert res.error == "not_logged_in" and res.items == []
    assert "登录" in (res.hint or "")


def test_search_users_keeps_other_wbi_failures_as_upstream_error(monkeypatch):
    """不是"未登录"的签名故障不能误导成"去登录"（归到 upstream_error）。"""
    from app.services import bili_search as bs

    async def boom(params, allow_anonymous=False):
        raise Exception("socket closed")

    monkeypatch.setattr(bs.wbi, "sign_params", boom)
    res = asyncio.run(bs.search_users("塔菲"))
    assert res.error == "upstream_error"
    assert "登录" not in (res.hint or "")


def test_exact_user_maps_wbi_failure_to_not_logged_in(monkeypatch):
    """uid 直查走 `acc/info`，**同样是 WBI 签名接口** ⇒ 未登录也一样失败（统一口径）。"""
    from app.services import bili_search as bs

    async def boom(mid, client=None, allow_anonymous=False):
        raise Exception("获取WBI密钥失败: 账号未登录")

    monkeypatch.setattr(bs, "fetch_bilibili_user_info", boom)
    res = asyncio.run(bs.exact_user("1265680561"))
    assert res.error == "not_logged_in" and res.items == []
    assert "登录" in (res.hint or "")


def test_exact_user_survives_stat_failure(monkeypatch):
    """粉丝数取不到不该让整次直查失败（名字才是收录/展示要用的）。"""
    from app.services import bili_search as bs

    async def fake_info(mid, client=None, allow_anonymous=False):
        return {"name": "永雏塔菲", "sign": "", "avatar": "", "live_status": 0, "room_id": 0}

    async def boom(mid, client=None, allow_anonymous=False):
        raise Exception("relation/stat 500")

    monkeypatch.setattr(bs, "fetch_bilibili_user_info", fake_info)
    monkeypatch.setattr(bs, "fetch_bilibili_user_stat", boom)
    res = asyncio.run(bs.exact_user("1265680561"))
    assert res.error is None and res.items[0]["name"] == "永雏塔菲"
    assert res.items[0]["followers"] == 0
