# -*- coding: utf-8 -*-
"""内容抓取的**登录闸门**（devlog/086）：未登录时不是"试了失败"，而是**根本不发请求**。

为什么这条要单独测：用户实测与真机测量都表明，匿名调用 B 站空间接口（投稿 `arc/search`、
动态 `feed/space`）会被平台 `412 request was banned`，而且是 **IP 级、会持续一段时间**
（换新进程、隔 40 秒再打仍然 412；登录态不受影响，已实测）。
所以闸门失效的代价不是"多一次失败"，而是**把 IP 弄脏 + 用户看到莫名失败** ——
必须有用例钉住"连请求都不发"。
"""
import asyncio

import pytest

from app.services import capabilities, scheduler


@pytest.fixture
def logged_out(monkeypatch):
    from app.services.auth import auth_manager

    monkeypatch.setattr(auth_manager, "sessdata", "")
    monkeypatch.setattr(auth_manager, "bili_jct", "")
    return auth_manager


@pytest.fixture
def logged_in(monkeypatch):
    from app.services.auth import auth_manager

    monkeypatch.setattr(auth_manager, "sessdata", "s" * 20)
    monkeypatch.setattr(auth_manager, "bili_jct", "j" * 20)
    return auth_manager


def test_lane_skip_reason_covers_bilibili_when_logged_out(logged_out):
    """动态流名单：未登录时整条 bilibili 名单跳过（沿用微博名单那套口径）。"""
    why = scheduler._lane_skip_reason("bilibili")
    assert why and "登录" in why
    assert scheduler._lane_skip_reason("weibo") is None or "微博" in scheduler._lane_skip_reason("weibo")


def test_lane_skip_reason_allows_bilibili_when_logged_in(logged_in):
    assert scheduler._lane_skip_reason("bilibili") is None


def test_fetch_posts_returns_login_required_without_touching_network(logged_out, monkeypatch):
    """`async_fetch_posts`：未登录直接返回 `login_required`，且**一次网络都不发**。"""
    sent = []

    def boom(*a, **k):
        sent.append(a)
        raise AssertionError("未登录不该发起内容抓取请求")

    monkeypatch.setattr(scheduler, "new_async_client", boom)
    monkeypatch.setattr(scheduler, "SessionLocal", boom)

    out = asyncio.run(scheduler.async_fetch_posts("bilibili", "123456", 1, 1))
    assert out.stop_reason == "login_required"
    assert "登录" in (out.error or "")
    assert sent == []


def test_first_screen_returns_login_required_without_touching_network(logged_out, monkeypatch):
    """收录首屏：未登录跳过（收录本身照常完成，只是没有首屏内容）。"""
    sent = []

    def boom(*a, **k):
        sent.append(a)
        raise AssertionError("未登录不该发起首屏抓取请求")

    monkeypatch.setattr(scheduler, "new_async_client", boom)
    monkeypatch.setattr(scheduler, "SessionLocal", boom)

    out = asyncio.run(scheduler.async_fetch_first_screen(999999))
    assert out.stop_reason == "login_required"
    assert sent == []


def test_gate_opens_when_logged_in(logged_in):
    """登录后闸门放行（这里只验判据本身；真正抓取由既有用例覆盖）。"""
    assert capabilities.content_fetch_allowed() == (True, "")
