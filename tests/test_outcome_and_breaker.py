"""B 站的**失败语义四类**与**端点熔断**（第 4 阶段 ⑦，devlog/239）。

判据分四组，每组盯一件"会静默错"的事：

| 组 | 错了会怎样 |
|---|---|
| ① 分类 | "号/稿件没了"被当成风控（白冷却）或网络（报告里假中断） |
| ② 口径同源 | 分类说风控、冷却没触发（或反过来）⇒ 两套判据分叉，用户看到自相矛盾的状态 |
| ③ 端点熔断 | 业务失败混进样本 ⇒ 一堆"号注销了"把整个端点判成故障；或熔断后还在打上游 |
| ④ 落库 | 重启后忘了"这个端点刚坏过" ⇒ 立刻再撞一遍（用户拍板要保住的那条） |
"""
import asyncio
import pathlib

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core import outcome as oc
from app.core.database import Base
from app.services import fetcher as F
from app.services import identity_limit as il
from app.services import scheduler as sch
from app.services.platforms import bilibili_posts as bp

# ── ① 四类分类 ────────────────────────────────────────────────────────

@pytest.mark.parametrize("code,kind", [
    (-404, "business_error"),      # 啥都木有
    (62002, "business_error"),     # 稿件不可见
    (62004, "business_error"),     # 稿件审核中
    (-403, "business_error"),      # 访问权限不足
    (-101, "cookie_invalid"),      # 账号未登录
    (-509, "risk_control"),        # 超出限制
    (-412, "risk_control"),        # 请求被拦截
    (-799, "risk_control"),        # 请求过于频繁
])
def test_bili_codes_map_to_diagnostic_kinds(code, kind):
    F.clear_rate_limit()
    try:
        assert F._note_failure(200, {"code": code}) == kind
        assert oc.last_failure()[0] == kind
    finally:
        F.clear_rate_limit()
        oc.clear()


def test_http_status_wins_over_unknown_codes():
    """状态码优先：**非 200 又不认识 ⇒ 保守按风控**；200 + 未知码 ⇒ 业务失败。

    理由：B 站的业务错是"HTTP 200 + 非零 code"，而认证/风控类问题会带非 200；
    未知的东西宁可多冷却一次，也不能让它从风控统计里消失。
    """
    F.clear_rate_limit()
    try:
        assert F._note_failure(502, {}) == "server_error"
        assert F._note_failure(404, {}) == "business_error"
        assert F._note_failure(403, {}) == "risk_control"          # 不认识的状态
        assert F._note_failure(200, {"code": -999999}) == "business_error"
        # 显式 kind 覆盖（空响应 / 非法 JSON 这类"上游给了不能用的东西"）
        assert F._note_failure(200, {}, kind="server_error") == "server_error"
    finally:
        F.clear_rate_limit()
        oc.clear()


def test_classification_shares_the_rate_limit_verdict():
    """⚠️ **口径同源**：分类里的风控必须与 `was_rate_limited()` 一致。

    这条钉的是"两套判据不会分叉"——`_note_failure` 直接复用 `was_rate_limited()`，
    而不是自己再写一张风控码表（反向验证：把 `_detect_rate_limit` 从 `_note_failure`
    的判据里去掉 ⇒ 本用例红）。
    """
    F.clear_rate_limit()
    try:
        F._detect_rate_limit(412)                     # 冷却用的判据置位
        assert F.was_rate_limited() is True
        assert F._note_failure(200, {"code": 0}) == "risk_control"
    finally:
        F.clear_rate_limit()
        oc.clear()

    # 没置位时，同一个"看起来像风控"的码也要按码表说话（-509 在码表里）
    assert F._note_failure(200, {"code": -509}) == "risk_control"
    F.clear_rate_limit()
    oc.clear()


def test_real_fetch_functions_record_the_reason(monkeypatch):
    """端到端：真 `fetch_bilibili_videos` 拿到业务错时，语义位要说得出是哪一类。

    ⚠️ 必须挡住 WBI 签名：`fetch_bilibili_videos` 会先 `wbi.sign_params()`，
    而它要打**真上游**取密钥（测试环境未登录 ⇒ 直接抛异常）。
    """
    async def fake_sign(params):
        return params

    monkeypatch.setattr(F.wbi, "sign_params", fake_sign)

    def handler(_request):
        return httpx.Response(200, json={"code": -404, "message": "啥都木有"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            out = await F.fetch_bilibili_videos("123", page=1, client=c)
            # ⚠️ 必须在**同一个协程里**读：`asyncio.run` 会为协程建一个新 Task，
            #    任务内写的 ContextVar **不会**冒泡回外层（读的地方也就读了个空）。
            return out, oc.last_failure()

    F.clear_rate_limit()
    oc.clear()
    try:
        out, failure = asyncio.run(run())
        assert out is None
        assert failure[0] == "business_error", failure
    finally:
        F.clear_rate_limit()
        oc.clear()


# ── ② stop_reason 只分"业务 / 其它" ────────────────────────────────────

@pytest.mark.parametrize("kind,reason", [
    ("business_error", "business_error"),
    ("server_error", "network_error"),
    ("cookie_invalid", "network_error"),
    ("gateway_missing", "network_error"),
    ("", "network_error"),          # 什么都没记 ⇒ 行为与改前一致（保守）
])
def test_none_stop_reason(kind, reason):
    oc.clear()
    if kind:
        oc.set_failure(kind, "x")
    try:
        assert sch._none_stop_reason() == reason
    finally:
        oc.clear()


def test_rate_limit_path_is_unchanged():
    """**风控那一支逐字不变**：置位 ⇒ `rate_limited=True` + `stop_reason="rate_limited"`。

    这条是"没改坏"的判据（本批只动 `None` 分支）。反向验证：把核心里的
    `if was_rate_limited():` 那段删掉 ⇒ 本用例红。
    """
    from app.services.platforms.streams import PostStreams

    async def fetch_video_page(uid, page, client):
        F._detect_rate_limit(412)          # 模拟上游风控（HTTP 412）
        return None

    async def fetch_dynamics_page(uid, offset, client):
        return {"items": [], "has_more": False, "next_cursor": None}

    streams = PostStreams(platform="bilibili", fetch_video_page=fetch_video_page,
                          fetch_dynamics_page=fetch_dynamics_page)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    monkey = sch._PAGE_RETRIES
    sch._PAGE_RETRIES = 0                  # 直接走"耗尽重试"那条路，别真睡
    try:
        result = asyncio.run(sch._fetch_posts_core("123", 1, 1, db, streams=streams))
    finally:
        sch._PAGE_RETRIES = monkey
        F.clear_rate_limit()
        db.close()
    assert result.rate_limited is True
    assert result.stop_reason == "rate_limited"


# ── ③ 端点记账与熔断 ──────────────────────────────────────────────────

def _mk_accounts(db, platform, uids):
    from app.models.vtuber import Account, VTuber
    v = VTuber(name="V")
    db.add(v)
    db.commit()
    for uid in uids:
        db.add(Account(vtuber_id=v.id, platform=platform, platform_uid=uid))
    db.commit()


def _first_account(db):
    from app.models.vtuber import Account
    return db.query(Account).first()


def test_bilibili_endpoints_are_not_rate_limited():
    """B 站**不装令牌桶**（用户拍板）：连发多次都放行，只有熔断能挡住。"""
    assert not (set(bp.BILI_ENDPOINTS) & set(il.ENDPOINT_RATE)), \
        "B 站端点不该出现在限速表里 —— 它的节奏由 R27/R28/R30 管"
    for ep in bp.BILI_ENDPOINTS:
        for _ in range(5):
            assert bp.admit_endpoint(ep) is True, f"{ep} 被限速了"


def test_endpoint_names_do_not_collide_across_platforms():
    """⚠️ 限速表的键是**全局**的（`Ledger._bucket` 只按 endpoint 查它）⇒ 两个平台**不能重名**。

    2026-10-04 接抖音时踩过：给它写了 `"detail": 0.12`，而 B 站详情抓取用的正是 `detail`
    （`bilibili_posts.py` 的 `admit_endpoint("detail")`）⇒ **抖音的限速把 B 站拖慢了**，
    两条用例当场红。这条判据把这个坑变成机器能查的：各平台的端点名必须两两不相交。
    """
    from app.services.platforms import xiaohongshu, douyin

    groups = {
        "bilibili": set(bp.BILI_ENDPOINTS),
        "xiaohongshu": {"user_posted", "otherinfo", "feed"},
        "douyin": {douyin.ENDPOINT_POSTS, douyin.ENDPOINT_PROFILE, douyin.ENDPOINT_DETAIL},
    }
    names = list(groups)
    for i, left in enumerate(names):
        for right in names[i + 1:]:
            overlap = groups[left] & groups[right]
            assert not overlap, f"{left} 与 {right} 共用了端点名 {overlap} —— 限速会串台"
    # 抖音那三个端点**必须**在表里（计划 §D0-3：单身份 ≤0.12 req/s；少写一个 = 那个端点不限速）。
    # ⚠️ 反过来不成立：端点没进表 = 不限速，是**允许**的（小红书详情 `feed` 就是如此）。
    assert groups["douyin"] <= set(il.ENDPOINT_RATE), "抖音端点没进限速表"


def test_business_errors_do_not_feed_the_breaker():
    """⚠️ 核心安全性质：**业务失败不进样本** —— 否则一堆"号注销了"会把端点判成故障。"""
    il.LEDGER.reset()
    oc.set_failure("business_error", "62002")
    try:
        for i in range(30):
            bp.observe_endpoint("video_list", f"u{i}", ok=False)
    finally:
        oc.clear()
    w = il.LEDGER.window(bp.bili_identity(), "video_list")
    assert w.samples == 0 and not w.tripped

    # 风控则要进样本（三个不同目标 × 8 次 ⇒ 熔断）
    oc.set_failure("risk_control", "412")
    try:
        for i in range(24):
            bp.observe_endpoint("video_list", f"u{i % 3}", ok=False)
    finally:
        oc.clear()
    assert il.LEDGER.window(bp.bili_identity(), "video_list").tripped is True
    assert bp.admit_endpoint("video_list") is False


def test_tripped_endpoint_sends_nothing_upstream(monkeypatch):
    """熔断之后**一个请求都不发**（否则"熔断"只是个日志）。

    ⚠️ 先做**正对照**（没熔断时确实会打上游）：没有它，"熔断后没打上游"这条断言
    可能因为"打错了函数名/压根没走到那儿"而永远成立 —— 反向验证实测踩到过。
    """
    il.LEDGER.reset()
    calls = {"n": 0}

    async def fake_dynamics(uid, offset="", client=None):
        calls["n"] += 1
        return {"items": [], "has_more": False, "next_cursor": None, "pinned_ids": []}

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)

    assert asyncio.run(sch._bili_fetch_dynamics_page("u1", "", None)) is not None
    assert calls["n"] == 1, "正对照失败：没熔断时本该打一发"
    il.LEDGER.reset()

    oc.set_failure("risk_control", "412")
    try:
        for i in range(24):
            bp.observe_endpoint("dynamics_feed", f"u{i % 3}", ok=False)   # 先把端点弄熔断
    finally:
        oc.clear()
    before = calls["n"]
    out = asyncio.run(sch._bili_fetch_dynamics_page("u1", "", None))
    assert out is None
    assert calls["n"] == before, "熔断后还在打上游"
    il.LEDGER.reset()


def test_every_declared_endpoint_is_actually_recorded():
    """结构判据：`BILI_ENDPOINTS` 里每个端点都得有**真的记账调用**。

    防的是"加了端点名却没接上"——那样熔断窗口永远是空的，看起来一切正常
    （反向验证：删掉任意一处 `observe_endpoint("<ep>"` ⇒ 本用例红）。
    """
    src = "\n".join(p.read_text(encoding="utf-8") for p in
                    pathlib.Path("app/services").rglob("*.py"))
    missing = [ep for ep in bp.BILI_ENDPOINTS if f'observe_endpoint("{ep}"' not in src]
    assert missing == [], f"这些端点声明了却没有记账调用：{missing}"


# ── ④ 窗口落库与恢复 ──────────────────────────────────────────────────

def test_breaker_windows_survive_a_restart():
    """落库 → 新台账恢复 ⇒ 熔断态跨重启保留（用户拍板要的那条）。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    il.LEDGER.reset()
    oc.set_failure("risk_control", "412")
    try:
        for i in range(24):
            bp.observe_endpoint("video_list", f"u{i % 3}", ok=False)
    finally:
        oc.clear()
    assert il.LEDGER.dirty() is True
    il.save_windows(db, "bilibili", il.LEDGER)

    fresh = il.Ledger()
    assert il.load_windows(db, "bilibili", fresh) == 1
    assert fresh.window(bp.bili_identity(), "video_list").tripped is True, \
        "重启后忘了端点刚坏过 —— 用户明确要防的就是这个"
    il.LEDGER.reset()
    db.close()


def test_broken_window_records_are_skipped_not_fatal():
    """一条烂记录不该让调度起不来（与 `rate_limit.State.from_json` 同一纪律）。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    from app.repositories.vtuber_repo import AppMetaRepo
    AppMetaRepo(db).set("breaker.bilibili", '{"video_list": {"samples": "坏"}, '
                                           '"dynamics_feed": {"samples": 5, "risk": 0}}')
    fresh = il.Ledger()
    assert il.load_windows(db, "bilibili", fresh) == 2      # 两条都读到了
    assert fresh.window("bilibili:x", "video_list").samples == 0, "坏记录要跳过"
    assert fresh.window("bilibili:x", "dynamics_feed").samples == 5
    db.close()


def test_account_failure_text_says_which_kind():
    """账号页那句话要分得清"号没了"与"网络/风控"（本批的用户可见收益）。

    ⚠️ 2026-10-05（`devlog/337`）补的三类：新平台（小红书/抖音）原先**进不来这张表**
    （`platform_outcome` / `was_rate_limited()` 都只有 B 站/微博那条路在写）⇒ 不管真因为什么，
    报告里永远是「更新失败（网络）」。下面这几种都是"用户该做的事完全不同"的情形。
    """
    oc.clear()
    try:
        oc.set_failure("business_error", "62002")
        assert "不存在" in sch._account_fail_text()
        oc.set_failure("server_error", "502")
        assert "网络" in sch._account_fail_text()
        oc.set_failure("risk_control", "412")
        assert "风控" in sch._account_fail_text()
        # ── 新增的三类（每种都指向一件**用户能立刻做**的事）──
        oc.set_failure("cookie_invalid", "HTTP 2483")
        assert "登录" in sch._account_fail_text() and "网络" not in sch._account_fail_text()
        oc.set_failure("signer_unavailable", "xhshow 没装")
        assert "签名" in sch._account_fail_text()
        oc.set_failure("douyin_disabled", "")
        assert "开关" in sch._account_fail_text()
        oc.set_failure("identity_throttled", "本轮没发")
        assert "没发" in sch._account_fail_text(), "自节流要说成'没发'，不是'失败'"
    finally:
        oc.clear()


class _FakePf:
    """只带 `last_error` 的平台替身（`_throttle_note` 只读这一个字段）。"""

    def __init__(self, kind: str = "", msg: str = ""):
        self.last_error = {"kind": kind, "msg": msg} if kind else None


def test_self_throttle_is_told_apart_from_a_real_failure(monkeypatch):
    """**我们自己的节奏** ≠ 上游失败：`_throttle_note()` 只在 kind 是自节流时给话。

    这条判据是 `devlog/337` 的核心：账号那条路原先不看这个 ⇒ 收录/加账号之后
    （`user_profile` 桶 0.2/s 刚被花掉，**必现**）报告里写"1 失败"，而平台什么都没说。
    """
    monkeypatch.setattr(sch.registry, "get_fetcher",
                        lambda p: _FakePf("identity_throttled", "本轮没发（自己的节奏：bucket）"))
    assert "自己的节奏" in (sch._throttle_note("douyin") or "")

    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: _FakePf("network_error", "超时"))
    assert sch._throttle_note("douyin") is None, "真失败不许被当成自节流"

    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: _FakePf())
    assert sch._throttle_note("douyin") is None
    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: None)
    assert sch._throttle_note("nosuchplatform") is None


def test_content_gate_asks_the_accounts_platform(monkeypatch):
    """**闸门要问这个账号的平台**（2026-10-05，devlog/337）—— 这是同一类坑的第三次。

    原先 `async_fetch_posts(platform, uid, …)` 手里攥着 `platform` 却调
    `content_fetch_allowed()`（不带参数，默认 B 站）⇒ 抖音/小红书的"抓取帖子"被**"未登录
    B 站"**挡下；反过来 B站登录着时又成了越权放行。`async_fetch_first_screen` 更彻底
    （连平台都没有，真机上一条抖音账号的首屏抓取就是这么被跳过的）。

    判据打在**传给闸门的那个参数**上：两处都必须是被抓账号的平台。
    """
    seen: list = []

    def _spy(platform="bilibili"):
        seen.append(platform)
        return False, "stub"          # 直接返回 ⇒ 函数在闸门处早退，不碰 DB/网络

    monkeypatch.setattr(sch.capabilities, "content_fetch_allowed", _spy)

    asyncio.run(sch.async_fetch_posts("douyin", "MS4wLjABAAAAx", 3, 5))
    assert seen[-1] == "douyin", f"手动抓取要问抖音的登录态，实际问了 {seen[-1]!r}"

    monkeypatch.setattr(sch, "_platform_of_account", lambda aid: "xiaohongshu")
    asyncio.run(sch.async_fetch_first_screen(1))
    assert seen[-1] == "xiaohongshu", f"首屏抓取要问小红书，实际问了 {seen[-1]!r}"

    # 查不到平台 ⇒ 按默认 B站口径（宁可严，不可宽）
    monkeypatch.setattr(sch, "_platform_of_account", lambda aid: None)
    asyncio.run(sch.async_fetch_first_screen(999))
    assert seen[-1] == "bilibili"
def test_contextvar_failure_kind_does_not_escape_the_task():
    """把一条**事实**钉住：`outcome` 的 ContextVar 是**任务级**的 —— 子任务里写，父任务读不到。

    为什么值得一条判据：`scheduler` 里两条账号路一条是顺序（同任务，能读到）、一条是
    平台并行（worker 子任务 ⇒ 读不到）。少了这条事实，就会有人写出"父任务里再读一次
    `_account_fail_text()`"的代码 —— 那条路会静默退回「更新失败（网络）」（devlog/337）。
    """
    async def child() -> None:
        oc.set_failure("risk_control", "x")

    async def parent() -> str:
        oc.clear()
        await asyncio.create_task(child())
        return oc.last_failure()[0]

    assert asyncio.run(parent()) == "", "子任务的写入不该出现在父任务的上下文里"


def test_adapters_feed_the_failure_kind_into_outcome(monkeypatch):
    """适配器（小红书/抖音）必须把失败原因喂给 `outcome` —— 否则文案永远落到"网络"。

    ⚠️ 反向验证：把 `DouyinPlatform._note` 换回"只写 last_error"，本用例当场红。
    三条路都验：缺 cookie（不发请求）/ 自节流（不发请求）/ 上游验证码（发了请求）。
    ⚠️ 断言在**协程内部**读（`outcome` 是任务级 ContextVar ⇒ 外面读不到，见上一条判据）。
    """
    from app.services.platforms.douyin import DouyinPlatform
    from app.services.platforms.xiaohongshu import XiaohongshuPlatform

    sec = "MS4wLjABAAAAYbIZRpNPRPJ28dxKRyqtmQXtxN5EC_uAfePn3mPehcQ"
    # 抖音有**总开关**（默认关）⇒ 要走到"缺 cookie"那一步得先把它打开
    from app.core import runtime_settings

    real_get = runtime_settings.get
    monkeypatch.setattr(runtime_settings, "get",
                        lambda key: True if key == "DOUYIN_ENABLED" else real_get(key))

    class _Client:
        def __init__(self, status: int = 200, content: bytes = b"{}"):
            self.status_code, self.content, self.headers = status, content, {}

        async def get(self, url, headers=None):
            return self

        async def aclose(self):
            pass

    async def go() -> tuple[str, str, str, bool]:
        """在**同一个任务**里依次跑三条路并读回 kind（ContextVar 的任务级语义）。"""
        oc.clear()
        await DouyinPlatform(cookie="").fetch_user_info(sec)
        missing_cookie = oc.last_failure()[0]
        await XiaohongshuPlatform(cookies="").fetch_user_info("u1")
        xhs_missing_cookie = oc.last_failure()[0]

        ledger = il.Ledger(now=lambda: 1000.0)
        pf = DouyinPlatform(cookie="UIFID=abc; s_v_web_id=x; ttwid=y", user_agent="UA",
                            ledger=ledger)
        assert pf._admit(sec, "user_profile") is True
        assert pf._admit(sec, "user_profile") is False
        throttled = oc.last_failure()[0]
        assert "自己的节奏" in (pf.last_error or {}).get("msg", "")

        oc.clear()
        await pf.fetch_post_detail("7692759522204795110", client=_Client(461))
        captcha = oc.last_failure()[0]
        return missing_cookie, xhs_missing_cookie, throttled, (pf.captcha_seen, captcha)  # type: ignore[return-value]

    try:
        dy_cookie, xhs_cookie, throttled, (captcha_seen, captcha_kind) = asyncio.run(go())
        assert dy_cookie == "cookie_invalid", "抖音缺 cookie 的原因要能到报告那一层"
        assert xhs_cookie == "cookie_invalid", "小红书同理"
        assert throttled == "identity_throttled", "自节流要能到报告那一层（D4 撞到的形态）"
        assert captcha_seen is True and captcha_kind == "captcha", "验证码要能被报告层看见"
    finally:
        oc.clear()


def test_load_windows_into_scheduler_is_idempotent():
    """`_ensure_breaker_loaded` 只读一次（与 R27 的 `_rl_loaded` 同一手法）。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    _mk_accounts(db, "bilibili", ["1", "2"])
    il.LEDGER.reset()
    saved = sch._breaker_loaded
    sch._breaker_loaded = False
    try:
        sch._ensure_breaker_loaded(db)
        assert sch._breaker_loaded is True
        sch._ensure_breaker_loaded(db)          # 第二次直接返回，不该炸
    finally:
        sch._breaker_loaded = saved
        db.close()


# ── ⑤ 手动解除 + 可见性（第 4 阶段 ⑧，devlog/240）─────────────────────

def _trip(db, platform="bilibili", endpoint="video_list", targets=3):
    """把某个端点弄成熔断（风控率 1.0、样本 24、3 个目标 ⇒ 三条件齐）。"""
    oc.set_failure("risk_control", "412")
    try:
        for i in range(24):
            bp.observe_endpoint(endpoint, f"t{i % targets}", ok=False)
    finally:
        oc.clear()
    assert il.LEDGER.window(bp.bili_identity(), endpoint).tripped is True


def test_manual_clear_forgets_memory_and_persisted_state():
    """手动解除必须**两处都清**：只清内存的话，重启会把刚解除的熔断"想起来"。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    il.LEDGER.reset()
    _trip(db)
    il.LEDGER.record("weibo:abc", "dynamics_feed", "risk_control", target="w1")
    il.save_windows(db, "bilibili", il.LEDGER)

    assert sch.clear_breaker("bilibili", db) == 1
    assert il.LEDGER.window(bp.bili_identity(), "video_list").samples == 0
    fresh = il.Ledger()
    assert il.load_windows(db, "bilibili", fresh) == 0, "落库那份没删掉"
    assert il.LEDGER.window("weibo:abc", "dynamics_feed").samples == 1, "别的平台被误伤"
    il.LEDGER.reset()
    db.close()


def test_manual_fetch_clears_the_breaker(monkeypatch):
    """**手动抓取 = 显式意图** ⇒ 自动熔断不该再挡住它（同 R27"手动档照跑"的口径）。

    ⚠️ 必须把 `SessionLocal` 换成测试库：`async_fetch_accounts` **自带会话**
    （`SessionLocal()`，走真实数据目录）。本地开发库恰好有 `accounts` 表 ⇒ 以前这条
    在本地"绿得莫名其妙"，而干净 clone / CI 上直接 `no such table: accounts`
    （2026-09-27 实测：本地绿、CI 三条腿红）。

    反向验证：删掉 `async_fetch_accounts` 里那句 `clear_breaker(...)` ⇒ 本用例红。
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    _mk_accounts(db, "bilibili", ["123"])
    acc = _first_account(db)
    il.LEDGER.reset()
    _trip(db)
    assert bp.admit_endpoint("video_list") is False

    async def fake_one(account, session, client=None, *, pending_avatar=None):
        return True

    monkeypatch.setattr(sch, "_fetch_one_account", fake_one)
    monkeypatch.setattr(sch, "SessionLocal", lambda: db)
    # ⚠️ 不要替身 `_acquire_manual_account`：它只是"抢锁成功"的代理，
    #    真锁没拿到的话，函数末尾的 `release()` 会抛 "release unlocked lock"。
    asyncio.run(sch.async_fetch_accounts([acc.id], label="手动", fast=True))
    assert bp.admit_endpoint("video_list") is True, "手动抓取没有解除熔断"
    il.LEDGER.reset()
    db.close()


def test_breaker_status_is_visible_in_fetch_status():
    """沉默的决定要说出来（同 R12a 风控可见性）：熔断状态进 `fetch-status`。"""
    il.LEDGER.reset()
    try:
        assert sch.breaker_status() == {}
        assert "breaker" in sch.get_fetch_status()
        il.LEDGER.record(bp.bili_identity(), "video_list", "risk_control", target="t1")
        snap = sch.breaker_status()
        assert snap["bilibili"]["video_list"] == {
            "tripped": False, "samples": 1, "risk": 1, "risk_targets": 1}
        _trip(None)
        assert sch.breaker_status()["bilibili"]["video_list"]["tripped"] is True
        assert sch.get_fetch_status()["breaker"]["bilibili"]["video_list"]["tripped"] is True
    finally:
        il.LEDGER.reset()
        oc.clear()


def test_scheduler_no_longer_calls_the_bilibili_live_function():
    """结构判据：T0 直播那条路**必须走 registry**（devlog/240）。

    以前 `scheduler.py` 直接 `import fetch_bilibili_live_batch` 并写死
    `platform == "bilibili"` —— 那是"平台框架"里最后一处硬编码（EXECUTION §1.4 的 ⑤）。
    反向验证：把 `fetch_bilibili_live_batch` 加回 scheduler 的 import 或调用 ⇒ 本用例红。
    """
    src = pathlib.Path(sch.__file__).read_text(encoding="utf-8")
    assert "fetch_bilibili_live_batch" not in src, \
        "scheduler 又直接用了 B 站批量直播函数 —— 它该走 platforms/bilibili.py"
    assert "supports_live_batch" in src, "T0 应当按能力筛选平台（而不是写死平台名）"
