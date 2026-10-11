# -*- coding: utf-8 -*-
"""多平台「按名字搜人」（B1，需求 8，`devlog/463`）。

判据对着三类**会静默出错**的地方：
① 平台关着时**一个请求都不许发**（`skipped` 与 `error` 还得分开 —— 文案不一样）；
② 四家的真实回包形状各自解析对（微博只回一条、小红书 `fans` 是 `"17.3万"` 这种串、
   抖音用户卡在 `data.user_list[].user_info`）；
③ 一家失败**不许拖垮**其余（并发 gather 里逐个兜异常）。

HTTP 用 `httpx.MockTransport` 顶掉（同 `test_bili_search.py`）。
"""
import asyncio
import json

import httpx
import pytest

from app.services import name_search as ns
from app.services import platform_switches


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _clean():
    ns.clear_cache()
    yield
    ns.clear_cache()


# ── ① 粉丝数解析（小红书把粉丝数格式化成了字符串）────────────────────────

def test_parse_fans():
    """**不能 `int()`**：真机回的是 `"17.3万"`。认不出 ⇒ 0（= 不显示，而不是显示 0 粉）。"""
    assert ns.parse_fans("17.3万") == 173000
    assert ns.parse_fans("1234") == 1234
    assert ns.parse_fans("1.2亿") == 120_000_000
    assert ns.parse_fans("3.5k") == 3500
    assert ns.parse_fans(88) == 88
    assert ns.parse_fans("") == 0
    assert ns.parse_fans(None) == 0
    assert ns.parse_fans("坏值") == 0
    assert ns.parse_fans("-5") == 0          # 负数当脏值
    assert ns.parse_fans(True) == 0          # bool 是 int 的子类：别把 True 当 1


# ── ② 开关 / 输入分流 / 未知平台（都不该发请求）──────────────────────────

def test_disabled_platform_is_skipped_without_any_request(monkeypatch):
    """★ 平台抓取关着 ⇒ `skipped=True` + 「去哪打开」，**一个请求都不发**。"""
    called: list[str] = []

    async def boom(kw, page):
        called.append(kw)
        raise AssertionError("关着的平台不该被调用")

    monkeypatch.setitem(ns._SEARCHERS, "douyin", boom)
    monkeypatch.setattr(platform_switches, "enabled", lambda p: False)

    hits = asyncio.run(ns.search_platform("douyin", "七海"))
    assert hits.skipped is True and hits.items == []
    assert hits.error is None, "关着是**用户的设置**，不是失败 —— 两者要分得开"
    assert hits.hint and "平台抓取" in hits.hint
    assert called == []


def test_unknown_platform_is_unsupported():
    hits = asyncio.run(ns.search_platform("twitter", "七海"))
    assert hits.error == "unsupported" and "暂不支持" in (hits.hint or "")


def test_empty_keyword_short_circuits():
    hits = asyncio.run(ns.search_platform("weibo", "   "))
    assert hits.error == "empty_kw"


def test_uid_input_only_queries_bilibili(monkeypatch):
    """纯数字 = 一条 UID：只搜 B 站（另三家拿数字搜是白发三发请求，还可能排上无关的人）。"""
    seen: list[str] = []

    async def fake(platform, kw, *, page=1):
        seen.append(platform)
        return ns.PlatformHits(platform, platform_switches.LABELS[platform])

    monkeypatch.setattr(ns, "search_platform", fake)
    asyncio.run(ns.search_all("1265680561"))
    assert seen == ["bilibili"]
    seen.clear()
    asyncio.run(ns.search_all("塔菲"))
    assert seen == list(platform_switches.PLATFORMS), "非 uid 时四家都要搜，且顺序稳定"


def test_one_platform_raising_does_not_kill_the_rest(monkeypatch):
    """★ 一家炸了不许拖垮其余（并发 gather 里逐个兜异常，如实归类）。"""
    async def fake_bili(kw, page):
        return ns.PlatformHits("bilibili", "B 站",
                               items=[{"platform": "bilibili", "platform_uid": "1",
                                       "name": "A"}])

    async def boom(kw, page):
        raise RuntimeError("上游炸了")

    monkeypatch.setitem(ns._SEARCHERS, "bilibili", fake_bili)
    monkeypatch.setitem(ns._SEARCHERS, "weibo", boom)
    monkeypatch.setattr(platform_switches, "enabled", lambda p: True)

    hits = {h.platform: h for h in asyncio.run(ns.search_all("塔菲"))}
    assert [h.platform for h in asyncio.run(ns.search_all("塔菲"))] == \
        list(platform_switches.PLATFORMS)
    assert hits["bilibili"].items and hits["bilibili"].error is None
    assert hits["weibo"].error == "upstream_error" and hits["weibo"].items == []


# ── ③ 四家的真实回包解析 ────────────────────────────────────────────────

def test_weibo_parses_users_and_marks_best_match_only(monkeypatch):
    """微博 `side/search` → `data.users[]`；它是**建议型接口**，只回最匹配的一条。"""
    from app.services import weibo_auth
    monkeypatch.setattr(weibo_auth.weibo_auth_manager, "cookie", "SUB=x")

    def handler(req):
        assert "weibo.com/ajax/side/search" in str(req.url)
        return httpx.Response(200, json={"ok": 1, "data": {"users": [
            {"idstr": "7198559139", "screen_name": "七海Nana7mi",
             "followers_count": 1051006, "verified": True,
             "description": "简介", "profile_image_url": "https://tva2.sinaimg.cn/a.jpg"},
            {"screen_name": "缺 uid 的脏条目"},
        ]}})

    monkeypatch.setattr(ns, "new_async_client", lambda *a, **k: _client(handler))
    hits = asyncio.run(ns._search_weibo("七海", 1))
    assert hits.error is None and len(hits.items) == 1, "缺 uid 的条目要丢掉"
    it = hits.items[0]
    assert (it["platform"], it["platform_uid"], it["name"]) == \
        ("weibo", "7198559139", "七海Nana7mi")
    assert it["followers"] == 1051006 and it["verified"] == "微博认证"
    assert hits.best_match_only is True, "只回一条是**接口形态**，界面要说准"


def test_weibo_minus_100_means_logged_out(monkeypatch):
    """`ok=-100` = 这条 cookie 在 PC 域也不认了 ⇒ 说"去重登"，**不说**"没找到这个人"。"""
    from app.services import weibo_auth
    monkeypatch.setattr(weibo_auth.weibo_auth_manager, "cookie", "SUB=dead")
    marked: list[str] = []
    monkeypatch.setattr(weibo_auth.weibo_auth_manager, "mark_invalid",
                        lambda why: marked.append(why))

    monkeypatch.setattr(ns, "new_async_client", lambda *a, **k: _client(
        lambda req: httpx.Response(200, json={"ok": -100, "url": "passport..."})))
    hits = asyncio.run(ns._search_weibo("七海", 1))
    assert hits.error == "not_logged_in" and "登录" in (hits.hint or "")
    assert marked, "要让认证单例记住（动态流下一轮跳过该平台）"


def test_weibo_without_cookie_does_not_send(monkeypatch):
    from app.services import weibo_auth
    monkeypatch.setattr(weibo_auth.weibo_auth_manager, "cookie", "")
    monkeypatch.setattr(ns, "new_async_client",
                        lambda *a, **k: pytest.fail("没 cookie 不该发请求"))
    hits = asyncio.run(ns._search_weibo("七海", 1))
    assert hits.error == "not_logged_in"


def test_xhs_parses_users_and_fans_string(monkeypatch):
    """小红书 `usersearch` → `data.users[]`；`fans` 是 `"17.3万"` 这种串。"""
    class _Pf:
        def _signed_headers(self, method, path, payload):
            assert path == "/api/sns/web/v1/search/usersearch"
            inner = payload["search_user_request"]
            assert inner["biz_type"] == "web_search_user" and inner["request_id"]
            return {"x-s": "stub"}

    monkeypatch.setattr(ns.registry, "get_fetcher", lambda p: _Pf() if p == "xiaohongshu" else None)

    def handler(req):
        return httpx.Response(200, json={"success": True, "code": 0, "data": {"users": [
            {"id": "5edde7c30000000001003538", "name": "七海Christ", "fans": "17.3万",
             "image": "https://sns-avatar-qc.xhscdn.com/a.jpg"},
        ]}})

    monkeypatch.setattr(ns, "new_async_client", lambda *a, **k: _client(handler))
    hits = asyncio.run(ns._search_xiaohongshu("七海", 1))
    it = hits.items[0]
    assert (it["platform"], it["platform_uid"], it["name"], it["followers"]) == \
        ("xiaohongshu", "5edde7c30000000001003538", "七海Christ", 173000)


def test_xhs_captcha_is_degraded_not_error(monkeypatch):
    """461/471 是验证码/风控：**不绕**，如实说"要验证码"，别报成 upstream_error。"""
    class _Pf:
        def _signed_headers(self, *a, **k):
            return {}

    monkeypatch.setattr(ns.registry, "get_fetcher", lambda p: _Pf())
    monkeypatch.setattr(ns, "new_async_client", lambda *a, **k: _client(
        lambda req: httpx.Response(200, json={"success": False, "code": 461,
                                              "msg": "验证码"})))
    hits = asyncio.run(ns._search_xiaohongshu("七海", 1))
    assert hits.error == "upstream_degraded" and "验证码" in (hits.hint or "")


def test_douyin_parses_user_list(monkeypatch):
    """抖音用户卡在 `data.user_list[].user_info`（**不是** general/search 的 aweme 卡）。"""
    class _Pf:
        def _base_params(self):
            return {"device_platform": "webapp"}

        def _signed(self, params):
            assert params["search_channel"] == "aweme_user_web"
            return "q=1", {"x-secsdk-web-signature": "s"}

        def _ua(self):
            return "UA"

        def _cookie_header(self):
            return "cookie"

    monkeypatch.setattr(ns.registry, "get_fetcher", lambda p: _Pf() if p == "douyin" else None)

    def handler(req):
        return httpx.Response(200, json={"status_code": 0, "has_more": 1, "data": {"user_list": [
            {"user_info": {"uid": "4222546939220926", "sec_uid": "MS4wLjABAAAAx",
                           "nickname": "七海", "unique_id": "qihai94251",
                           "follower_count": 65, "signature": "签名",
                           "avatar_thumb": {"url_list": ["https://p3.douyinpic.com/a.jpg"]}}},
        ]}})

    monkeypatch.setattr(ns, "new_async_client", lambda *a, **k: _client(handler))
    hits = asyncio.run(ns._search_douyin("七海", 1))
    it = hits.items[0]
    # ⚠️ 用 sec_uid 当 platform_uid：抖音的收录通道认的是它（`sec_uid_from_input`）
    assert (it["platform"], it["platform_uid"], it["name"], it["followers"]) == \
        ("douyin", "MS4wLjABAAAAx", "七海", 65)
    assert it["avatar"].endswith("a.jpg")


def test_douyin_empty_body_means_signature_rejected(monkeypatch):
    """签名被拒的形态是 **200 + 空体**（`devlog/333`）⇒ 归"身份不被认"，不是 upstream_error。"""
    class _Pf:
        def _base_params(self):
            return {}

        def _signed(self, params):
            return "q=1", {}

        def _ua(self):
            return "UA"

        def _cookie_header(self):
            return "cookie"

    monkeypatch.setattr(ns.registry, "get_fetcher", lambda p: _Pf())
    monkeypatch.setattr(ns, "new_async_client",
                        lambda *a, **k: _client(lambda req: httpx.Response(200, content=b"")))
    hits = asyncio.run(ns._search_douyin("七海", 1))
    assert hits.error == "not_logged_in"


def test_douyin_captcha_field_is_degraded(monkeypatch):
    class _Pf:
        def _base_params(self):
            return {}

        def _signed(self, params):
            return "q=1", {}

        def _ua(self):
            return "UA"

        def _cookie_header(self):
            return "cookie"

    monkeypatch.setattr(ns.registry, "get_fetcher", lambda p: _Pf())
    monkeypatch.setattr(ns, "new_async_client", lambda *a, **k: _client(
        lambda req: httpx.Response(200, json={"status_code": 0,
                                              "verify_center_decision_conf": {}})))
    hits = asyncio.run(ns._search_douyin("七海", 1))
    assert hits.error == "upstream_degraded" and "验证码" in (hits.hint or "")


def test_results_are_cached(monkeypatch):
    """同一关键词反复搜（含前端重试）不打上游 —— 第二次必须命中缓存。"""
    calls: list[str] = []

    def handler(req):
        calls.append(str(req.url))
        return httpx.Response(200, json={"ok": 1, "data": {"users": [
            {"idstr": "1", "screen_name": "某人"}]}})

    from app.services import weibo_auth
    monkeypatch.setattr(weibo_auth.weibo_auth_manager, "cookie", "SUB=x")
    monkeypatch.setattr(ns, "new_async_client", lambda *a, **k: _client(handler))

    asyncio.run(ns._search_weibo("七海", 1))
    asyncio.run(ns._search_weibo("七海", 1))
    assert len(calls) == 1


# ⚠️ 端点的两条用例在 `tests/test_vtuber_api.py`（`/vtuber/users/search` 那两条）——
#    那里有全套隔离夹具（测试库 + `setup_db` + 挡掉后台抓取的 `client`），
#    在这里重造一份只会长出第二个会漂的夹具。
