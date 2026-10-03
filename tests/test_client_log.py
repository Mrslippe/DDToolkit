# -*- coding: utf-8 -*-
"""前端诊断行通道（`POST /settings/client-log`，devlog/306）的判据。

为什么值得单独钉：它是**唯一**让"浏览器里的现象"落进后端日志的入口，
所以三条边界必须守住 —— 只收白名单标签、单行有长度上限、每进程每分钟有上限；
并且它**不是公开端点**（要会话 token），否则本机任何进程都能往日志里写字。
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import settings as settings_router


@pytest.fixture(autouse=True)
def _fresh_window():
    """每个用例都从"新窗口"开始（频率窗口是模块级状态，不隔离会互相影响）。"""
    settings_router._client_log_window.update({"start": 0.0, "count": 0})
    yield
    settings_router._client_log_window.update({"start": 0.0, "count": 0})


@pytest.fixture
def client():
    return TestClient(app)


def test_client_log_writes_one_info_line(client, caplog):
    """正常一行：进日志、级别固定 INFO（**不接受调用方指定级别**）。"""
    with caplog.at_level("INFO", logger="app.routers.settings"):
        r = client.post("/settings/client-log",
                        json={"line": "[video] seek→198.5s 起播=4.2s 饿住=6次 帧率=18.4fps"})
    assert r.status_code == 200 and r.json()["ok"] is True
    rec = [x for x in caplog.records if "[video]" in x.getMessage()]
    assert rec and rec[-1].levelno == 20, "必须是 INFO（前端不该能写 error 级）"
    assert "起播=4.2s" in rec[-1].getMessage()


def test_client_log_rejects_unknown_tags(client):
    """非白名单标签 ⇒ 400（否则它就是个"任意写日志"的通道，可被拿来伪造日志/刷盘）。"""
    r = client.post("/settings/client-log", json={"line": "[error] 我随便写"})
    assert r.status_code == 400
    assert "[video]" in r.json()["detail"]


def test_client_log_rejects_overlong_lines(client):
    """单行 ≤400 字（日志行不该被塞成一篇文档）。超过 ⇒ 422（pydantic 拦下）。"""
    r = client.post("/settings/client-log", json={"line": "[video] " + "x" * 500})
    assert r.status_code == 422


def test_client_log_is_rate_limited_but_never_errors(client):
    """超频只**丢弃**（返回 dropped），不回错 —— 诊断通道不该让前端还要处理失败。"""
    ok = 0
    dropped = 0
    for _ in range(settings_router._CLIENT_LOG_PER_MIN + 5):
        r = client.post("/settings/client-log", json={"line": "[video] tick"})
        assert r.status_code == 200
        if r.json()["dropped"]:
            dropped += 1
        else:
            ok += 1
    assert ok == settings_router._CLIENT_LOG_PER_MIN
    assert dropped == 5


def test_client_log_needs_the_session_token():
    """**不是公开端点**：没有 token ⇒ 401（本机任何进程都能往日志里写字是不行的）。"""
    from app.core import api_auth

    anon = TestClient(app, headers={api_auth.TOKEN_HEADER: "deliberately-wrong"})
    r = anon.post("/settings/client-log", json={"line": "[video] 未授权"})
    assert r.status_code == 401
