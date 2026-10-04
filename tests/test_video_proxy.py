"""视频代理（devlog/281 补丁）的判据：**白名单 / Range 直通 / 上游错误如实回**。

背景（真机实测）：小红书 CDN 对任何带 `Referer` 的请求回 403，而 WebView 加载媒体必然带 Referer
⇒ 前端直连不可靠，兜底走本机 `/video-proxy`（不带 Referer、**按主机补策略头**）。

2026-10-03（devlog/294）真机补的三条：① `/video-proxy` 是**后端的端点**，前端必须用
`videoProxyUrl()`（带 `apiBase`）拼，写成相对路径会落到页面来源；② `media-src` 里必须放行
后端来源；③ 白名单要包含 B站的 mcdn 镜像域（`bilivideo.cn`）。
"""
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import video_proxy


@pytest.fixture
def client():
    """与 `tests/test_notices.py` 同款：token 由 conftest 的 autouse fixture 备好。"""
    return TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_shared_client():
    """每个用例都从"没有共享客户端"开始（devlog/300 起代理复用同一个 `AsyncClient`）。

    不复位的话：上一个用例塞进去的**假客户端**会被下一个用例捡到（`_shared_client()` 只在
    `is_closed` 时才重建），症状是"单跑绿、整跑红"那种最费时间的形态。
    """
    video_proxy._client = None
    yield
    video_proxy._client = None

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


class _AbortingUpstream(_FakeUpstream):
    """客户端中止（拖进度条/换源时浏览器就会这么干）：**上游流读一半失败**。"""

    async def send(self, req, stream=True):  # noqa: D102
        resp = await super().send(req, stream=stream)

        async def _boom(*_a, **_kw):
            raise ConnectionResetError(10054, "远程主机强迫关闭了一个现有的连接")
            yield b""                      # pragma: no cover - 让它是异步生成器

        resp.aiter_bytes = _boom            # type: ignore[method-assign]
        return resp


def test_client_abort_is_not_an_error(client, monkeypatch, caplog):
    """前端掐掉在飞的媒体请求 ⇒ **不算错误**（devlog/300）。

    真机现场：用户拖了一次进度条，后端日志里就是一大串
    `ERROR asyncio: Exception in callback _ProactorBasePipeTransport._call_connection_lost`
    + `ConnectionResetError: [WinError 10054]`，把真问题淹了。
    判据：代理这边只留 debug，不 warning、不 error。
    """
    monkeypatch.setattr(video_proxy.httpx, "AsyncClient", _AbortingUpstream)
    with caplog.at_level("DEBUG", logger=video_proxy.__name__):
        r = client.get("/video-proxy", params={"url": UP})
    # 响应头已经发出去了（206），中途断流不该变成 500
    assert r.status_code in (200, 206)
    assert not [rec for rec in caplog.records if rec.levelno >= 30], \
        "客户端中止被当成错误记了日志（会淹没真问题）"


# ── 诊断行（devlog/306）：真机"跳转后画面低帧率"要靠这些数字定位 ──────────────

def test_every_stream_logs_a_diagnostic_line(client, monkeypatch, caplog):
    """每次转发结束都留一行：**首字节延迟 + 前 5 秒吞吐 + 总量 + 是否中止**。

    为什么必须有：用户报的"跳转后画面卡一帧、再以很低帧率播一段"分不出是 CDN、本机代理
    还是浏览器。这行给的是**代理侧**的数字，与前端那行（`[video] 帧率=…`）一对照就定案。
    """
    monkeypatch.setattr(video_proxy.httpx, "AsyncClient", _FakeUpstream)
    with caplog.at_level("INFO", logger=video_proxy.__name__):
        client.get("/video-proxy", params={"url": UP}, headers={"Range": "bytes=0-2"})
    lines = [r.getMessage() for r in caplog.records if "[视频代理]" in r.getMessage()]
    assert lines, "一次转发至少要留一行诊断"
    line = lines[-1]
    for needle in ("首字节=", "前5秒=", "共=", "用时=", "中止=", "range=bytes=0-2"):
        assert needle in line, f"诊断行缺 {needle}：{line}"
    # 指纹用来认"是不是同一个地址"，**不能把签名原样写进日志**
    assert "hash=" in line and "sign=" not in line


def test_slow_first_bytes_are_warned_not_buried(client, monkeypatch, caplog):
    """首字节慢 ⇒ 提到 WARNING 并**写明像什么**（否则用户拿到的只是"一条 INFO"）。

    真机判据：跳转后画面低帧率的头号嫌疑是"CDN 对随机 Range 冷启动慢"，
    这条 warning 就是它的现场记录。
    """
    monkeypatch.setattr(video_proxy.httpx, "AsyncClient", _FakeUpstream)
    monkeypatch.setattr(video_proxy, "_SLOW_TTFB_MS", -1)     # 强制判"首字节慢"
    with caplog.at_level("INFO", logger=video_proxy.__name__):
        client.get("/video-proxy", params={"url": UP}, headers={"Range": "bytes=0-2"})
    warns = [r.getMessage() for r in caplog.records if r.levelno >= 30]
    assert warns and "首字节" in warns[-1]
    assert "边缘没缓存" in warns[-1], "要写清这个数字意味着什么"


def test_slow_throughput_warning_says_the_symptom(caplog):
    """吞吐不够 ⇒ warning 要**点名现象**（"撑不住实时码率 ⇒ 画面低帧率"）。

    直接调 `_log_stream_done`：真跑一段慢流要 5 秒，而这里要钉的只是"文案与判据"。
    """
    with caplog.at_level("INFO", logger=video_proxy.__name__):
        video_proxy._log_stream_done(kind="video", host="upos-sz-x.bilivideo.com",
                                     headers={"Range": "bytes=74383360-"},
                                     status=206, ttfb_ms=120, sent=3 * 1024 * 1024,
                                     elapsed=12.0, first5=120_000.0, aborted=False,
                                     url_hash="deadbeef")
    warns = [r.getMessage() for r in caplog.records if r.levelno >= 30]
    assert warns and "低帧率" in warns[-1] and "前5秒" in warns[-1]

    caplog.clear()
    with caplog.at_level("INFO", logger=video_proxy.__name__):
        video_proxy._log_stream_done(kind="video", host="upos-sz-x.bilivideo.com",
                                     headers={}, status=206, ttfb_ms=80,
                                     sent=20 * 1024 * 1024, elapsed=9.0,
                                     first5=2_600_000.0, aborted=False, url_hash="deadbeef")
    assert not [r for r in caplog.records if r.levelno >= 30], "正常的一次不该报警"


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
    # B站 mcdn/P2P 镜像（真机实测**每条流的 baseUrl 都是它**，devlog/294）
    ("https://xy39x174x255x9xy.mcdn.bilivideo.cn:8082/v1/resource/a.m4s", True),
    ("https://upos-sz-estgoss.bilivideo.com/upgcxcode/a.m4s", True),
    ("https://cn-gddg-ct-01-12.bilivideo.com/v.m4s", True),      # B站媒体 CDN（2026-10-03 加）
    ("https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/x.m4s", True),
    # 抖音（第 4 阶段 ④ 第二刀，devlog/335）：真机回包里的视频地址走这两家子域
    ("https://v11-weba.douyinvod.com/abc/video.mp4", True),
    ("https://v26-web.douyinvod.com/abc/video.mp4", True),
    ("https://evilxhscdn.com/a.mp4", False),      # 后缀伪装
    ("https://xhscdn.com.evil.com/a.mp4", False),  # 前缀伪装
    ("https://bilivideo.com.evil.com/a.mp4", False),
    ("https://douyinvod.com.evil.com/a.mp4", False),
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


def test_host_policy_is_per_cdn_not_one_size_fits_all():
    """**按主机分请求头**：两家要求正好相反（2026-10-03 实测）。

    | CDN | 不带 Referer | 带 `Referer: bilibili.com` |
    |---|---|---|
    | `bilivideo.com` | 403 | 206 ✓ |
    | `xhscdn.com` | 206 ✓ | 403 |
    """
    bili = video_proxy.policy_for("cn-gddg-ct-01-12.bilivideo.com")
    assert bili.get("Referer") == "https://www.bilibili.com/", "B站媒体不带 Referer 会 403"
    assert "User-Agent" in bili
    # mcdn（`.cn`）与普通 CDN 同款策略：同属 B站媒体，防盗链要求一致
    assert video_proxy.policy_for("xy39x174x255x9xy.mcdn.bilivideo.cn").get("Referer") == \
        "https://www.bilibili.com/"
    assert video_proxy.policy_for("sns-video-v4.xhscdn.com") == {}, \
        "小红书带了 Referer 会 403 ⇒ 策略必须是「什么都不加」"
    # 抖音（devlog/335）：⚠️ **未实测**（只接了线，没播过真机的抖音视频）——
    # 先按"带站内 Referer + 浏览器 UA"处理；真机若播不了，第一件事是换成 `{}` 再试，
    # 并把实测结论补进 `video_proxy.py` 的那张表。
    douyin = video_proxy.policy_for("v11-weba.douyinvod.com")
    assert douyin.get("Referer") == "https://www.douyin.com/" and "User-Agent" in douyin
    assert video_proxy.policy_for("unknown.example") == {}


def test_proxy_applies_host_policy_and_still_strips_browser_headers(client, monkeypatch):
    """B站地址经代理：补上 Referer/UA，同时**仍然剥掉**浏览器的 Referer/Origin/Cookie。"""
    monkeypatch.setattr(video_proxy.httpx, "AsyncClient", _FakeUpstream)
    r = client.get("/video-proxy",
                   params={"url": "https://cn-gddg-ct-01-12.bilivideo.com/v.m4s?sign=x"},
                   headers={"Range": "bytes=0-2", "Referer": "http://localhost:1420/",
                            "Cookie": "SESSDATA=secret"})
    assert r.status_code == 206
    got = {k.lower(): v for k, v in _FakeUpstream.last_headers.items()}
    assert got.get("referer") == "https://www.bilibili.com/", "要的是**我们**定的 Referer"
    assert "cookie" not in got and "origin" not in got


def test_csp_allows_the_backend_origin_for_media():
    """CSP 的 `media-src` 必须放行**后端自己的来源**（`http://127.0.0.1:*`）。

    为什么（2026-10-03 真机，devlog/294）：`/video-proxy` 挂在后端上，而桌面端页面来源是
    `tauri://localhost`（开发态是 `http://localhost:5173`）⇒ 媒体请求是**跨源**的。
    `media-src` 里只有 `'self' https://*.xhscdn.com` 时，**所有经代理的流都会被 CSP 挡掉**，
    控制台一句 `Refused to load media`，而用户看到的症状与"CDN 挂了"一模一样。

    反向验证：把 `http://127.0.0.1:*` 从 `media-src` 删掉 ⇒ 本用例红。
    """
    root = Path(__file__).resolve().parent.parent
    conf = json.loads((root / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    csp = conf["app"]["security"]["csp"]
    media = next((d for d in csp.split(";") if d.strip().startswith("media-src")), "")
    assert media, f"CSP 里没有 media-src：{csp}"
    assert "http://127.0.0.1:*" in media, (
        "media-src 没放行后端来源 ⇒ 经 /video-proxy 的流会被 CSP 全挡（真机表现为'播不了'）")
    # 直连那两级（非 DASH 档先试直连）仍要留着 —— 别为了修上面那条把它们删了
    assert "'self'" in media and "xhscdn.com" in media


def test_csp_allows_blob_urls_for_media():
    """CSP 的 `media-src` 必须放行 **`blob:`**（MSE 内核，devlog/312）。

    为什么（2026-10-04）：MSE 的内核把 `MediaSource` 挂成 **blob URL**（`el.src = URL.createObjectURL(ms)`）
    —— 没有 `blob:` 时**桌面上每一条 MSE 流都会被 CSP 挡掉**，内核当场判"不成立"退回渐进式，
    于是这一整批（按段取数、一个时钟）在真机上等于没上；而**无头探针看不见**（探针跑的是 vite
    页面，没有 Tauri 那份 CSP 头），症状只会在真机上表现为"还是旧内核那样卡"。

    ⚠️ 反向验证：把 `blob:` 从 `media-src` 删掉 ⇒ 本用例红（这一次是真踩到的漏洞）。
    """
    root = Path(__file__).resolve().parent.parent
    conf = json.loads((root / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    csp = conf["app"]["security"]["csp"]
    media = next((d for d in csp.split(";") if d.strip().startswith("media-src")), "")
    assert "blob:" in media, (
        f"media-src 没放行 blob: ⇒ MSE 的 blob 流会被 CSP 全挡（真机表现为'新内核从不生效'）：{media}")
