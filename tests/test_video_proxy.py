"""视频代理（devlog/281 补丁）的判据：**白名单 / Range 直通 / 上游错误如实回**。

背景（真机实测）：小红书 CDN 对任何带 `Referer` 的请求回 403，而 WebView 加载媒体必然带 Referer
⇒ 前端直连不可靠，兜底走本机 `/video-proxy`（不带 Referer、同源）。
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import video_proxy


@pytest.fixture
def client():
    """与 `tests/test_notices.py` 同款：token 由 conftest 的 autouse fixture 备好。"""
    return TestClient(app)

UP = "http://sns-video-v4.xhscdn.com/stream/1/110/84/x_84.mp4?sign=abc&t=1"


class _FakeUpstream(httpx.AsyncClient):
    """假上游：记录收到的头，返回固定响应（不联网）。"""

    last_headers: dict = {}

    def __init__(self, status=206, body=b"abc", headers=None, **kw):
        self._status = status
        self._body = body
        self._headers = headers or {"content-type": "video/mp4", "content-range": "bytes 0-2/100",
                                    "content-length": "3"}

    def build_request(self, method, url, headers=None):  # noqa: D102
        _FakeUpstream.last_headers = dict(headers or {})
        return httpx.Request(method, url, headers=headers or {})

    async def send(self, req, stream=True):  # noqa: D102
        return httpx.Response(self._status, headers=self._headers, content=self._body,
                              request=req)

    async def aclose(self):  # noqa: D102
        return None


def test_video_proxy_rejects_hosts_outside_the_whitelist(client):
    """白名单外的地址一律 400 —— 本机端口也是端口，绝不做开放代理。"""
    r = client.get("/video-proxy", params={"url": "https://evil.example/x.mp4"})
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]


def test_video_proxy_streams_with_range_and_without_referer(client, monkeypatch):
    """Range 直通（播放器靠它拖进度），且**不把 Referer/Origin/Cookie 转给上游**。"""
    monkeypatch.setattr(video_proxy.httpx, "AsyncClient", _FakeUpstream)
    r = client.get("/video-proxy", params={"url": UP},
                   headers={"Range": "bytes=0-2", "Referer": "http://localhost:1420/",
                            "Origin": "tauri://localhost", "Cookie": "web_session=x"})

    assert r.status_code == 206
    assert r.content == b"abc"
    assert r.headers["content-range"] == "bytes 0-2/100"
    assert r.headers["accept-ranges"] == "bytes", "缺了它播放器以为不能拖进度"
    got = {k.lower() for k in _FakeUpstream.last_headers}
    assert "range" in got
    assert not ({"referer", "origin", "cookie"} & got), \
        "正是这几个头让 CDN 回 403，代理必须剥掉"


def test_video_proxy_reports_upstream_error_as_is(client, monkeypatch):
    """上游 403 就回 403（别把"上游拒绝"说成"没有这个视频"）。"""
    monkeypatch.setattr(
        video_proxy.httpx, "AsyncClient",
        lambda **kw: _FakeUpstream(status=403, body=b"denied",
                                   headers={"content-type": "text/html"}))
    r = client.get("/video-proxy", params={"url": UP})
    assert r.status_code == 403
    assert "403" in r.json()["detail"]


@pytest.mark.parametrize("url,ok", [
    ("https://sns-video-v4.xhscdn.com/a.mp4", True),
    ("http://sns-bak-v1.xhscdn.com/a.mp4", True),
    ("https://xhscdn.com/a.mp4", True),
    ("https://evilxhscdn.com/a.mp4", False),      # 后缀伪装
    ("https://xhscdn.com.evil.com/a.mp4", False),  # 前缀伪装
    ("file:///etc/passwd", False),
    ("", False),
])
def test_host_whitelist_matching(url, ok):
    """白名单按**主机后缀**匹配：`evilxhscdn.com` 与 `xhscdn.com.evil.com` 都不许过。"""
    if ok:
        assert video_proxy.host_allowed(url)
    else:
        with pytest.raises(Exception):
            video_proxy.host_allowed(url)
