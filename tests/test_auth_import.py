# -*- coding: utf-8 -*-
"""浏览器扩展的凭据导入（`POST /auth/import`）与配对凭证（E1，`docs/plans/browser-extension-cookie-sync-execution.md`）。

## 这批解决的痛点

四个平台的凭据今天要么只能**扫码**（B 站 / 微博），要么手抄整条 Cookie 粘进设置窗
（小红书 / 抖音，抖音还要手抄 UA）；而抄漏了键**在导入那一刻不报**，要等抓取时才炸
（缺 `a1` 时签名器直接报 `Missing 'a1' in cookies`）。扩展一键同步要的就是
"**推进来的那一刻就校验、缺哪个键现在就说**"。

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | 配对 token 不对 ⇒ 401（**端点公开，凭证自带**） | 本机任何进程/网页都能往里灌 cookie |
| ② | 非回环来源 ⇒ 403 | 同上网 |
| ③ | 缺必需键 ⇒ 400 **且 `.env` 一个字节没变** | "存进去了但永远抓不到"——最难排查的形态 |
| ④ | 上游明确说未登录 ⇒ 400 且**内存与 `.env` 都还原** | 旧的好凭据被一条过期的冲掉 |
| ⑤ | 上游连不上（网络问题）⇒ **照样保存**，但回执如实说"没验成" | 网络抖一下就不让同步，功能等于没有 |
| ⑥ | 回执**只给键名与数量，绝不回显 cookie 值** | 值进日志/界面 = 二次泄露 |
| ⑦ | 连续猜错 ⇒ 429 | 公开端点成了无限次数的猜谜机 |
| ⑧ | `GET /auth/pairing` 要**应用 token**（它给的就是 token 本身） | 任何网页都能读到配对凭证 |

⚠️ **不要**在这里断言"响应没有 CORS 头"：本仓的 CORS 默认是 `"*"`，而且那是**有意**的
（`devlog/201`《CORS 不是主防线》—— 拿不到 token 的网页读到 401 也没用）。
这条端点的防线是**配对 token + 回环 + 节流**，不是 CORS。
"""
from __future__ import annotations

import atexit
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core import api_auth
from app.core.database import Base, get_db
from app.main import app
from app.services import cookie_import as CI
from app.services import pairing as P
from app.services.auth import auth_manager
from app.services.douyin_auth import douyin_auth_manager
from app.services.weibo_auth import weibo_auth_manager
from app.services.xhs_auth import xhs_auth_manager

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-import-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'import.db').as_posix()}",
                        connect_args={"check_same_thread": False})
_Session = sessionmaker(bind=_engine, autoflush=False, autocommit=False)


def _override_get_db():
    db = _Session()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _test_db():
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    Base.metadata.create_all(bind=_engine)
    P.reset_throttle()                 # 进程内小账本：跨用例串味会让 429 判据时绿时红
    yield
    P.reset_throttle()
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    Base.metadata.drop_all(bind=_engine)


@pytest.fixture
def client():
    """**回环来源**的客户端。

    ⚠️ `TestClient` 默认的 `request.client.host` 是 `"testclient"`，而本端点的第一道门
    就是"来源必须是回环"⇒ 不显式给 `client=` 的话整片用例都会拿到 403
    （第一次跑就是这么红的：17 条里 17 条 403）。**不许**为了测试把 `is_loopback`
    放宽成"也认 testclient"—— 那是拿产品代码迁就测试。
    """
    return TestClient(app, client=("127.0.0.1", 41000))


@pytest.fixture
def pair_token(client):
    """当前配对 token（端点自己会在首次调用时生成）。"""
    r = client.get("/auth/pairing")
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _post(client, platform: str, cookie: str, token: str | None = None, **extra):
    headers = {CI.PAIR_HEADER: token} if token is not None else {}
    return client.post("/auth/import",
                       json={"platform": platform, "cookie": cookie, **extra},
                       headers=headers)


def _env_bytes() -> bytes | None:
    """当前 `.env` 的字节（conftest 已把它重定向到临时文件）。"""
    from app.services import env_store

    p = Path(env_store.ENV_PATH)
    return p.read_bytes() if p.exists() else None


# ── ① 配对 token（拒绝路径先写）─────────────────────────────────────────────

def test_import_without_pairing_token_is_rejected(client, pair_token):
    """没有 `X-DDToolkit-Pair` ⇒ 401。

    反向验证：把 `ci.PAIR_HEADER` 的校验去掉 ⇒ 红。
    """
    r = _post(client, "xiaohongshu", "a1=x; web_session=y")
    assert r.status_code == 401, r.text


def test_import_with_wrong_pairing_token_is_rejected(client, pair_token):
    r = _post(client, "xiaohongshu", "a1=x; web_session=y", token="not-the-token")
    assert r.status_code == 401, r.text


def test_import_token_is_not_the_app_token(client, pair_token):
    """**两把钥匙不许互相冒充**（两个方向都判）。

    反向验证：把端点里的配对校验换成 `api_auth.is_authorized(...)` ⇒ ① 红。
    """
    # ① 应用 token 当配对 token 用 ⇒ 401（端点不认它）
    r = _post(client, "xiaohongshu", "a1=x; web_session=y", token="pytest-session-token")
    assert r.status_code == 401, r.text
    # ② 反过来也一样：配对 token 不能当应用 token 用（业务端点不认它）
    # ⚠️ 必须**换一个客户端**：conftest 会给每个 `TestClient` 默认塞上正确的应用 token
    #    ⇒ 不换的话这条断言证明的是"夹具给了 token"，与配对 token 无关（第一次跑就是这么假绿的）。
    other = TestClient(app, client=("127.0.0.1", 41001),
                       headers={api_auth.TOKEN_HEADER: "not-the-app-token",
                                CI.PAIR_HEADER: pair_token})
    assert other.get("/vtuber/list").status_code == 401, "配对 token 不该能过业务端点的门"


# ── ② 回环 ────────────────────────────────────────────────────────────────

def test_is_loopback_pure_function():
    """回环判定是纯函数（端点里那一条依赖它）。"""
    for ok in ("127.0.0.1", "::1", "127.0.0.5"):
        assert CI.is_loopback(ok) is True, ok
    for bad in ("1.2.3.4", "testclient", "", None, "localhost", "0.0.0.0"):
        assert CI.is_loopback(bad) is False, bad


def test_import_rejects_non_loopback_client(pair_token):
    """来源不是回环 ⇒ 403（端口可扫，这一层挡的是"同网段的另一台机器"）。"""
    far = TestClient(app, client=("10.1.2.3", 4242))
    r = _post(far, "xiaohongshu", "a1=x; web_session=y", token=pair_token)
    assert r.status_code == 403, r.text


# ── ③ 缺键：不落盘 ────────────────────────────────────────────────────────

def test_missing_required_keys_are_reported_and_nothing_is_written(client, pair_token):
    """小红书只给 `web_session`（缺 `a1`）⇒ 400，回执点名缺哪个，`.env` 一个字节没变。"""
    before = _env_bytes()
    r = _post(client, "xiaohongshu", "web_session=y", token=pair_token)
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["missing"] == ["a1"], body
    assert "a1" in body["note"], body
    assert _env_bytes() == before, "校验没过却写了 .env"
    assert xhs_auth_manager.cookie == "", "校验没过却改了内存里的 cookie"


def test_unknown_platform_is_rejected(client, pair_token):
    r = _post(client, "tiktok", "x=1", token=pair_token)
    assert r.status_code == 400, r.text
    assert r.json()["ok"] is False


# ── ④ B 站：上游说未登录 ⇒ 不落盘且还原内存 ─────────────────────────────────

@pytest.fixture
def bili_probe(monkeypatch):
    """把 `check_session` 换成可编程的替身（**形状与真身一致**：async、返回 bool）。"""
    calls: list[bool] = []

    async def fake(result: bool) -> bool:
        calls.append(result)
        return result

    async def ok():
        return await fake(True)

    async def bad():
        return await fake(False)

    monkeypatch.setattr(auth_manager, "check_session", ok, raising=True)
    yield ok, bad, calls
    # 用 monkeypatch 打桩 ⇒ 用例结束自动还原；这里只清内存凭据，免得串到邻居
    auth_manager.sessdata = ""
    auth_manager.bili_jct = ""


def test_bilibili_cookie_is_parsed_probed_and_saved(client, pair_token, bili_probe):
    """有效 cookie：解析 → 探活 → **才**落盘；回执给键名、不给值。"""
    cookie = ("SESSDATA=sess-secret-value; bili_jct=jct-secret-value; "
              "DedeUserID=42; buvid3=buv-secret-value")
    _ok, _bad, calls = bili_probe
    r = _post(client, "bilibili", cookie, token=pair_token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["verified"] is True, body
    assert calls == [True], "探活没跑（或跑了几次）"
    assert set(body["keys"]) >= {"SESSDATA", "bili_jct", "DedeUserID", "buvid3"}
    assert auth_manager.sessdata == "sess-secret-value"
    assert auth_manager.bili_jct == "jct-secret-value"
    assert "BILI_SESSDATA=sess-secret-value" in _env_bytes().decode("utf-8")


def test_bilibili_expired_cookie_is_rejected_and_rolled_back(client, pair_token,
                                                            monkeypatch, bili_probe):
    """**过期 cookie 不许把好凭据冲掉**（内存与 `.env` 都要还原）。

    反向验证：把 `apply_cookie_checked` 里"先试后落盘"改成直接 `_apply_cookies`（会立刻落盘）
    ⇒ 本条红（`.env` 会带上新值）。
    """
    # 先让内存里有一条"旧的、好的"SESSDATA
    auth_manager.sessdata = "old-good-sess"
    auth_manager.bili_jct = "old-good-jct"
    before = _env_bytes()

    _ok, bad, _calls = bili_probe
    monkeypatch.setattr(auth_manager, "check_session", bad, raising=True)
    r = _post(client, "bilibili", "SESSDATA=new-but-expired; bili_jct=new-jct",
              token=pair_token)
    assert r.status_code == 400, r.text
    assert r.json()["ok"] is False
    assert auth_manager.sessdata == "old-good-sess", "失败了却没还原内存"
    assert auth_manager.bili_jct == "old-good-jct"
    assert _env_bytes() == before, "失败了却写了 .env"


def test_bilibili_missing_core_keys_is_rejected_without_probing(client, pair_token,
                                                                bili_probe):
    """连 `SESSDATA` 都没有 ⇒ 400，而且**不该去打上游**（省一发请求）。"""
    _ok, _bad, calls = bili_probe
    r = _post(client, "bilibili", "buvid3=only-device-id", token=pair_token)
    assert r.status_code == 400, r.text
    assert r.json()["missing"] == ["SESSDATA", "bili_jct"]
    assert calls == [], "缺键就不该跑探活"


def test_bilibili_network_failure_still_saves_but_says_unverified(client, pair_token,
                                                                  monkeypatch):
    """上游**连不上**（网络问题）与"上游说未登录"是两件事：前者照样保存，但如实说没验成。

    反向验证：把 `apply_cookie_checked` 里的 `ok is None` 分支当成失败 ⇒ 红。
    """
    async def boom():
        raise RuntimeError("connect error")

    monkeypatch.setattr(auth_manager, "check_session", boom, raising=True)
    r = _post(client, "bilibili", "SESSDATA=net-sess; bili_jct=net-jct", token=pair_token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["verified"] is False, body
    assert auth_manager.sessdata == "net-sess"
    assert "BILI_SESSDATA=net-sess" in _env_bytes().decode("utf-8")


# ── ④ 微博：现在没有校验，补上 ──────────────────────────────────────────────

def test_weibo_probe_failure_does_not_save(client, pair_token, monkeypatch):
    """微博探活失败 ⇒ 400 + 不落盘 + 内存还原（**这才是补上的那个缺口**）。"""
    monkeypatch.setattr(weibo_auth_manager, "cookie", "SUB=old-good")
    before = _env_bytes()

    async def bad():
        return False

    monkeypatch.setattr(weibo_auth_manager, "_probe_once", bad, raising=True)
    r = _post(client, "weibo", "SUB=new-but-dead; SSOLoginState=1", token=pair_token)
    assert r.status_code == 400, r.text
    assert weibo_auth_manager.cookie == "SUB=old-good", "失败了却没还原内存"
    assert _env_bytes() == before, "失败了却写了 .env"


def test_weibo_valid_cookie_is_saved(client, pair_token, monkeypatch):
    async def good():
        return True

    monkeypatch.setattr(weibo_auth_manager, "_probe_once", good, raising=True)
    r = _post(client, "weibo", "SUB=wb-secret; SSOLoginState=1", token=pair_token)
    assert r.status_code == 200, r.text
    assert r.json()["verified"] is True
    assert weibo_auth_manager.cookie == "SUB=wb-secret; SSOLoginState=1"
    assert "WEIBO_COOKIE=SUB=wb-secret" in _env_bytes().decode("utf-8")


def test_weibo_without_sub_is_rejected(client, pair_token):
    before = _env_bytes()
    r = _post(client, "weibo", "SSOLoginState=1", token=pair_token)
    assert r.status_code == 400, r.text
    assert r.json()["missing"] == ["SUB"]
    assert _env_bytes() == before


# ── ③ 抖音：UA 一起进来 ───────────────────────────────────────────────────

def test_douyin_cookie_and_ua_are_both_saved(client, pair_token):
    cookie = "uifid=u-secret; s_v_web_id=v-secret; ttwid=t-secret"
    r = _post(client, "douyin", cookie, token=pair_token,
              ua="Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verified"] is False, "抖音不做在线探活（只有键校验）"
    assert "在线探活" in body["note"] or "键" in body["note"], body
    env = _env_bytes().decode("utf-8")
    assert "DOUYIN_COOKIE=uifid=u-secret" in env
    assert "DOUYIN_UA=Mozilla/5.0" in env
    assert douyin_auth_manager.user_agent.startswith("Mozilla/5.0")


# ── ⑥ 回执不回显值 ────────────────────────────────────────────────────────

def test_receipt_never_echoes_the_cookie_value(client, pair_token, monkeypatch):
    """成功回执里不许出现 cookie 的值（键名可以）。

    反向验证：把 `keys` 改成 `cookie.split('; ')`（带值）⇒ 红。
    """
    secret = "SECRET-VALUE-MUST-NOT-LEAK"
    async def good():
        return True

    monkeypatch.setattr(weibo_auth_manager, "_probe_once", good, raising=True)
    r = _post(client, "weibo", f"SUB={secret}; SSOLoginState=1", token=pair_token)
    assert r.status_code == 200, r.text
    assert secret not in r.text, "回执回显了 cookie 值"
    assert "SUB" in r.json()["keys"]


# ── ⑦ 节流 ────────────────────────────────────────────────────────────────

def test_repeated_wrong_tokens_are_throttled(client, pair_token):
    """连错超过阈值 ⇒ 429（公开端点不能是无限次数的猜谜机）。"""
    codes = [_post(client, "weibo", "SUB=x", token=f"wrong-{i}").status_code
             for i in range(P.MAX_FAILURES + 2)]
    assert 429 in codes, f"没有节流：{codes}"
    assert codes[-1] == 429, f"节流之后仍放行：{codes}"
    # 正确的 token 也不该在冷却里被顺手放行（否则节流等于没有）
    assert _post(client, "weibo", "SUB=x", token=pair_token).status_code == 429


def test_a_successful_import_does_not_count_as_failure(client, pair_token, monkeypatch):
    for _ in range(P.MAX_FAILURES - 1):
        assert _post(client, "weibo", "SUB=x", token="wrong").status_code == 401

    async def good():
        return True

    monkeypatch.setattr(weibo_auth_manager, "_probe_once", good, raising=True)
    assert _post(client, "weibo", "SUB=ok", token=pair_token).status_code == 200


# ── ⑧ 配对端点本身要应用 token ────────────────────────────────────────────

def test_pairing_endpoint_is_protected_and_stable(client, pair_token):
    """`GET /auth/pairing`：要应用 token；同一个 token 反复读都一样（持久化，不是每次随机）。"""
    anon = TestClient(app, headers={api_auth.TOKEN_HEADER: "deliberately-wrong"})
    assert anon.get("/auth/pairing").status_code == 401

    again = client.get("/auth/pairing")
    assert again.status_code == 200
    assert again.json()["token"] == pair_token, "配对 token 每次读都在变（没落库？）"
    assert len(pair_token) >= 32, "token 太短"


def test_reset_invalidates_the_old_token(client, pair_token, monkeypatch):
    """重置之后：旧 token 立刻失效，新 token 当场可用。

    ⚠️ 第二条会走到微博的探活 ⇒ **必须打桩**：不打的话用例会真的打一次 weibo.com
    （首版就是这样：跑得慢、还依赖网络，而"上游说未登录"恰好让它看着是绿的）。
    """
    async def good():
        return True

    monkeypatch.setattr(weibo_auth_manager, "_probe_once", good, raising=True)

    r = client.post("/auth/pairing/reset")
    assert r.status_code == 200, r.text
    fresh = r.json()["token"]
    assert fresh and fresh != pair_token
    # 旧 token 立刻失效
    assert _post(client, "weibo", "SUB=x", token=pair_token).status_code == 401
    assert _post(client, "weibo", "SUB=x", token=fresh).status_code == 200   # 新 token 过门了


def test_pairing_survives_a_new_session(client, pair_token):
    """**重启后仍然有效**（用户口径：配一次长期有效）—— 同库新会话读出来还是同一个 token。"""
    db = _Session()
    try:
        assert P.current_token(db) == pair_token
    finally:
        db.close()


# ── 「上次同步」（E3 里那一栏要能自证"扩展真的说过话"）────────────────────────

def test_last_sync_is_recorded_with_key_names_only(client, pair_token):
    """成功导入之后 `GET /auth/pairing` 带上「上次同步」——**只有键名与计数，没有值**。"""
    secret = "XHS-SECRET-MUST-NOT-LEAK"
    r = _post(client, "xiaohongshu", f"a1={secret}; web_session=w-secret", token=pair_token)
    assert r.status_code == 200, r.text

    info = client.get("/auth/pairing").json()
    last = info.get("last_sync")
    assert last and last["platform"] == "xiaohongshu", info
    assert last["label"] == "小红书"
    assert set(last["keys"]) >= {"a1", "web_session"}
    assert last["cookie_keys"] == 2
    assert isinstance(last["at"], int) and last["at"] > 0
    # ⚠️ 记录里**不许**有任何 cookie 值（它会被界面显示出来）
    assert secret not in str(info), "「上次同步」里带了 cookie 值"


def test_failed_import_does_not_record_a_sync(client, pair_token, monkeypatch):
    """校验没过 ≠ 同步过：失败那条不许写「上次同步」（否则界面会谎报"上次同步"）。"""
    async def bad():
        return False

    monkeypatch.setattr(weibo_auth_manager, "_probe_once", bad, raising=True)
    assert _post(client, "weibo", "SUB=dead", token=pair_token).status_code == 400
    assert client.get("/auth/pairing").json()["last_sync"] is None


def test_last_sync_is_none_before_any_import(client, pair_token):
    """从没同步过 ⇒ `last_sync` 是 `None`（界面据此不显示那一行，而不是显示 1970 年）。"""
    assert client.get("/auth/pairing").json()["last_sync"] is None


# ── /healthz 的认领标识（E2 的扩展靠它认领端口）──────────────────────────────

def test_healthz_advertises_the_app_identifier(client):
    r = client.get("/healthz")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["app"] == "ddtoolkit", body
    for key in ("ok", "version", "first_run", "migration"):
        assert key in body, f"/healthz 少了既有键 {key}"
