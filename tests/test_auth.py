# -*- coding: utf-8 -*-
"""统一扫码登录测试：
- auth 路由状态机（start/check 各状态/complete 触发/过期/404）
- 微博扫码会话（v2 流程 / JSONP 解析 / cookie 组装与持久化）
"""
import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import auth as arouter
from app.services import weibo_auth as wam


@pytest.fixture
def client():
    return TestClient(app)


# ── auth 路由（mock 会话实现） ─────────────────────────────────────────

class _FakeSess:
    """可编排轮询结果的假登录会话。"""

    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.completed = 0
        self.closed = False

    async def start(self):
        return {"url": "https://passport.bilibili.com/qrcode/h5/login?x=1"}

    async def poll(self):
        s = self.statuses.pop(0)
        return (s, {"data": {"url": "https://callback.example"}}) if s == "confirmed" else (s, None)

    async def complete(self, payload):
        self.completed += 1
        return True, "uid-123"

    async def close(self):
        self.closed = True


def _fake_manager(monkeypatch, statuses):
    sess = _FakeSess(statuses)
    monkeypatch.setattr(arouter.auth_manager, "begin_login", lambda: sess)
    return sess


def test_qr_start_returns_qr_id(client, monkeypatch):
    _fake_manager(monkeypatch, ["waiting"])
    r = client.post("/auth/bilibili/qr/start")
    assert r.status_code == 200
    body = r.json()
    assert body["qr_id"]
    assert body["url"].startswith("https://")


def test_qr_check_state_machine(client, monkeypatch):
    sess = _fake_manager(monkeypatch, ["waiting", "scanned", "confirmed"])
    qr_id = client.post("/auth/bilibili/qr/start").json()["qr_id"]

    assert client.get(f"/auth/bilibili/qr/check?qr_id={qr_id}").json()["status"] == "waiting"
    assert client.get(f"/auth/bilibili/qr/check?qr_id={qr_id}").json()["status"] == "scanned"

    r = client.get(f"/auth/bilibili/qr/check?qr_id={qr_id}").json()
    assert r["status"] == "confirmed"
    assert r["detail"] == "uid-123"
    assert sess.completed == 1
    assert sess.closed is True          # 完成后会话关闭
    # 会话已移除：再查 404
    assert client.get(f"/auth/bilibili/qr/check?qr_id={qr_id}").status_code == 404


def test_qr_check_expired_by_poll(client, monkeypatch):
    _fake_manager(monkeypatch, ["expired"])
    qr_id = client.post("/auth/bilibili/qr/start").json()["qr_id"]
    assert client.get(f"/auth/bilibili/qr/check?qr_id={qr_id}").json()["status"] == "expired"


def test_qr_check_expired_by_deadline(client, monkeypatch):
    _fake_manager(monkeypatch, ["waiting"])
    qr_id = client.post("/auth/bilibili/qr/start").json()["qr_id"]
    monkeypatch.setattr(arouter.time, "monotonic", lambda: 1e12)  # 超出 TTL
    assert client.get(f"/auth/bilibili/qr/check?qr_id={qr_id}").json()["status"] == "expired"


def test_qr_check_unknown_qr_id(client):
    assert client.get("/auth/bilibili/qr/check?qr_id=nope").status_code == 404


def test_auth_status_bilibili(client, monkeypatch):
    monkeypatch.setattr(arouter.auth_manager, "sessdata", "")
    monkeypatch.setattr(arouter.auth_manager, "bili_jct", "")
    monkeypatch.setattr(arouter.auth_manager, "_needs_login", True)
    r = client.get("/auth/bilibili/status").json()
    assert r["logged_in"] is False
    assert r["needs_login"] is True


def test_auth_status_weibo_valid_cookie(client, monkeypatch):
    """Cookie 有效：探测通过 → logged_in=True。"""
    monkeypatch.setattr(arouter.weibo_auth_manager, "cookie", "SUB=abc")
    monkeypatch.setattr(arouter.weibo_auth_manager, "uid", "1")
    monkeypatch.setattr(arouter.weibo_auth_manager, "name", "测试")
    monkeypatch.setattr(arouter.weibo_auth_manager, "check_valid", _async(True))
    r = client.get("/auth/weibo/status").json()
    assert r["logged_in"] is True
    assert r["needs_login"] is False
    assert r["uid"] == "1"
    assert r["name"] == "测试"


def test_auth_status_weibo_stale_cookie(client, monkeypatch):
    """Cookie 过期（存在但探测失效）：必须报未登录，前端才出现重新扫码入口。

    修复（2026-09）：此前 logged_in 只看 cookie 存在性，8/22 的过期 Cookie
    让 UI 永远显示「微博·已登录」，点重新登录也不出二维码。"""
    monkeypatch.setattr(arouter.weibo_auth_manager, "cookie", "SUB=stale-expired")
    monkeypatch.setattr(arouter.weibo_auth_manager, "uid", "1")
    monkeypatch.setattr(arouter.weibo_auth_manager, "name", "测试")
    monkeypatch.setattr(arouter.weibo_auth_manager, "check_valid", _async(False))
    r = client.get("/auth/weibo/status").json()
    assert r["logged_in"] is False
    assert r["needs_login"] is True
    assert r["uid"] == "1"


def _async(value):
    async def _f(*a, **k):
        return value
    return _f


# ── 微博登录态探测（check_valid） ─────────────────────────────────────

def test_weibo_check_valid_from_body():
    assert wam.WeiboAuth._valid_from_body({"ok": 1}) is True
    assert wam.WeiboAuth._valid_from_body({"ok": -100, "url": "https://weibo.com/login.php"}) is False
    assert wam.WeiboAuth._valid_from_body(None) is False
    assert wam.WeiboAuth._valid_from_body("garbage") is False


def test_weibo_check_valid_caches(monkeypatch):
    """探测结果缓存 60s：缓存期内不再发请求；失效后重探。"""
    mgr = wam.WeiboAuth()
    mgr.cookie = "SUB=abc"
    calls = {"n": 0}

    async def fake_probe():
        calls["n"] += 1
        return True

    monkeypatch.setattr(mgr, "_probe_once", fake_probe)

    async def run():
        r1 = await mgr.check_valid()   # 首次：探测 1 次
        r2 = await mgr.check_valid()   # 缓存命中
        return r1, r2

    r1, r2 = asyncio.run(run())
    assert r1 is True and r2 is True
    assert calls["n"] == 1


def test_weibo_check_valid_no_cookie(monkeypatch):
    mgr = wam.WeiboAuth()
    mgr.cookie = ""

    async def fake_probe():
        raise AssertionError("无 cookie 不应探测")

    monkeypatch.setattr(mgr, "_probe_once", fake_probe)
    assert asyncio.run(mgr.check_valid()) is False


def test_weibo_apply_cookie_resets_validity(monkeypatch):
    """登录成功后直接置有效缓存，UI 无需再探测。"""
    monkeypatch.setattr(wam, "save_env_keys", lambda values: None)  # 不落盘
    mgr = wam.WeiboAuth()
    mgr.cookie = ""
    mgr._valid = False
    mgr.apply_cookie("SUB=new", "2", "新号")
    assert mgr.cookie == "SUB=new"
    assert mgr._valid is True
    assert mgr.needs_login is False


# ── 微博扫码会话（httpx mock） ─────────────────────────────────────────

def _route(handler_map):
    def handler(request):
        for key, resp in handler_map.items():
            if key in str(request.url):
                return resp
        return httpx.Response(404, text="not found")
    return handler


def _v2_image_resp(qrid="QR123"):
    """v2 返回裸 base64（历史形态）"""
    import base64
    b64 = base64.b64encode(b"FAKE-PNG").decode("ascii")
    return httpx.Response(200, json={
        "retcode": 20000000, "msg": "succ",
        "data": {"qrid": qrid, "image": b64},
    })


def _v2_image_url_resp(qrid="QR456"):
    """v2 返回图片 URL（实测形态：v2.qr.weibo.cn/inf/gen）"""
    return httpx.Response(200, json={
        "retcode": 20000000, "msg": "succ",
        "data": {"qrid": qrid,
                 "image": "https://v2.qr.weibo.cn/inf/gen?api_key=abc&size=180"},
    })


def _check_resp(retcode, alt="ALT-1"):
    payload = {"retcode": retcode, "msg": "x"}
    if retcode in (20000000, "20000000"):
        payload["data"] = {"alt": alt}
    return httpx.Response(200, json=payload)


def test_weibo_session_v2_start_and_poll(monkeypatch):
    session = wam.WeiboLoginSession(wam.WeiboAuth())
    session.client = httpx.AsyncClient(transport=httpx.MockTransport(_route({
        "/sso/v2/qrcode/image": _v2_image_resp(),
        "/sso/v2/qrcode/check": _check_resp(50114001),
    })))

    async def run():
        data = await session.start()
        s1, _ = await session.poll()
        return data, s1

    data, s1 = asyncio.run(run())
    assert data is not None
    assert data["image"].startswith("data:image/png;base64,")
    assert s1 == "waiting"


def test_weibo_session_v2_image_as_url(monkeypatch):
    """修复：v2 实测返回图片 URL（v2.qr.weibo.cn/inf/gen），
    后端须拉取字节转真实 base64 data URL，而非把 URL 拼进前缀。"""
    import base64

    session = wam.WeiboLoginSession(wam.WeiboAuth())
    session.client = httpx.AsyncClient(transport=httpx.MockTransport(_route({
        "/sso/v2/qrcode/image": _v2_image_url_resp(),
        "/inf/gen": httpx.Response(200, content=b"REAL-PNG-BYTES"),
    })))

    async def run():
        return await session.start()

    data = asyncio.run(run())
    assert data is not None
    assert data["image"].startswith("data:image/png;base64,")
    b64 = data["image"].split(",", 1)[1]
    assert base64.b64decode(b64) == b"REAL-PNG-BYTES"


def test_weibo_session_poll_states(monkeypatch):
    responses = iter([_check_resp(50114002), _check_resp(20000000, alt="ALT-9")])
    session = wam.WeiboLoginSession(wam.WeiboAuth())
    session.client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: next(responses)))
    session.qrid = "QR123"

    async def run():
        return await session.poll(), await session.poll()

    (s1, _), (s2, payload) = asyncio.run(run())
    assert s1 == "scanned"
    assert s2 == "confirmed"
    assert payload is not None
    assert payload["data"]["alt"] == "ALT-9"


def test_weibo_session_complete_persists_cookie(monkeypatch):
    captured = {}
    monkeypatch.setattr(wam, "save_env_keys", lambda values: captured.update(values))

    auth = wam.WeiboAuth()
    session = wam.WeiboLoginSession(auth)
    session.client = httpx.AsyncClient(transport=httpx.MockTransport(_route({
        "/sso/login.php": httpx.Response(200, json={
            "retcode": "0", "uid": "3669102477", "nick": "鞠婧祎",
            "crossDomainUrlList": ["https://passport.weibo.com/wbsso/login?x=1"],
        }),
        "/wbsso/login": httpx.Response(
            200, json={"retcode": 0},
            headers={"set-cookie": "SUB=_2A25x; Path=/; Domain=.weibo.com"},
        ),
    })))

    async def run():
        ok, detail = await session.complete({"data": {"alt": "ALT-9"}})
        return ok, detail

    ok, detail = asyncio.run(run())
    assert ok is True
    assert detail == "鞠婧祎"
    assert auth.cookie.startswith("SUB=")
    assert captured.get("WEIBO_COOKIE", "").startswith("SUB=")
    assert captured.get("WEIBO_UID") == "3669102477"
    assert captured.get("WEIBO_NAME") == "鞠婧祎"


def test_weibo_session_complete_via_data_url(monkeypatch):
    """实测形态：确认响应 data.url 为完整登录 URL（内嵌 alt）。
    直接 GET data.url → 返回 uid/nick/crossDomainUrlList → 补种 → cookie 持久化。"""
    captured = {}
    monkeypatch.setattr(wam, "save_env_keys", lambda values: captured.update(values))

    auth = wam.WeiboAuth()
    session = wam.WeiboLoginSession(auth)
    login_url = "https://passport.weibo.com/sso/v2/login?entry=mweibo&alt=ALT-V2&url=https%3A%2F%2Fweibo.com"
    session.client = httpx.AsyncClient(transport=httpx.MockTransport(_route({
        "/sso/v2/login": httpx.Response(200, json={
            "retcode": "0", "uid": "3669102477", "nick": "鞠婧祎",
            "crossDomainUrlList": ["https://passport.weibo.com/wbsso/login?x=1"],
        }),
        "/wbsso/login": httpx.Response(
            200, json={"retcode": 0},
            headers={"set-cookie": "SUB=_2A25v; Path=/; Domain=.weibo.com"},
        ),
    })))

    async def run():
        ok, detail = await session.complete({"retcode": 20000000, "data": {"url": login_url}})
        return ok, detail

    ok, detail = asyncio.run(run())
    assert ok is True
    assert detail == "鞠婧祎"
    assert auth.cookie.startswith("SUB=")
    assert captured.get("WEIBO_UID") == "3669102477"


def test_weibo_session_complete_dedupes_same_name_cookies(monkeypatch):
    """回归：登录与跨域补种会在不同域名种同名 SUB，旧 dict(cookies) 抛
    「Multiple cookies exist with name=SUB」。jar 遍历按名去重置顶（后置优先）。"""
    captured = {}
    monkeypatch.setattr(wam, "save_env_keys", lambda values: captured.update(values))

    session = wam.WeiboLoginSession(wam.WeiboAuth())
    session.client = httpx.AsyncClient(transport=httpx.MockTransport(_route({
        "/sso/v2/login": httpx.Response(
            200, json={"retcode": "0", "uid": "1", "nick": "测试",
                      "crossDomainUrlList": ["https://passport.weibo.com/wbsso/login"]},
            headers={"set-cookie": "SUB=SINA; Path=/; Domain=.sina.com.cn"},
        ),
        "/wbsso/login": httpx.Response(
            200, json={"retcode": 0},
            headers={"set-cookie": "SUB=WEIBO; Path=/; Domain=.weibo.com"},
        ),
    })))

    async def run():
        return await session.complete({"data": {"url": "https://passport.weibo.com/sso/v2/login?alt=ALT-1"}})

    ok, _ = asyncio.run(run())
    assert ok is True
    cookie = captured.get("WEIBO_COOKIE", "")
    assert cookie.startswith("SUB=WEIBO")          # 后置的 .weibo.com SUB 胜出
    assert cookie.count("SUB=") == 1               # 同名去重


def test_weibo_session_complete_missing_sub_fails(monkeypatch):
    session = wam.WeiboLoginSession(wam.WeiboAuth())
    session.client = httpx.AsyncClient(transport=httpx.MockTransport(_route({
        "/sso/login.php": httpx.Response(200, json={
            "retcode": "0", "uid": "1", "nick": "x",
            "crossDomainUrlList": ["https://passport.weibo.com/wbsso/login?x=1"],
        }),
        "/wbsso/login": httpx.Response(200, json={"retcode": 0}),  # 无 Set-Cookie
    })))

    async def run():
        return await session.complete({"data": {"alt": "ALT-9"}})

    ok, detail = asyncio.run(run())
    assert ok is False
    assert "SUB" in detail


def test_weibo_extract_alt_variants():
    sess = wam.WeiboLoginSession(wam.WeiboAuth())
    assert sess._extract_alt({"data": {"alt": "ALT-1"}}) == "ALT-1"
    assert sess._extract_alt({"alt": "ALT-2"}) == "ALT-2"
    assert sess._extract_alt({"data": "ALT-3"}) == "ALT-3"
    assert sess._extract_alt({"data": {"x": 1}}) == ""
    assert sess._extract_alt(None) == ""


def test_unwrap_jsonp():
    a = wam._unwrap_jsonp('STK_123({"retcode":20000000,"data":{"qrid":"q"}});')
    assert a is not None and a["retcode"] == 20000000
    b = wam._unwrap_jsonp('{"retcode":1}')
    assert b is not None and b["retcode"] == 1
    assert wam._unwrap_jsonp("") is None
    assert wam._unwrap_jsonp("not json") is None


# ── B 站扫码会话（真机响应结构回归，2026-09-08） ────────────────────────

def _bili_handler(poll_payload, callback=None, nav=None):
    def handler(request):
        u = str(request.url)
        if "/qrcode/generate" in u:
            return httpx.Response(200, json={
                "code": 0, "message": "OK",
                "data": {"url": "https://account.bilibili.com/h5/scan-web?x=1",
                         "qrcode_key": "K1"},
            })
        if "/qrcode/poll" in u:
            return httpx.Response(200, json=poll_payload)
        if "crossDomain" in u:
            return callback or httpx.Response(200, text="ok")
        if "/nav" in u:
            return nav or httpx.Response(200, json={
                "code": 0, "message": "0",
                "data": {"isLogin": True, "mid": 1062902765, "uname": "测试号"},
            })
        return httpx.Response(404, text="not found")
    return handler


def _bili_session(handler):
    from app.services.auth import BilibiliLoginSession, auth_manager
    sess = BilibiliLoginSession(auth_manager)
    sess.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return sess


def test_bili_poll_reads_inner_data_code():
    """回归（2026-09-08 实机）：扫码状态在 data.code，外层 code 恒为 0。

    旧实现读外层 code → 每次轮询都判成「已确认」→ complete() 拿到空 data.url
    → 取不到凭据 → nav -101，用户看到「刷新二维码后立刻失效 / 确认了没反应」。
    """
    cases = [(86101, "waiting"), (86090, "scanned"), (0, "confirmed"), (86038, "expired")]
    for inner, expect in cases:
        sess = _bili_session(_bili_handler({
            "code": 0, "message": "OK",
            "data": {"url": "", "refresh_token": "", "timestamp": 0,
                     "code": inner, "message": "x"},
        }))
        sess.qrcode_key = "K1"
        status, _ = asyncio.run(sess.poll())
        asyncio.run(sess.close())
        assert status == expect, f"data.code={inner} 应判为 {expect}，实得 {status}"


def test_bili_poll_falls_back_to_outer_code():
    """异常/老结构（无 data）时退回外层 code。"""
    sess = _bili_session(_bili_handler({"code": 86038, "message": "二维码已失效"}))
    sess.qrcode_key = "K1"
    status, _ = asyncio.run(sess.poll())
    asyncio.run(sess.close())
    assert status == "expired"


def test_bili_pick_cookie_handles_duplicate_names():
    """回归：回调会在多域各写一份 SESSDATA → httpx `Cookies.get` 抛 CookieConflict
    （用户实机报错「Multiple cookies exist with name=SESSDATA」）。按域挑 .bilibili.com。"""
    from app.services.auth import BilibiliAuth, _pick_cookie

    jar = httpx.Cookies()
    jar.set("SESSDATA", "BILIGAME", domain="passport.biligame.com", path="/")
    jar.set("SESSDATA", "BILI", domain=".bilibili.com", path="/")
    assert _pick_cookie(jar, "SESSDATA") == "BILI"

    resp = httpx.Response(200, headers=[
        ("set-cookie", "SESSDATA=BILIGAME; Domain=passport.biligame.com; Path=/"),
        ("set-cookie", "SESSDATA=BILI; Domain=.bilibili.com; Path=/"),
    ], request=httpx.Request("GET", "https://passport.bilibili.com/x"))
    extracted = BilibiliAuth()._parse_set_cookie(resp)
    assert extracted["SESSDATA"] == "BILI"


def test_bili_complete_uses_callback_url_credentials(monkeypatch):
    """确认后：回调 URL 查询串（crossDomain 权威值）→ nav 校验 → 落盘。"""
    from app.services import auth as am
    from app.services.auth import BilibiliAuth

    saved: dict = {}
    monkeypatch.setattr(am, "save_env_keys", lambda values: saved.update(values))

    cb = ("https://passport.biligame.com/crossDomain?DedeUserID=1062902765"
          "&SESSDATA=deadbeef%2C1789000000%2Cabc&bili_jct=JCT123"
          "&gourl=https%3A%2F%2Fwww.bilibili.com")
    sess = _bili_session(_bili_handler(None))
    sess.auth = BilibiliAuth()
    sess.auth.sessdata = sess.auth.bili_jct = sess.auth.dede_user_id = ""
    # R26：`complete()` 末尾会补一次 `ensure_device_ids()`（没有就领一份设备号）。
    # 本用例只管回调凭据，所以直接标成"已就位" —— 免得测试去联网（就位时它不发请求）。
    sess.auth.buvid3 = sess.auth.buvid4 = "already-there"

    ok, detail = asyncio.run(sess.complete({"data": {"url": cb, "refresh_token": "RT1"}}))
    asyncio.run(sess.close())

    assert ok is True and detail == "1062902765"
    assert sess.auth.sessdata == "deadbeef,1789000000,abc"
    assert sess.auth.bili_jct == "JCT123"
    assert sess.auth.dede_user_id == "1062902765"
    assert sess.auth.refresh_token == "RT1"
    assert saved.get("BILI_SESSDATA") == "deadbeef,1789000000,abc"


def test_bili_complete_rejects_empty_callback():
    """空回调地址必须直接失败（旧行为会空跑 nav 撞 -101，报错还看不出原因）。"""
    from app.services.auth import BilibiliAuth, BilibiliLoginSession

    sess = BilibiliLoginSession(BilibiliAuth())
    ok, detail = asyncio.run(sess.complete({"data": {"url": ""}}))
    assert ok is False
    assert "重新扫码" in detail


# ── R26：设备指纹（buvid3 / buvid4）──────────────────────────────────────
# 起因（devlog/126 真机 A/B）：web API 认的是 `buvid3`，而本仓库把登录响应里的 `bvuid3`
# 当 `bvuid3=` 发回去 —— 服务端每次都当"没有设备号的新访客"，还会铸一枚新 `buvid3` 塞回来
# （实测：带 `bvuid3=` 时仍会铸，带 `buvid3=` 时才不铸）。

def _auth_blank(**kw):
    """造一个凭据全空的 auth 实例（避免读到开发机 .env 里的真值）。"""
    from app.services.auth import BilibiliAuth

    a = BilibiliAuth()
    a.sessdata = a.bili_jct = a.dede_user_id = a.buvid3 = a.buvid4 = a.refresh_token = ""
    for key, val in kw.items():
        setattr(a, key, val)
    return a


def test_cookie_header_uses_canonical_buvid3_name():
    """**本批的核心一行**：设备号必须叫 `buvid3`，不能再是 `bvuid3`。"""
    a = _auth_blank(sessdata="S", bili_jct="J", dede_user_id="9",
                    buvid3="B" * 46, buvid4="C" * 76)
    ck = a.cookie_str
    assert "buvid3=" + "B" * 46 in ck
    assert "buvid4=" + "C" * 76 in ck
    assert "bvuid3=" not in ck                      # 老名字不许再出现


def test_cookie_header_omits_empty_device_ids():
    """值为空的那条不发（发 `buvid3=` 空值比不发更可疑）。"""
    a = _auth_blank(sessdata="S", bili_jct="J", dede_user_id="9")
    assert a.cookie_str == "SESSDATA=S; bili_jct=J; DedeUserID=9"
    b = _auth_blank(sessdata="S", bili_jct="J", dede_user_id="9", buvid3="B" * 46)
    assert b.cookie_str == "SESSDATA=S; bili_jct=J; DedeUserID=9; buvid3=" + "B" * 46
    assert "buvid4" not in b.cookie_str


def test_device_id_captured_from_both_legacy_and_canonical_names(monkeypatch):
    """登录响应给 `bvuid3`、主站给 `buvid3` —— 两个名字都要认，同时出现时以规范名为准。

    `_parse_set_cookie` 返回的是**原始 cookie 名**（映射到属性发生在 `_apply_cookies`），
    所以两段分开断言：先看能不能抓到，再看冲突时谁赢。
    """
    from app.services import auth as am

    # ⚠️ `_apply_cookies` 成功后会 `_save_to_env()` —— 本用例只管抓取与优先级，
    # 必须把落盘打桩（2026-09-16 实测踩到：不桩就会写掉开发机上的 .env）
    monkeypatch.setattr(am, "save_env_keys", lambda values: None)

    a = _auth_blank()
    legacy = httpx.Response(200, headers=[("set-cookie", "bvuid3=LEGACY; Path=/")],
                            request=httpx.Request("GET", "https://passport.bilibili.com/x"))
    assert a._parse_set_cookie(legacy)["bvuid3"] == "LEGACY"

    canonical = httpx.Response(200, headers=[("set-cookie", "buvid3=CANON; Path=/")],
                               request=httpx.Request("GET", "https://www.bilibili.com/"))
    assert a._parse_set_cookie(canonical)["buvid3"] == "CANON"

    # 冲突时规范名赢 —— 两种先后顺序都要一样（不能依赖 Set-Cookie 的顺序）
    a._apply_cookies({"bvuid3": "LEGACY", "buvid3": "CANON"})
    assert a.buvid3 == "CANON"
    b = _auth_blank()
    b._apply_cookies({"buvid3": "CANON", "bvuid3": "LEGACY"})
    assert b.buvid3 == "CANON"

    # 只有老名字时照样要认（登录响应那一路就是它）
    c = _auth_blank()
    c._apply_cookies({"bvuid3": "LEGACY"})
    assert c.buvid3 == "LEGACY"


class _FakeSpiClient:
    """假的 httpx 客户端：只回答设备指纹端点。"""

    def __init__(self, payload=None, boom=False):
        self.payload = payload or {"code": 0, "data": {"b_3": "B" * 46, "b_4": "C" * 76}}
        self.boom = boom
        self.calls = 0

    async def __aenter__(self):
        if self.boom:
            raise RuntimeError("network down")
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None):
        self.calls += 1
        assert "finger/spi" in url
        return httpx.Response(200, json=self.payload)


def test_ensure_device_ids_mints_once_and_persists(monkeypatch):
    """没有设备号 → 领一份（公开端点）→ 落盘；第二次数不再发请求。"""
    from app.services import auth as am

    fake = _FakeSpiClient()
    monkeypatch.setattr(am, "new_async_client", lambda *a, **k: fake)
    saved: dict = {}
    monkeypatch.setattr(am, "save_env_keys", lambda values: saved.update(values))

    a = _auth_blank()
    assert asyncio.run(a.ensure_device_ids()) is True
    assert a.buvid3 == "B" * 46 and a.buvid4 == "C" * 76
    assert saved["BILI_BUVID_3"] == "B" * 46 and saved["BILI_BUVID_4"] == "C" * 76
    assert "buvid3=" + "B" * 46 in a.cookie_str
    assert fake.calls == 1

    assert asyncio.run(a.ensure_device_ids()) is False       # 已就位：不发请求
    assert fake.calls == 1


def test_ensure_device_ids_failure_is_silent(monkeypatch):
    """领号失败只记日志：少一层指纹不影响任何抓取功能。"""
    from app.services import auth as am

    monkeypatch.setattr(am, "new_async_client", lambda *a, **k: _FakeSpiClient(boom=True))
    monkeypatch.setattr(am, "save_env_keys", lambda values: pytest.fail("不该落盘"))
    a = _auth_blank()
    assert asyncio.run(a.ensure_device_ids()) is False
    assert a.buvid3 == "" and a.buvid4 == ""


def test_bili_complete_calls_ensure_device_ids(monkeypatch):
    """扫码确认后要补一次"没有设备号就领一份"。"""
    from app.services import auth as am
    from app.services.auth import BilibiliAuth

    calls: list[int] = []

    async def _spy(self):
        calls.append(1)
        return False

    monkeypatch.setattr(am.BilibiliAuth, "ensure_device_ids", _spy)
    monkeypatch.setattr(am, "save_env_keys", lambda values: None)

    cb = ("https://passport.biligame.com/crossDomain?DedeUserID=1062902765"
          "&SESSDATA=deadbeef%2C1789000000%2Cabc&bili_jct=JCT123")
    sess = _bili_session(_bili_handler(None))
    sess.auth = BilibiliAuth()
    sess.auth.sessdata = sess.auth.bili_jct = sess.auth.dede_user_id = ""

    ok, _ = asyncio.run(sess.complete({"data": {"url": cb}}))
    asyncio.run(sess.close())
    assert ok is True and calls == [1]
