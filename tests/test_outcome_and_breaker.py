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


def test_bilibili_endpoints_are_not_rate_limited():
    """B 站**不装令牌桶**（用户拍板）：连发多次都放行，只有熔断能挡住。"""
    assert not (set(bp.BILI_ENDPOINTS) & set(il.ENDPOINT_RATE)), \
        "B 站端点不该出现在限速表里 —— 它的节奏由 R27/R28/R30 管"
    for ep in bp.BILI_ENDPOINTS:
        for _ in range(5):
            assert bp.admit_endpoint(ep) is True, f"{ep} 被限速了"


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
    """账号页那句话要分得清"号没了"与"网络/风控"（本批的用户可见收益）。"""
    oc.clear()
    try:
        oc.set_failure("business_error", "62002")
        assert "不存在" in sch._account_fail_text()
        oc.set_failure("server_error", "502")
        assert "网络" in sch._account_fail_text()
        oc.set_failure("risk_control", "412")
        assert "风控" in sch._account_fail_text()
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
