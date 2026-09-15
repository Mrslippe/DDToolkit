# -*- coding: utf-8 -*-
"""WBI 匿名签名（`app/services/wbi.py`，devlog/086）。

实测事实（2026-09-15，原始回包）：未登录请求 `x/web-interface/nav` 返回
`code=-101 账号未登录`，**但同一个响应里带着 `data.wbi_img`** —— WBI 密钥不随登录态变。
所以"未登录不能签名"是我们自己的判据；`allow_anonymous=True` 放开的只是**检索类**路径
（空间内容接口匿名会被平台 412，另由 `capabilities.content_fetch_allowed()` 挡）。
"""
import asyncio

import httpx
import pytest

from app.services import wbi

NAV_OK = {"code": 0, "message": "0", "data": {
    "wbi_img": {"img_url": "https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                "sub_url": "https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png"}}}
NAV_ANON = {"code": -101, "message": "账号未登录", "data": {
    "wbi_img": {"img_url": "https://i0.hdslb.com/bfs/wbi/cccccccccccccccccccccccccccccccc.png",
                "sub_url": "https://i0.hdslb.com/bfs/wbi/dddddddddddddddddddddddddddddddd.png"}}}
NAV_ANON_NO_IMG = {"code": -101, "message": "账号未登录", "data": {}}


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    """每个用例前清缓存（模块级缓存会串味）。"""
    wbi.clear_wbi_cache()
    yield
    wbi.clear_wbi_cache()


def _patch_nav(monkeypatch, body: dict) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/nav")
        return httpx.Response(200, json=body)

    monkeypatch.setattr(wbi, "new_async_client",
                        lambda *a, **k: httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def test_logged_in_nav_caches_keys_and_marks_not_anonymous(monkeypatch):
    _patch_nav(monkeypatch, NAV_OK)
    keys = asyncio.run(wbi.get_wbi_keys())
    assert keys == ("a" * 32, "b" * 32)
    assert wbi.wbi_status() == {"cached": True, "anonymous": False}


def test_anonymous_nav_is_refused_by_default(monkeypatch):
    """默认（严格）口径不变：未登录仍抛 —— 抓取路径靠它快速明确地失败。"""
    _patch_nav(monkeypatch, NAV_ANON)
    with pytest.raises(Exception) as e:
        asyncio.run(wbi.get_wbi_keys())
    assert "未登录" in str(e.value)
    assert wbi.wbi_status()["cached"] is False


def test_anonymous_nav_usable_when_allowed(monkeypatch):
    """`allow_anonymous=True`：匿名 nav 也下发 wbi_img ⇒ 照样拿到密钥并标记匿名。"""
    _patch_nav(monkeypatch, NAV_ANON)
    keys = asyncio.run(wbi.get_wbi_keys(allow_anonymous=True))
    assert keys == ("c" * 32, "d" * 32)
    assert wbi.wbi_status() == {"cached": True, "anonymous": True}


def test_anonymous_without_img_still_fails(monkeypatch):
    """匿名**且** nav 没给 wbi_img 时照样失败 —— 不许把"拿不到密钥"说成"能用"。"""
    _patch_nav(monkeypatch, NAV_ANON_NO_IMG)
    with pytest.raises(Exception):
        asyncio.run(wbi.get_wbi_keys(allow_anonymous=True))


def test_sign_params_anonymous_returns_signature(monkeypatch):
    _patch_nav(monkeypatch, NAV_ANON)
    signed = asyncio.run(wbi.sign_params({"keyword": "塔菲", "page": 1},
                                         allow_anonymous=True))
    assert signed["keyword"] == "塔菲" and "w_rid" in signed and "wts" in signed
    assert len(signed["w_rid"]) == 32


def test_cache_avoids_second_nav(monkeypatch):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=NAV_ANON)

    monkeypatch.setattr(wbi, "new_async_client",
                        lambda *a, **k: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def twice():
        await wbi.get_wbi_keys(allow_anonymous=True)
        await wbi.get_wbi_keys(allow_anonymous=True)

    asyncio.run(twice())
    assert calls["n"] == 1, "第二次应当命中缓存"
