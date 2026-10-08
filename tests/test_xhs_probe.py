"""小红书每日探活（需求 3，`devlog/453`）。

这一组钉的是**归因的正确性**，因为归因错了的后果不是报错、是**让用户白忙**：
把"网络不通"说成"登录已过期"，用户就去重粘一次 Cookie（而它本来没问题）；
把"会话被收回"说成"网络问题"，用户就一直等一个永远不会恢复的东西。

判据：
① 六种 kind 的映射（含"未知 kind 按没验成"）；
② **只有"会话被收回"置失效**（其余四种都不置）—— 这是"别让用户白重粘"的可执行版本；
③ 每种 kind 的文案都要说清**该做什么**（并且四种"没验成"能分开）；
④ `should_probe` 的每日守卫（没探过 ⇒ 探；刚探过 ⇒ 跳过；满 24h ⇒ 再探）；
⑤ `probe_once` 端到端（假适配器）：ok / cookie_invalid / risk_control 三态各自的落点。
"""
import asyncio

import pytest

from app.services import xhs_auth, xhs_probe
from app.services.xhs_probe import (
    INVALIDATING_KINDS, KIND_CHALLENGE, KIND_NETWORK, KIND_OK, KIND_OUR_FAULT,
    KIND_SESSION_KICKED, KIND_SKIPPED, note_for, probe_kind, should_probe,
)


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """每条用例都从"没探过 + 没失效"开始（模块级状态会跨用例串）。"""
    monkeypatch.setattr(xhs_probe, "_state",
                        {"last_ts": None, "last_kind": "", "last_note": "", "at": ""})
    monkeypatch.setattr(xhs_auth.xhs_auth_manager, "invalidated", False, raising=False)
    monkeypatch.setattr(xhs_auth.xhs_auth_manager, "cookie", "a1=x; web_session=y; webId=z",
                        raising=False)
    yield


def test_kind_mapping():
    assert probe_kind("cookie_invalid") == KIND_SESSION_KICKED
    assert probe_kind("captcha") == KIND_CHALLENGE
    assert probe_kind("risk_control") == KIND_CHALLENGE
    assert probe_kind("signature_invalid") == KIND_OUR_FAULT
    assert probe_kind("signer_unavailable") == KIND_OUR_FAULT
    assert probe_kind("network_error") == KIND_NETWORK
    assert probe_kind("identity_throttled") == KIND_NETWORK
    # 业务失败（"这个人没了"）**不是**登录问题 ⇒ 算通过
    assert probe_kind("not_found") == KIND_OK
    assert probe_kind("business_error") == KIND_OK
    # 没见过的 kind：按"没验成"（不是失效）
    assert probe_kind("some_new_kind") == KIND_NETWORK
    assert probe_kind("") == KIND_NETWORK


def test_only_session_kicked_invalidates():
    """★ 只有"会话被收回"置失效 —— 其余四种置了就是让用户白重粘。"""
    assert INVALIDATING_KINDS == frozenset({KIND_SESSION_KICKED})
    for kind in (KIND_OK, KIND_CHALLENGE, KIND_OUR_FAULT, KIND_NETWORK, KIND_SKIPPED):
        assert kind not in INVALIDATING_KINDS, f"{kind} 不该置失效"


def test_notes_say_what_to_do():
    """★ 文案要"说清该做哪件事"，且四种"没验成"分得开。"""
    kicked = note_for(KIND_SESSION_KICKED, 1.2)
    assert "重新粘贴" in kicked and "设置 → 登录 → 小红书" in kicked
    assert "1.2 天" in kicked, "活了多久要如实说"

    challenge = note_for(KIND_CHALLENGE)
    assert "验证码" in challenge and "别急着重粘" in challenge

    our = note_for(KIND_OUR_FAULT)
    assert "一个请求都没发" in our and "别重粘" in our

    net = note_for(KIND_NETWORK)
    assert "不代表登录态失效" in net

    assert "没配 Cookie" in note_for(KIND_SKIPPED)
    assert "探活通过" in note_for(KIND_OK)
    # 四种"没验成"的文案互不相同（否则用户分不出该做哪件事）
    texts = {note_for(k) for k in (KIND_SESSION_KICKED, KIND_CHALLENGE, KIND_OUR_FAULT, KIND_NETWORK)}
    assert len(texts) == 4


def test_daily_guard():
    assert should_probe(None) is True, "从没探过 ⇒ 探一次"
    assert should_probe(1_000.0, now=1_000.0 + 60) is False, "刚探过 ⇒ 跳过"
    assert should_probe(1_000.0, now=1_000.0 + xhs_probe.PROBE_MIN_INTERVAL_SEC - 1) is False
    assert should_probe(1_000.0, now=1_000.0 + xhs_probe.PROBE_MIN_INTERVAL_SEC) is True


# ── 端到端（假适配器，不碰网络）──────────────────────────────────────────

class _FakePlat:
    """替掉 `XiaohongshuPlatform`：只回某个 kind 的结果 + `last_error`。"""

    last_error: dict | None = None

    def __init__(self, kind: str | None = None):
        self._kind = kind
        _FakePlat.last_error = ({"kind": kind, "msg": f"假上游：{kind}"} if kind else None)

    async def fetch_user_info(self, uid: str):
        return {"nickname": "探活目标"} if self._kind is None else None


def _patch_platform(monkeypatch, kind: str | None):
    import app.services.platforms.xiaohongshu as xhs_mod

    monkeypatch.setattr(xhs_mod, "XiaohongshuPlatform", lambda **kw: _FakePlat(kind))
    monkeypatch.setattr(xhs_probe, "_any_xhs_uid", lambda: "u1")


def test_probe_ok_does_not_touch_invalid(monkeypatch):
    _patch_platform(monkeypatch, None)
    res = asyncio.run(xhs_probe.probe_once())
    assert res.kind == KIND_OK
    assert xhs_auth.xhs_auth_manager.invalidated is False
    assert xhs_probe.last_probe()["last_kind"] == KIND_OK, "最近一次探活要能被读出来"


def test_probe_session_kicked_marks_invalid(monkeypatch):
    """★ 会话被收回 ⇒ 置失效（能力矩阵/登录窗据此如实显示）。"""
    _patch_platform(monkeypatch, "cookie_invalid")
    res = asyncio.run(xhs_probe.probe_once())
    assert res.kind == KIND_SESSION_KICKED
    assert xhs_auth.xhs_auth_manager.invalidated is True


def test_probe_challenge_does_not_mark_invalid(monkeypatch):
    """★ 风控/验证码 ⇒ **不置**失效（cookie 可能还好好的，别让用户白重粘）。"""
    _patch_platform(monkeypatch, "risk_control")
    res = asyncio.run(xhs_probe.probe_once())
    assert res.kind == KIND_CHALLENGE
    assert xhs_auth.xhs_auth_manager.invalidated is False


def test_probe_without_cookie_is_skipped(monkeypatch):
    monkeypatch.setattr(xhs_auth.xhs_auth_manager, "cookie", "", raising=False)
    res = asyncio.run(xhs_probe.probe_once())
    assert res.kind == KIND_SKIPPED
    assert xhs_auth.xhs_auth_manager.invalidated is False
