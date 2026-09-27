"""身份级限速与四类响应（第 4 阶段 ⑤，devlog/237；调研 §5.3.1）。

判据盯着五件**会静默错**的事（每一条都对应一个真实后果）：

| 判据 | 错了会怎样 |
|---|---|
| 业务失败**不影响**身份健康 | "帖子被删"被当风控 ⇒ 遍历 id 的调用方白白冷却身份、甚至熔断端点 |
| 业务失败/网络错**退还令牌** | 一次 404 花掉 8.3s 额度 ⇒ 正常遍历被自己的节流拖死 |
| 令牌桶粒度是 **(身份, 端点)** | 换个目标就满速重来 ⇒ 实际速率是"目标数 × 单价"，节流等于没有 |
| 熔断三条件**同时**成立（含 ≥3 个不同目标） | 少第三个条件 ⇒ 一个坏目标把整个端点关掉 |
| 影子比对"比不出来"**绝不算失败** | 没装签名器就被判成"签名坏了" ⇒ 误报警/误禁用本地签名 |
"""
import time

import pytest

from app.services import identity_limit as il
from app.services.platforms.shadow import ShadowProbe, xhs_stable_constants

# ── ① 四类响应 ────────────────────────────────────────────────────────

def test_classify_four_classes():
    assert il.classify(200) == "ok"
    assert il.classify(403) == "risk_control"
    assert il.classify(429) == "risk_control"
    assert il.classify(200, code=0, msg="请求过于频繁") == "risk_control"
    assert il.classify(502) == "network_error"
    assert il.classify(0, error=TimeoutError("read timeout")) == "network_error"
    assert il.classify(404) == "business_error"


def test_classify_does_not_guess_body_semantics():
    """⚠️ 抖音那个坑：**HTTP 200 + `aweme_detail: null`** 不是风控，是业务失败。

    `classify` 刻意**不猜** body：200 先算 `ok`，由调用方看结构后给 `business_error`
    （走 `outcome_for_kind`）。这条判据钉住"不猜"——猜错的代价是冷却一个没问题的身份。
    """
    assert il.classify(200, code=0, msg="") == "ok"
    assert il.outcome_for_kind("business_error") == "business_error"


def test_unknown_kind_falls_back_to_risk_control():
    """认不出来的失败按**最保守**算：宁可多冷却一次，也不让它从风控统计里消失。"""
    assert il.outcome_for_kind("brand_new_kind") == "risk_control"


def test_platform_kinds_map_into_the_four():
    """小红的六分类 → 四类：三个"我们这侧坏了"的归 network_error（不影响身份健康）。"""
    assert il.outcome_for_kind("ok") == "ok"
    assert il.outcome_for_kind("risk_control") == "risk_control"
    assert il.outcome_for_kind("business_error") == "business_error"
    for kind in ("cookie_invalid", "signature_invalid", "gateway_missing", "server_error"):
        assert il.outcome_for_kind(kind) == "network_error", kind


def test_policy_table_is_the_single_source():
    assert il.POLICY["ok"].affects_health and il.POLICY["ok"].counts_as_endpoint_sample
    assert not il.POLICY["business_error"].affects_health
    assert il.POLICY["business_error"].refund_token
    assert not il.POLICY["business_error"].counts_as_endpoint_sample
    assert il.POLICY["risk_control"].affects_health
    assert not il.POLICY["risk_control"].refund_token
    assert il.POLICY["network_error"].refund_token
    assert not il.POLICY["network_error"].affects_health


# ── ② 身份健康度 ──────────────────────────────────────────────────────

def test_score_is_the_product_not_a_weighted_sum():
    h = il.Health().observe("ok").observe("ok").observe("ok").observe("ok")
    assert h.score == pytest.approx(1.0)

    h = il.Health()
    for _ in range(9):
        h = h.observe("ok")
    h = h.observe("risk_control")
    assert (h.ok, h.risk, h.samples) == (9, 1, 10)
    assert h.success_rate == pytest.approx(0.9)
    assert h.risk_rate == pytest.approx(0.1)
    assert h.consecutive_fails == 1
    # 三个因子都在：成功率 × (1−风控率) × 0.5^连续失败
    assert h.score == pytest.approx(0.9 * 0.9 * 0.5)

    # 一次成功 ⇒ 连续失败清零、成功率升（"最近连不上"那一维先恢复）
    h2 = h.observe("ok")
    assert h2.consecutive_fails == 0
    assert h2.score == pytest.approx((10 / 11) * (1 - 1 / 11))


def test_business_and_network_errors_do_not_hurt_health():
    """这两类**完全不动**健康度（连 consecutive_fails 都不动）—— 遍历 id 才不会被误伤。"""
    base = il.Health().observe("ok").observe("ok")
    after_biz = base.observe("business_error").observe("business_error")
    after_net = after_biz.observe("network_error")
    assert after_net.score == pytest.approx(base.score)
    assert after_net.consecutive_fails == 0
    assert after_net.business == 2 and after_net.network == 1
    assert after_net.samples == base.samples, "业务失败/网络错不该进健康度分母"


def test_success_resets_consecutive_fails():
    h = il.Health().observe("risk_control").observe("risk_control")
    assert h.consecutive_fails == 2
    assert h.observe("ok").consecutive_fails == 0


# ── ③ 令牌桶 ──────────────────────────────────────────────────────────

def test_bucket_paces_an_identity_at_the_endpoint_rate():
    b = il.Bucket(rate=0.12, capacity=1.0, tokens=1.0, updated_at=1000.0)
    b, ok, _ = b.take(1000.0)
    assert ok

    b2, ok2, need = b.take(1000.0)
    assert not ok2 and need == pytest.approx(1 / 0.12, rel=1e-6)   # ≈8.33s
    assert b2.tokens == pytest.approx(0.0)

    _, ok3, need3 = b.take(1004.0)          # 攒了 4s ⇒ 还差 ~4.3s
    assert not ok3 and need3 == pytest.approx((1 - 0.48) / 0.12, rel=1e-2)

    _, ok4, _ = b.take(1000.0 + 1 / 0.12 + 1e-6)
    assert ok4, "等够一个令牌就必须能发"


def test_bucket_refunds_business_and_network_errors():
    """⛔ 这条错了的后果：一次 404 花掉 8.3s 额度 ⇒ 正常遍历被自己的节流拖死。"""
    ledger = il.Ledger(now=lambda: 1000.0)
    ident = il.identity_key("xiaohongshu", "web_session=abc")
    assert ledger.acquire(ident, "user_posted").allowed
    assert not ledger.acquire(ident, "user_posted").allowed       # 额度用掉

    ledger.record(ident, "user_posted", "business_error", target="u1")
    assert ledger.acquire(ident, "user_posted").allowed, "业务失败必须退还令牌"

    ledger.record(ident, "user_posted", "network_error", target="u1")
    assert ledger.acquire(ident, "user_posted").allowed, "网络错必须退还令牌"

    # 风控**不**退：额度是真花掉了（而且身份已经掉分）
    ledger.record(ident, "user_posted", "risk_control", target="u1")
    assert not ledger.acquire(ident, "user_posted").allowed


def test_bucket_is_per_identity_not_per_target():
    """粒度是 (身份, 端点)：同身份换目标**照样**受同一个额度约束（调研 §5.3.1 的核心）。"""
    ledger = il.Ledger(now=lambda: 1000.0)
    a = il.identity_key("xiaohongshu", "cookie-A")
    b = il.identity_key("xiaohongshu", "cookie-B")
    assert ledger.acquire(a, "user_posted").allowed
    assert not ledger.acquire(a, "user_posted").allowed, "同身份第二个目标必须共用额度"
    assert ledger.acquire(b, "user_posted").allowed, "**另一份身份**有自己的额度"
    assert ledger.acquire(a, "otherinfo").allowed, "另一个端点有自己的额度"


def test_identity_key_hides_the_cookie_and_tracks_changes():
    k1 = il.identity_key("xiaohongshu", "web_session=secret-value")
    k2 = il.identity_key("xiaohongshu", "web_session=other-value")
    assert k1 != k2 and "secret-value" not in k1
    assert il.identity_key("xiaohongshu", "") == "xiaohongshu:anonymous"
    assert il.platform_of(k1) == "xiaohongshu"


# ── ④ 端点级熔断 ──────────────────────────────────────────────────────

def _feed(window: il.EndpointWindow, risks: list[str], oks: int = 0) -> il.EndpointWindow:
    for t in risks:
        window = window.observe(t, "risk_control")
    for i in range(oks):
        window = window.observe(f"ok{i}", "ok")
    return window


def test_breaker_needs_all_three_conditions():
    """三条件**同时**成立才算端点故障。少任何一条都不能熔断（每条都单独验一次）。"""
    # ① 只有"风控率高 + 样本够"，但只涉及 2 个目标 ⇒ 不熔断（这是"某个目标坏了"）
    w = _feed(il.EndpointWindow(), ["t1"] * 10 + ["t2"] * 11)
    assert w.risk_rate > il.BREAKER_RISK_RATE and w.samples >= il.BREAKER_MIN_SAMPLES
    assert w.risk_targets == 2 and not w.tripped

    # ② 样本够 + 3 个目标，但风控率低 ⇒ 不熔断
    w = il.EndpointWindow()
    for t in ("t1", "t2", "t3"):
        w = w.observe(t, "risk_control")
    assert not _feed(w, [], oks=27).tripped

    # ③ 风控率高 + 3 个目标，但样本不够 20 ⇒ 不熔断（样本太少，可能是巧合）
    w = _feed(il.EndpointWindow(), ["t1", "t2", "t3"])
    assert w.risk_rate == 1.0 and w.risk_targets == 3
    assert w.samples < il.BREAKER_MIN_SAMPLES and not w.tripped

    # 三条件齐 ⇒ 熔断
    w = _feed(il.EndpointWindow(), ["t1"] * 8 + ["t2"] * 8 + ["t3"] * 8)
    assert w.samples == 24 and w.risk_targets == 3 and w.risk_rate == 1.0
    assert w.tripped


def test_breaker_ignores_business_failures_in_its_samples():
    """业务失败不进样本：否则"帖子被删得多"会被读成"端点风控率高"。"""
    w = _feed(il.EndpointWindow(), ["t1", "t2", "t3"])
    for i in range(50):
        w = w.observe(f"biz{i}", "business_error")
    assert w.samples == 3 and not w.tripped


def test_tripped_endpoint_blocks_every_identity_on_it():
    """熔断是**端点级**：同一个端点上任何身份都别再发（免得一起挨风控）。"""
    ledger = il.Ledger(now=lambda: 1000.0)
    ident = il.identity_key("xiaohongshu", "cookie-A")
    for i in range(24):
        ledger.record(ident, "user_posted", "risk_control", target=f"t{i % 3}")
    assert ledger.window(ident, "user_posted").tripped

    d = ledger.acquire(ident, "user_posted")
    assert not d.allowed and d.reason == "breaker"
    other = il.identity_key("xiaohongshu", "cookie-B")
    assert not ledger.acquire(other, "user_posted").allowed, "熔断不分身份"
    assert ledger.acquire(other, "otherinfo").allowed, "别的端点不受影响"


# ── ⑤ 影子比对（调研 §3.4.1）──────────────────────────────────────────

def test_shadow_samples_once_per_ttl():
    clock = {"t": 1000.0}
    probe = ShadowProbe(ttl=600.0, now=lambda: clock["t"])
    assert probe.due("k") is True
    probe.compare("k", lambda: {"x": 1}, lambda: {"x": 1}, lambda d: d)
    assert probe.due("k") is False, "比过一次之后 TTL 内不该再比"
    clock["t"] += 601
    assert probe.due("k") is True


def test_shadow_mismatch_is_rechecked_before_concluding():
    """误判防护：首轮不一致、重跑一致 ⇒ 按**假阳性**处理（调研记录的 1/690 那类）。"""
    calls = {"n": 0}

    def shadow():
        calls["n"] += 1
        return {"v": 1 if calls["n"] == 1 else 2}     # 第一次故意不一致

    probe = ShadowProbe(now=lambda: 1000.0)
    res = probe.compare("k", lambda: {"v": 2}, shadow, lambda d: d)
    assert res.verdict == "match" and res.samples == 2 and not res.should_alert


def test_shadow_real_mismatch_alerts():
    probe = ShadowProbe(now=lambda: 1000.0)
    res = probe.compare("k", lambda: {"v": 1}, lambda: {"v": 2}, lambda d: d)
    assert res.verdict == "mismatch" and res.should_alert
    assert res.samples == 2, "结论要基于**重跑过**的结果"


@pytest.mark.parametrize("broken", ["primary", "shadow", "stable", "empty"])
def test_shadow_inconclusive_never_disables_the_primary(broken):
    """比不出来 ⇒ `inconclusive`（**不是** mismatch）：绝不禁用本地路径。"""
    def boom():
        raise RuntimeError("signer exploded")

    def empty(_d):
        return {}

    kw = {
        "primary": boom if broken == "primary" else (lambda: {"v": 1}),
        "shadow": boom if broken == "shadow" else (lambda: {"v": 1}),
        "stable": boom if broken == "stable" else (empty if broken == "empty" else (lambda d: d)),
    }
    res = ShadowProbe(now=lambda: 1000.0).compare("k", **kw)
    assert res.verdict == "inconclusive" and not res.should_alert


def test_xhs_stable_constants_excludes_noise_and_signals_structure():
    good = {"x-s": "XYS_abcdef0123456789", "x-t": "1730000000123",
            "x-s-common": "eyJ4MSI6" + "A" * 40}
    a = xhs_stable_constants(good)
    b = xhs_stable_constants(dict(good, **{"x-t": "1799999999999",
                                           "x-s": "XYS_ffffffffffffffff"}))
    assert a == b, "时钟与噪声碰得到的部分不能进比对（否则每次都判不一致）"
    assert "x-t" not in a and "x-s" not in a
    assert a["has:x-s"] and a["x-s.prefix"] == "XYS" and a["x-s.tail.hexish"] is True

    # 结构变了（缺一个签名头 / 前缀变了）⇒ 常量跟着变
    assert xhs_stable_constants({k: v for k, v in good.items() if k != "x-s-common"}) == {}
    assert xhs_stable_constants(dict(good, **{"x-s": "NEWPREFIX_abc"}))["x-s.prefix"] == "NEWPREFIX"
    assert xhs_stable_constants({}) == {}, "NullSigner 不产头 ⇒ 比不了（未比对，不是失败）"


def test_shadow_probe_does_not_depend_on_the_clock_module():
    """时钟可注入 ⇒ 不起调度器、不等真时间就能测（与 rate_limit.py 同风格）。"""
    clock = {"t": 500.0}
    probe = ShadowProbe(ttl=10.0, now=lambda: clock["t"])
    assert probe.due("k")
    probe.compare("k", lambda: {"v": 1}, lambda: {"v": 1}, lambda d: d)
    assert not probe.due("k")
    clock["t"] = time.time() + 10          # 换成真实时钟也照样 due
    assert probe.due("k")
