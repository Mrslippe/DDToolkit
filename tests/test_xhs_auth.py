"""小红书登录态（粘贴 cookie）的判据（第 4 阶段 ④ 第三刀-2，devlog/233）。

⚠️ 核心那条：**缺 `a1` 必须被挡在入口**（实测缺了它签名器报 `Missing 'a1' in cookies`，
而"存进去了但永远抓不到"是最难排查的形态）。
"""
import pytest

from app.services import xhs_auth as X

GOOD = "a1=1900abcdef; web_session=xyz; webId=abc"


def test_cookie_key_parsing_and_missing():
    assert X.cookie_keys(GOOD) == {"a1", "web_session", "webid"}
    assert X.missing_keys(GOOD) == []
    assert X.missing_keys("web_session=xyz") == ["a1"], "缺 a1 必须被认出来"
    assert X.missing_keys("") == ["a1", "web_session"]


def test_apply_cookie_rejects_without_a1_and_does_not_persist(monkeypatch):
    saved: list[dict] = []
    monkeypatch.setattr(X, "save_env_keys", lambda d: saved.append(d))
    auth = X.XhsAuth()

    ok, why = auth.apply_cookie("web_session=xyz")
    assert ok is False and "a1" in why
    assert saved == [], "校验不过**不许落盘**"
    assert auth.status()["logged_in"] is False

    ok, why = auth.apply_cookie("")
    assert ok is False and saved == []


def test_apply_cookie_saves_and_reports_ready(monkeypatch):
    saved: list[dict] = []
    monkeypatch.setattr(X, "save_env_keys", lambda d: saved.append(d))
    auth = X.XhsAuth()

    ok, why = auth.apply_cookie(f"  {GOOD}  ")     # 两侧空白要 trim
    assert ok is True and why == ""
    # 落盘两份：cookie 本身 + **粘贴时刻**（平台不给标称寿命 ⇒ 只能记起点，devlog/330）
    assert len(saved) == 1 and saved[0]["XHS_COOKIE"] == GOOD
    assert saved[0]["XHS_COOKIE_SET_AT"], "粘贴时刻必须一起落盘（否则算不出'活了多久'）"
    st = auth.status()
    assert st["logged_in"] is True and st["missing"] == []
    # 有起点 ⇒ note 如实说"已配置 N 天"；没起点（老数据）才留空
    assert st["set_at"] == saved[0]["XHS_COOKIE_SET_AT"]
    assert st["age_days"] is not None and st["note"].startswith("已配置")


def test_note_invalid_reports_lifetime_once(monkeypatch, caplog):
    """失效那一刻报**一次**"它活了多久"（`devlog/330`）。

    为什么要它：平台不给标称寿命（实测 API 响应里没有 `Set-Cookie`、cookie 自带的 `ets`
    是个陈旧值），而 `status()` 刻意不探活 ⇒ 唯一能拿到真实寿命的时刻就是失效这一刻。
    只报一次：失效会连续发生很多次（每个请求一次）。
    """
    import logging

    monkeypatch.setattr(X, "save_env_keys", lambda d: None)
    auth = X.XhsAuth()
    auth.apply_cookie(GOOD)
    auth.set_at = "2026-09-27T12:00:00"          # 假装 7 天前粘的
    with caplog.at_level(logging.WARNING, logger="app.services.xhs_auth"):
        auth.note_invalid("账号未登录")
        auth.note_invalid("账号未登录")           # 第二次不该再报
    hits = [r.message for r in caplog.records if "已失效" in str(r.message)]
    assert len(hits) == 1, f"失效只该报一次：{hits}"
    assert "活了" in hits[0] and "设置 → 登录 → 小红书" in hits[0], hits[0]


def test_endpoint_saves_and_rejects(monkeypatch):
    """端点级：好 cookie ⇒ 保存 + 状态；缺 a1 ⇒ **400 且不落盘**。

    ⚠️ 这里**直接调路由函数**、不经 `TestClient(app)`：全量跑时起真 app 会带起 lifespan
    （调度运行时等），与别的用例互相干扰（实测：单跑绿、全量跑 `RuntimeError`）。
    端点函数的契约（400 的语义、返回值形状）在这里就够验了；HTTP 层由其它 auth 用例覆盖。
    """
    from fastapi import HTTPException

    from app.routers.auth import save_xhs_cookie

    saved: list[dict] = []
    monkeypatch.setattr(X, "save_env_keys", lambda d: saved.append(d))
    monkeypatch.setattr(X.xhs_auth_manager, "cookie", "")

    with pytest.raises(HTTPException) as e:
        save_xhs_cookie({"cookie": "web_session=xyz"})
    assert e.value.status_code == 400 and "a1" in str(e.value.detail)
    assert saved == [], "校验不过不许落盘"

    body = save_xhs_cookie({"cookie": GOOD})
    assert body["status"] == "saved" and body["logged_in"] is True
    assert len(saved) == 1 and saved[0]["XHS_COOKIE"] == GOOD
    assert saved[0]["XHS_COOKIE_SET_AT"]


def test_status_without_cookie_says_what_is_missing(monkeypatch):
    """没配 cookie 时状态要**说清缺什么**（端点的 `/auth/{platform}/status` 直接转调它）。

    ⚠️ 同上一支：**不起真 app**（lifespan 会与别的用例互相干扰）——改为直接验 manager
    + 断言路由的平台白名单里有小红书（那就是我第一版踩的 404：`_PLATFORMS` 没加它）。
    """
    from app.routers.auth import _PLATFORMS

    assert "xiaohongshu" in _PLATFORMS, "路由白名单没加小红书 ⇒ /auth/xiaohongshu/status 会 404"

    monkeypatch.setattr(X.xhs_auth_manager, "cookie", "")
    st = X.xhs_auth_manager.status()
    assert st["logged_in"] is False and st["configured"] is False
    assert "a1" in st["note"] and "web_session" in st["note"], st
