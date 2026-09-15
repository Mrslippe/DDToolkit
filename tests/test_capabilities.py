# -*- coding: utf-8 -*-
"""能力矩阵（`app/services/capabilities.py`）的用例 —— 核心是"策略 vs 实测"的双向契约。

## 为什么这样测

用户的目标是"未登录也尽可能用所有功能"。这句话有两个相反的错法：

- **过度限制**（把匿名能用的功能标成"需要登录"）→ 白白少给用户功能；
- **过度承诺**（把匿名会被平台封禁的功能标成可用）→ 用户点了失败，而且我们会去撞接口。

所以策略表不能只靠"我读代码觉得"，必须与 `tests/fixtures/capability_matrix.json`
（`scripts/capability_matrix.py` 的真机测量快照）双向对齐：
R1 任一探测匿名可用 ⇒ 不得 `requires_login`；R2 全部探测被**硬拒**（412 封禁）⇒ 必须 `requires_login`。
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from app.services import capabilities as C  # noqa: E402

MATRIX = ROOT / "tests" / "fixtures" / "capability_matrix.json"


def _matrix() -> dict:
    if not MATRIX.exists():
        pytest.skip("缺 capability_matrix.json（跑 python scripts/capability_matrix.py --include-content --write）")
    return json.loads(MATRIX.read_text(encoding="utf-8"))


# ── 表本身的完整性 ───────────────────────────────────────────────────

def test_feature_table_is_wellformed():
    ids = [f.id for f in C.FEATURES]
    assert len(ids) == len(set(ids)), "feature id 有重复"
    for f in C.FEATURES:
        assert f.anon_state in C.STATES, f"{f.id} 的 anon_state 非法：{f.anon_state}"
        assert f.platform in (None, "bilibili", "weibo"), f"{f.id} 的 platform 非法"
        assert f.label and f.anon_note, f"{f.id} 缺 label/anon_note"
        assert f.evidence, f"{f.id} 没写实测依据 —— 别把没量过的结论写进表"


def test_probe_map_covers_every_feature():
    assert set(C.PROBE_MAP) == {f.id for f in C.FEATURES}, "PROBE_MAP 与 FEATURES 不同步"


# ── 快照：四种登录组合 ────────────────────────────────────────────────

def test_snapshot_reports_limits_per_login_state():
    anon = C.snapshot(bili_logged_in=False, weibo_logged_in=False)
    limited = {x["id"] for x in anon["limited"]}
    assert {"fetch_posts", "weibo_content"} <= limited, "未登录时内容抓取必须标受限"
    assert "browse_local" not in limited, "本地浏览不该被标受限（它零上游）"
    assert anon["bilibili_logged_in"] is False

    bili_only = C.snapshot(bili_logged_in=True, weibo_logged_in=False)
    limited2 = {x["id"] for x in bili_only["limited"]}
    assert "fetch_posts" not in limited2, "登录后内容抓取必须解除限制"
    assert "weibo_content" in limited2, "微博未登录时仍应受限（微博匿名不可用）"

    both = C.snapshot(bili_logged_in=True, weibo_logged_in=True)
    assert both["limited"] == [], f"两平台都登录后不该还有受限项：{both['limited']}"


def test_snapshot_rows_carry_state_and_note():
    snap = C.snapshot(bili_logged_in=False, weibo_logged_in=False)
    for row in snap["features"]:
        assert row["state"] in C.STATES
        assert row["note"], f"{row['id']} 受限时没给用户说明"
    fetch = next(r for r in snap["features"] if r["id"] == "fetch_posts")
    assert fetch["state"] == C.REQUIRES_LOGIN
    assert "登录" in fetch["note"] and "412" in fetch["note"], "受限说明要讲清原因"


# ── 契约：策略不得与实测矛盾（R1 / R2）───────────────────────────────

def _anon_outcome(probe: str) -> str:
    """匿名探测的判定：ok / throttled（-352 软风控）/ banned（412 硬封）/ unknown。"""
    row = (_matrix()["matrix"]["anon"] or {}).get(probe) or {}
    if row.get("http") == 200 and row.get("code") == 0:
        return "ok"
    if row.get("http") == 412 or row.get("code") in (-412, -509):
        return "banned"
    if row.get("code") == -352:
        return "throttled"
    return "unknown"


def test_r1_measured_available_must_not_be_marked_requires_login():
    """实测匿名可用 ⇒ 策略不得 `requires_login`（否则白白限制用户）。"""
    bad: list[str] = []
    for f in C.FEATURES:
        probes = C.PROBE_MAP.get(f.id) or ()
        if not probes:
            continue
        outcomes = {p: _anon_outcome(p) for p in probes}
        if "ok" in outcomes.values() and f.anon_state == C.REQUIRES_LOGIN:
            bad.append(f"{f.id}: 实测 {outcomes} 里有可用项，却标成 requires_login")
    assert bad == [], "；".join(bad)


def test_r2_hard_banned_content_must_be_marked_requires_login():
    """全部探测被**硬拒**（412 封禁）⇒ 必须 `requires_login`（不许承诺、也不许去撞）。"""
    bad: list[str] = []
    for f in C.FEATURES:
        probes = C.PROBE_MAP.get(f.id) or ()
        if not probes:
            continue
        outcomes = [_anon_outcome(p) for p in probes]
        if outcomes and all(o == "banned" for o in outcomes) and f.anon_state != C.REQUIRES_LOGIN:
            bad.append(f"{f.id}: 实测 {outcomes} 全被硬拒，策略却是 {f.anon_state}")
    assert bad == [], "；".join(bad)


def test_matrix_fixture_records_both_states_and_date():
    doc = _matrix()
    assert set(doc["matrix"]) == {"anon", "login"}
    assert doc["captured_at"], "fixture 必须带测量日期（平台策略会变）"
    login = doc["matrix"]["login"]
    bad = [k for k, v in login.items() if v.get("code") != 0]
    assert bad == [], f"登录态下也没量到：{bad}（本机登录态/网络问题，不是能力矩阵的结论）"


# ── 闸门 ──────────────────────────────────────────────────────────────

def test_content_fetch_gate_follows_bilibili_login(monkeypatch):
    from app.services.auth import auth_manager

    monkeypatch.setattr(auth_manager, "sessdata", "")
    monkeypatch.setattr(auth_manager, "bili_jct", "")
    allowed, why = C.content_fetch_allowed()
    assert allowed is False
    assert "412" in why or "登录" in why, "拒绝原因要说人话"

    monkeypatch.setattr(auth_manager, "sessdata", "x" * 10)
    monkeypatch.setattr(auth_manager, "bili_jct", "y" * 10)
    assert C.content_fetch_allowed() == (True, "")


def test_weibo_available_requires_cookie_and_no_invalid_flag(monkeypatch):
    from app.services.weibo_auth import weibo_auth_manager

    monkeypatch.setattr(weibo_auth_manager, "cookie", "SUB=abc")
    monkeypatch.setattr(weibo_auth_manager, "_valid", True)      # 探测过且有效
    assert C.weibo_available() is True

    monkeypatch.setattr(weibo_auth_manager, "_valid", False)     # 探测确认失效
    assert C.weibo_available() is False

    monkeypatch.setattr(weibo_auth_manager, "_valid", True)
    monkeypatch.setattr(weibo_auth_manager, "cookie", "")        # 没 cookie
    assert C.weibo_available() is False
