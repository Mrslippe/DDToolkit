# -*- coding: utf-8 -*-
"""sidecar 会话 token 的认证门禁（S1，devlog/201）。

**为什么要有它**：后端监听 `127.0.0.1:<随机端口>`，而**端口可以扫**（65536 个，几秒）。
在此之前，本机任何进程、以及任何网页（`settings.CORS_ORIGINS` 默认 `"*"`）都能：
  · 读到你能读到的全部归档；
  · 改数据（增删 V / 账号 / 帖子、改设置）；
  · 触发抓取（**会打真上游**，白耗配额）；
  · 而 `.env` 里躺着**活的登录凭据**（B 站 SESSDATA + refresh token、微博 cookie）。

设计口径（见 `docs/ARCHITECTURE.md` §6 与 `docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §S1）：
  · 每次启动由 Tauri 生成高熵、**只存内存**的 token，经 sidecar 的 env 传入；
  · 后端用 `X-DDToolkit-Token` 头校验，**常量时间比较**；
  · 分级：`/healthz`、`/static/*`、`GET /img-proxy` 公开（`<img>` 带不了头），**其余一律要 token**；
  · 失败统一 401，**错误文本不回显 token**；
  · 开发态（没有 Tauri）允许显式配置固定 token —— 探针与 `npm run dev` 走这条。

⚠️ 关于"常量时间比较"：**不写"错 token 与对 token 耗时相同"那种断言** —— 单测测不出等时性，
写了就是装饰性断言（`docs/DEV-LOOP.md` §0.7）。这里改成**源码级**检查用的是
`hmac.compare_digest`（见本文件最后一条用例）。
"""
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from app.core import api_auth  # noqa: E402
from app.core.api_auth import require_token  # noqa: E402
from app.main import app  # noqa: E402

TOKEN = "test-token-0123456789abcdef"

# 需要 token 的代表性端点：覆盖**读**与**写**、覆盖每个 router。
PROTECTED = [
    ("GET", "/vtuber/list", None),
    ("GET", "/vtuber/fetch-status", None),
    ("GET", "/settings", None),
    ("GET", "/capabilities", None),
    ("POST", "/vtuber", {"name": "x"}),
    ("POST", "/vtuber/fetch-accounts", None),
    ("POST", "/settings/reset", None),
    ("POST", "/auth/bilibili/qr/start", None),
    ("POST", "/posts/archive", {}),
]

# 公开端点（**必须**保持公开，否则要么图片全都裂，要么启动就失败）。
PUBLIC = [
    ("GET", "/healthz"),
    ("GET", "/static/avatars/whatever.jpg"),
    ("GET", "/img-proxy?url=https://i0.hdslb.com/x.jpg"),
]


@pytest.fixture
def token(monkeypatch):
    """把 token 钉成确定值（`api_auth` 每次读，所以可以在用例里改）。

    ⚠️ **不再有"什么都不配就放行"这一态**（S1 收口，devlog/202）：
    所以每个碰业务端点的用例都必须先经过这个夹具。
    """
    monkeypatch.setattr(api_auth.settings, "API_TOKEN", TOKEN, raising=False)
    monkeypatch.setattr(api_auth.settings, "DEV_API_TOKEN", "", raising=False)
    return TOKEN


@pytest.fixture(autouse=True)
def _no_ambient_env_token(monkeypatch):
    """把**环境变量**里的 token 清掉（属性由 conftest 的夹具统一配）。

    为什么要清：`DEV_API_TOKEN` 由环境变量决定，而**跑完 `ui_probe` 之后 shell 里可能还留着
    `DDTOOLKIT_DEV_API_TOKEN`** ⇒ 本文件的用例会时绿时红，取决于那台机器上有没有残留 ——
    本仓记过的"本地残留环境恰好满足条件"的又一例。

    ⚠️ 这里**只碰环境变量，不碰 `settings` 属性**：`settings` 是类属性，
    setattr 会写进类、被后续测试文件继承；而"配哪个 token"由 `tests/conftest.py` 的
    目录级夹具统一负责（它还负责尾部还原）。
    """
    monkeypatch.delenv("DDTOOLKIT_API_TOKEN", raising=False)
    monkeypatch.delenv("DDTOOLKIT_DEV_API_TOKEN", raising=False)


@pytest.fixture
def client():
    """**纯 ASGI 小应用**，只挂认证中间件 —— 不碰真后端、不碰数据库。

    为什么不直接用 `app.main:app`（第一版就是这么写的，整套跑时红了）：
    那条"对 token ⇒ 放行"的用例打的是 `/vtuber/list`，而它要查**真实数据目录**的库
    （与 devlog/200 抓到的是同一类问题：测试碰到真数据目录，本地靠残留环境恰好能过）。
    认证门禁的用例**不该依赖任何业务表** —— 它验的是"门开不开"，不是"屋里有什么"。
    """
    probe = FastAPI()
    probe.middleware("http")(require_token)

    @probe.get("/__auth_probe")
    async def _probe():            # noqa: ANN202 - 返回固定 JSON，仅用于观察是否放行
        return {"reached": True}

    return TestClient(probe)


@pytest.fixture
def client_real_app():
    """真应用（只用于"公开路径"那一组 —— 那些路径确实挂在真应用上）。"""
    return TestClient(app)


# ── 拒绝路径（先写）────────────────────────────────────────────────────────

def test_protected_endpoints_reject_without_a_token(client_real_app, token):
    """**真应用上**逐端点枚举：无 token ⇒ 401（不抽查 —— 漏一个就是一个洞）。

    ⚠️ 这里必须用真应用而不是小探针：这条判据要证明的是"**真实路由表**里每一条业务
    端点都被挡住了"，小探针只能证明中间件本身有效。
    代价是它要起真应用（会跑 lifespan、连真库），所以**期望状态码写宽**
    （见下面 is_authorized 纯函数那一组为什么会单独存在）。

    反向验证：把 `app/main.py` 里注册中间件那行删掉 ⇒ 本用例整片红。
    """
    bad = []
    for method, path, body in PROTECTED:
        r = client_real_app.request(method, path, json=body)
        if r.status_code != 401:
            bad.append(f"{method} {path} → {r.status_code}（应 401）")
    assert not bad, "这些端点没被 token 挡住：\n  - " + "\n  - ".join(bad)


def test_every_protected_route_is_covered_by_the_decision_function(token):
    """**路由表对账**：真应用里的每条路由，除公开白名单外，都必须被判为"要 token"。

    这条是"逐端点枚举"的**枚举依据**：它直接读 `app.routes`，所以新加的路由
    **自动**落进检查范围 —— 不会因为写测试的人忘了往 `PROTECTED` 里加一行而留个洞。
    （上面那份 `PROTECTED` 是人工挑的代表性端点，这条才是全覆盖。）

    反向验证：把某条路由加入 `PUBLIC_PREFIXES` ⇒ 它会出现在"公开得可疑"的提示里。
    """
    unprotected = []
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None) or set()
        if not path or not path.startswith("/"):
            continue                      # 挂载点/静态目录等
        for m in methods:
            if m in ("HEAD", "OPTIONS"):
                continue                  # CORS 预检与 HEAD 不承载业务
            if not api_auth.is_authorized(m, path, None)[0]:
                continue                  # 已被要求 token ⇒ 正是我们要的
            if api_auth.is_public(m, path):
                continue                  # 显式白名单，下面单独核对
            unprotected.append(f"{m} {path}")
    assert not unprotected, (
        "这些路由既没被公开白名单认领、也没被要求 token（门漏了）：\n  - "
        + "\n  - ".join(unprotected))


def test_public_whitelist_is_exactly_what_we_intend(token):
    """公开白名单**必须只有**这三类 —— 多一个都是没注意到（少一个则是功能坏）。

    反向验证：往 `PUBLIC_PREFIXES` 里塞 `"/vtuber"` ⇒ 红。
    """
    assert api_auth.PUBLIC_PREFIXES == ("/healthz", "/static/")
    assert api_auth.PUBLIC_EXACT == {("GET", "/img-proxy")}


def test_wrong_token_is_rejected(client, token):
    """错 token ⇒ 401（**不能**因为"有头"就放行）。

    反向验证：把 `api_auth.is_authorized` 改成"有头就 True" ⇒ 红。
    """
    r = client.get("/__auth_probe", headers={api_auth.TOKEN_HEADER: "not-the-token"})
    assert r.status_code == 401


def test_correct_token_is_accepted(client, token):
    """对 token ⇒ 放行（否则整个应用 401，等于把功能关掉）。"""
    r = client.get("/__auth_probe", headers={api_auth.TOKEN_HEADER: TOKEN})
    assert r.status_code == 200, r.text
    assert r.json() == {"reached": True}


def test_public_endpoints_stay_open(client_real_app, token):
    """`/healthz`、`/static/*`、`GET /img-proxy` 保持公开。

    为什么必须公开：`<img>` 直连（`/static` 与 `/img-proxy`）**带不了自定义头**，
    给它们加鉴权就得把整条图片链路改成 blob（母计划 §9 的停止条件之一）；
    `/healthz` 还兼着桌面端的就绪探活（`main.tsx` 轮询它 240 次）。

    ⚠️ 只断言"**不是 401**"而不是"等于 200"：`/img-proxy` 要去真图床，
    在没网/CI 里可能是 502/504 —— 那些都说明"门放行了"，与 401 是两回事。

    反向验证：把 `/healthz` 从公开集合里删掉 ⇒ 红（真机上表现为"启动幕卡死"）。
    """
    bad = []
    for method, path in PUBLIC:
        r = client_real_app.request(method, path)
        if r.status_code == 401:
            bad.append(f"{method} {path} 被 401 挡了")
    assert not bad, "\n  - ".join(bad)


def test_failure_message_never_echoes_the_token(client, token):
    """401 的响应体**不得**包含 token（日志/异常/前端 toast 都会带出去）。

    反向验证：把 detail 改成 `f"invalid token: {token}"` ⇒ 红。
    """
    r = client.get("/__auth_probe", headers={api_auth.TOKEN_HEADER: TOKEN + "x"})
    assert r.status_code == 401
    assert TOKEN not in r.text, f"响应体回显了 token：{r.text}"


def test_token_never_appears_in_openapi_schema(client_real_app, token):
    """OpenAPI 文档里不得出现 token（它会被 `/docs` 与生成的 DTO 带出去）。

    反向验证：给某个参数加 `example=settings.API_TOKEN` ⇒ 红。
    """
    schema = client_real_app.get("/openapi.json").text
    if TOKEN in schema:
        pytest.fail("OpenAPI schema 里出现了 token")
    # 连"字段名"也不该被写成 example 值
    assert "X-DDToolkit-Token" not in schema, "token 头不该进 OpenAPI 的参数表"


def test_absent_token_configuration_is_reported_loudly(monkeypatch):
    """**没配 token** 时不能静默 —— 那是"S1 没生效"，而症状是"一切都正常"。

    判据取一个显式函数而不是"读日志"：日志断言脆弱且会被轮转/级别影响。
    反向验证：把 `token_configured()` 改成恒 True ⇒ 红。
    """
    monkeypatch.setattr(api_auth.settings, "API_TOKEN", "", raising=False)
    monkeypatch.setattr(api_auth.settings, "DEV_API_TOKEN", "", raising=False)
    assert api_auth.token_configured() is False

    monkeypatch.setattr(api_auth.settings, "API_TOKEN", TOKEN, raising=False)
    assert api_auth.token_configured() is True

    monkeypatch.setattr(api_auth.settings, "API_TOKEN", "", raising=False)
    monkeypatch.setattr(api_auth.settings, "DEV_API_TOKEN", TOKEN, raising=False)
    assert api_auth.token_configured() is True, "开发态显式 token 也算配好了"


def test_a_configured_token_actually_closes_the_door(monkeypatch):
    """配了 token 之后，**公开路径之外**的一切都要 token。

    反向验证：把 `hmac.compare_digest` 那行改成 `return True, "ok"` ⇒ 红。
    """
    monkeypatch.setattr(api_auth.settings, "API_TOKEN", TOKEN, raising=False)
    assert api_auth.is_authorized("GET", "/vtuber/list", None) == (False, "missing")
    assert api_auth.is_authorized("GET", "/vtuber/list", "wrong") == (False, "mismatch")
    assert api_auth.is_authorized("GET", "/vtuber/list", TOKEN)[0] is True
    # 公开路径在配了 token 之后**依然**公开
    assert api_auth.is_authorized("GET", "/healthz", None)[0] is True


def test_a_missing_token_configuration_denies_rather_than_allows(monkeypatch):
    """**没配 token ⇒ 拒绝**（S1 收口，devlog/202）。

    批次 1 期间这里是"放行"（让"前端注入还没落地"时应用仍可用）。那次过渡的代价是
    **"没配"与"配了"在行为上分不出来**，而症状是"一切正常"。
    收口之后：没配 = 每个业务请求 401 —— **吵闹的失败**，比安静地不设防好。

    反向验证：把 `return False, "no-token-configured"` 改回 `True` ⇒ 红。
    """
    monkeypatch.setattr(api_auth.settings, "API_TOKEN", "", raising=False)
    monkeypatch.setattr(api_auth.settings, "DEV_API_TOKEN", "", raising=False)

    assert api_auth.is_authorized("GET", "/vtuber/list", None) == \
        (False, "no-token-configured")
    # 公开路径不受影响（否则启动探活与图片会一起挂）
    assert api_auth.is_authorized("GET", "/healthz", None)[0] is True


def test_constant_time_comparison_is_actually_used():
    """**源码级**判据：比较必须走 `hmac.compare_digest`。

    为什么不用"测量耗时"：单测里的微秒级差别全被噪声淹没，那种断言只会时红时绿
    （`docs/DEV-LOOP.md` §0.7 的"装饰性断言"）。这条不优雅，但**它有牙口**。

    反向验证：把实现里的 `hmac.compare_digest` 换成 `==` ⇒ 红。
    """
    src = (ROOT / "app" / "core" / "api_auth.py").read_text(encoding="utf-8")
    assert "hmac.compare_digest" in src, "token 比较没有用常量时间函数"


# ── CORS 与 token 的关系（S1 落地时踩到的坑）────────────────────────────────

def test_cors_regex_reaches_allow_origin_regex_not_allow_origins():
    """`CORS_ORIGINS` 里的**正则**必须真的被当成正则用。

    为什么单列一条（2026-09-25 实测踩到，代价是一整轮排查）：
    `app/main.py` 原先把它拆成列表只喂 `allow_origins`，于是探针传进去的
    `http://(localhost|127\\.0\\.0\\.1):.*` 被当成**一个字面 origin**、**永远匹配不上**。
    症状极具误导性 ——
      · 后端日志里**一条 401 都没有**（请求到了、也是 200）；
      · 浏览器把响应拦在"读"那一步 ⇒ 页面数据全空 ⇒ 探针报
        "缺投稿 chip / 缺 list-video 帧 / 页面标题为空"，**看起来像内容或布局坏了**；
      · 判据是 `git stash` 掉 S1 改动后探针全绿。

    反向验证：把 `app/main.py` 的 `allow_origin_regex=_cors_regex` 删掉 ⇒ 红。
    """
    from app import main as app_main

    mw = next((m for m in app_main.app.user_middleware
               if getattr(m, "cls", None).__name__ == "CORSMiddleware"), None)
    assert mw is not None, "找不到 CORSMiddleware"
    kwargs = dict(mw.kwargs)
    if app_main._cors_regex is None:
        # 默认 `"*"`：没有正则，但必须确有通配（否则浏览器读不到响应）
        assert kwargs.get("allow_origins") == ["*"], "既没有正则、也没有通配来源"
    else:
        assert kwargs.get("allow_origin_regex") == app_main._cors_regex, \
            "正则没被传给 allow_origin_regex（会被当成一个字面 origin，永远匹配不上）"


def test_default_cors_stays_permissive_because_token_is_the_real_gate():
    """默认 CORS 保持 `"*"` —— **主防线是 token，不是 CORS**。

    这条**有意钉住一个反直觉的决定**：收紧 CORS 看起来更安全，但它会打断浏览器形态的
    开发态（探针 / `npm run dev` 跨源），而收益接近零 —— 拿不到 token 的网页即使能读到
    响应，读到的也只是 401。

    反向验证：把默认值改成 `""` ⇒ 红（同时探针会整片红，见上一条的说明）。
    """
    import os as _os

    from app.core.config import Settings

    assert Settings.CORS_ORIGINS == _os.getenv("CORS_ORIGINS", "*"), \
        "CORS 默认值被动过 —— 若是有意为之，先读 devlog/201 的「CORS 不是主防线」一节"
