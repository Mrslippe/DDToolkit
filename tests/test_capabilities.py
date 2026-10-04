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
    known_platforms = set(C._login_states(True, True))
    for f in C.FEATURES:
        assert f.anon_state in C.STATES, f"{f.id} 的 anon_state 非法：{f.anon_state}"
        # ⚠️ 2026-09-27（devlog/228）：这里以前写死 `(None, "bilibili", "weibo")`。
        #    改成"必须在 `_login_states` 里显式表态" —— 新增平台**必须**同时决定
        #    它依赖哪家的登录态，否则 _logged_in 会把它读成别家（旧写法是 else weibo）。
        assert f.platform is None or f.platform in known_platforms, (
            f"{f.id} 的平台 {f.platform!r} 没在 capabilities._login_states 里表态"
        )
        assert f.label and f.anon_note, f"{f.id} 缺 label/anon_note"
        assert f.evidence, f"{f.id} 没写实测依据 —— 别把没量过的结论写进表"


def test_probe_map_covers_every_feature():
    assert set(C.PROBE_MAP) == {f.id for f in C.FEATURES}, "PROBE_MAP 与 FEATURES 不同步"


# ── 快照：四种登录组合 ────────────────────────────────────────────────

def test_snapshot_reports_limits_per_login_state(monkeypatch):
    anon = C.snapshot(bili_logged_in=False, weibo_logged_in=False)
    limited = {x["id"] for x in anon["limited"]}
    assert {"fetch_posts", "weibo_content"} <= limited, "未登录时内容抓取必须标受限"
    assert "browse_local" not in limited, "本地浏览不该被标受限（它零上游）"
    assert anon["bilibili_logged_in"] is False

    bili_only = C.snapshot(bili_logged_in=True, weibo_logged_in=False)
    limited2 = {x["id"] for x in bili_only["limited"]}
    assert "fetch_posts" not in limited2, "登录后内容抓取必须解除限制"
    assert "weibo_content" in limited2, "微博未登录时仍应受限（微博匿名不可用）"

    # 四家的登录态**各算各的**（devlog/228 的口径，含 10-04 补上的小红书、devlog/334 的抖音）
    # ⚠️ 抖音还多一道**总开关**（默认关，devlog/335）⇒ 要它"不受限"得把两道都打开
    monkeypatch.setattr(C, "_douyin_enabled", lambda: True)
    all_ready = C.snapshot(bili_logged_in=True, weibo_logged_in=True, xhs_logged_in=True,
                           douyin_logged_in=True)
    assert all_ready["limited"] == [], f"四家都就绪后不该还有受限项：{all_ready['limited']}"


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


def test_content_fetch_gate_knows_xiaohongshu(monkeypatch):
    """小红书（2026-10-04 真实事故，devlog/320）：这条闸门以前**没有**小红书分支 ⇒
    `content_fetch_allowed("xiaohongshu")` 落到"未知平台"，把详情的"重取媒体"永远挡在 403，
    而且理由是一句给开发者看的话（用户点了两帖，日志里两条）。

    判据：缺 Cookie ⇒ 拒绝**且说清怎么补救**；配齐 ⇒ 放行。
    """
    from app.services.xhs_auth import xhs_auth_manager

    monkeypatch.setattr(xhs_auth_manager, "cookie", "")
    allowed, why = C.content_fetch_allowed("xiaohongshu")
    assert allowed is False
    assert "未知平台" not in why, "又退回那句给开发者看的话了"
    assert "a1" in why and "设置" in why, f"拒绝理由要能照着做：{why}"

    monkeypatch.setattr(xhs_auth_manager, "cookie", "a1=1900abcdef; web_session=xyz")
    assert C.content_fetch_allowed("xiaohongshu") == (True, ""), \
        "配了 Cookie 还挡着 ⇒ 笔记详情永远重取不了"

    # 只配一半（缺 a1 时签名器会直接报 Missing 'a1'）⇒ 仍然如实拒绝
    monkeypatch.setattr(xhs_auth_manager, "cookie", "web_session=xyz")
    assert C.content_fetch_allowed("xiaohongshu")[0] is False


def test_snapshot_reports_xiaohongshu_cookie_state(monkeypatch):
    """`/capabilities` 要如实说小红书就差一个 Cookie（而不是整条不出现）。"""
    from app.services.xhs_auth import xhs_auth_manager

    monkeypatch.setattr(xhs_auth_manager, "cookie", "")
    snap = C.snapshot(bili_logged_in=True, weibo_logged_in=True)
    assert snap["xiaohongshu_logged_in"] is False
    xhs = next(r for r in snap["features"] if r["id"] == "xhs_content")
    assert xhs["state"] == C.REQUIRES_LOGIN and "Cookie" in xhs["note"]

    monkeypatch.setattr(xhs_auth_manager, "cookie", "a1=1900abcdef; web_session=xyz")
    snap2 = C.snapshot(bili_logged_in=True, weibo_logged_in=True)
    assert snap2["xiaohongshu_logged_in"] is True
    # ⚠️ 这里原先断言 `limited == []` —— 每接一家新平台它就红一次（抖音进来时正是如此）。
    #    改成只断言"小红书那一项不在受限里"：这条用例管的是小红书，别家的状态不归它管。
    assert [r for r in snap2["limited"] if r["id"] == "xhs_content"] == []


def test_content_fetch_gate_and_snapshot_know_douyin(monkeypatch):
    """抖音（devlog/334/335）：闸门与快照都要**显式表态**，不能落到"未知平台"那句开发者话术。

    判据与小红书那条同款：缺 Cookie ⇒ 拒绝**且说清怎么补救**；配齐 + 总开关打开 ⇒ 放行。
    """
    from app.services.douyin_auth import douyin_auth_manager

    monkeypatch.setattr(C, "_douyin_enabled", lambda: True)      # 总开关单列在下面那条用例
    monkeypatch.setattr(douyin_auth_manager, "cookie", "")
    allowed, why = C.content_fetch_allowed("douyin")
    assert allowed is False and "未知平台" not in why
    assert "uifid" in why and "设置" in why, f"拒绝理由要能照着做：{why}"
    snap = C.snapshot(bili_logged_in=True, weibo_logged_in=True)
    assert snap["douyin_logged_in"] is False
    assert next(r for r in snap["features"] if r["id"] == "douyin_content")["state"] == C.REQUIRES_LOGIN

    monkeypatch.setattr(douyin_auth_manager, "cookie",
                        "UIFID=abc; s_v_web_id=verify_x; ttwid=1%7Cy")
    assert C.content_fetch_allowed("douyin") == (True, ""), "配齐了还挡着 ⇒ 抖音永远抓不到"
    snap2 = C.snapshot(bili_logged_in=True, weibo_logged_in=True)
    assert snap2["douyin_logged_in"] is True and snap2["douyin_enabled"] is True
    assert [r for r in snap2["limited"] if r["id"] == "douyin_content"] == []

    # 只配一半（缺 uifid 时签名器直接报错）⇒ 仍然如实拒绝
    monkeypatch.setattr(douyin_auth_manager, "cookie", "s_v_web_id=verify_x; ttwid=1%7Cy")
    assert C.content_fetch_allowed("douyin")[0] is False


def test_douyin_master_switch_is_a_second_gate(monkeypatch):
    """总开关（默认关，devlog/335）与"没配 cookie"是**两件事**，且顺序有意。

    配好凭据但开关关着 ⇒ 仍然拒绝，理由必须指向**设置里的开关**（而不是让人去登录 ——
    照着做一万次也不会生效）。开关打开后同一份凭据立刻放行（可热更）。
    """
    from app.services.douyin_auth import douyin_auth_manager

    monkeypatch.setattr(douyin_auth_manager, "cookie",
                        "UIFID=abc; s_v_web_id=verify_x; ttwid=1%7Cy")
    monkeypatch.setattr(C, "_douyin_enabled", lambda: False)
    allowed, why = C.content_fetch_allowed("douyin")
    assert allowed is False, "开关关着却放行 ⇒ 一个请求都不该发的承诺是假的"
    assert "关闭" in why and "设置" in why and "登录" not in why, f"理由指错了地方：{why}"

    snap = C.snapshot(bili_logged_in=True, weibo_logged_in=True)
    assert snap["douyin_enabled"] is False and snap["douyin_logged_in"] is True, \
        "两个状态要分开报：配了凭据 ≠ 已启用"
    row = next(r for r in snap["features"] if r["id"] == "douyin_content")
    # ⚠️ 状态是 **`disabled`**，不是 `requires_login`（devlog/338 的用户真机反馈）：
    #    角标写「需要登录」会让人去反复重粘 Cookie，而该做的是去设置里打开开关。
    assert row["state"] == C.DISABLED and row["state"] != C.REQUIRES_LOGIN
    assert "默认关闭" in row["note"] and "设置" in row["note"]
    assert next(l for l in snap["limited"] if l["id"] == "douyin_content")["state"] == C.DISABLED

    monkeypatch.setattr(C, "_douyin_enabled", lambda: True)
    assert C.content_fetch_allowed("douyin") == (True, "")
    # 开关打开、但凭据没配 ⇒ 这时才是真正的 `requires_login`（两种状态不能混）
    monkeypatch.setattr(douyin_auth_manager, "cookie", "")
    assert next(r for r in C.snapshot(bili_logged_in=True, weibo_logged_in=True)["features"]
                if r["id"] == "douyin_content")["state"] == C.REQUIRES_LOGIN
