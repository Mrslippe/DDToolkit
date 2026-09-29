# -*- coding: utf-8 -*-
"""通知汇总（M5-1，devlog/253）—— `GET /vtuber/notices` + `POST /vtuber/notices/ack`。

## 这批只做「后端供数」

`services/notices.py` 把事实（谁在跑 / 冷却多久 / 登录是否失效 / 完成汇总 / 环形缓冲）
翻成 `Notice[]`；前端切换是 **M5-2**（那一步改用户可见行为，必须独立一批）。

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | **字段契约**：每个 `kind` 的键集合（少一个前端就画不出来） | 前端静默少画一块 |
| ② | **已按优先级排序**（alert > progress > report > message） | 顶栏显示的不是最要紧那条 |
| ③ | `now` = 服务端毫秒；`expiresAt` 以它为基准 | 两扇窗 ttl 判定差 1–2s |
| ④ | **自动节拍不产生条目**（动态流一直在跑，占顶栏会永远亮着） | 顶栏永远"忙" |
| ⑤ | **目睹才报**：没人看时跑完的轮次**不出**报告；有人看才出 | 用户被自己没看见的任务打扰 |
| ⑥ | 报告**已读**之后不再出现（落 `app_meta`，重启也记得）；`ack` **幂等** | 刷新/深休眠后报告复活 |
| ⑦ | 瞬时消息 TTL 从**记录时刻**起算（拉多少次都不后漂） | 消息永不过期 |
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

from app.core.database import Base, get_db
from app.main import app
from app.services import notices as N

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-notices-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'notices.db').as_posix()}",
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
    N.reset_state()                      # 进程内小账本：跨用例串味会让判据时绿时红
    yield
    N.reset_state()
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    Base.metadata.drop_all(bind=_engine)


@pytest.fixture
def db():
    s = _Session()
    yield s
    s.close()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _pin_login_state(monkeypatch):
    """把"登录态"钉成**已登录**，让每条用例与运行环境无关。

    ⚠️ 这是"本地绿 CI 红"的第三次现身（devlog/247 记过复现手法）：**空数据目录**下
    `auth_manager.needs_login()` 为真 ⇒ 会多出一条 `login-expired` alert，
    于是"开播 alert 排第一"那条断言在 CI（干净克隆）红、本地（有凭据）绿。
    实测复现：`DDTOOLKIT_DATA_DIR=<空目录> python -m pytest tests/test_notices.py`。
    ⇒ 判据不许依赖"跑测试的那台机器有没有登录"。
    """
    from app.services import auth as auth_mod

    monkeypatch.setattr(auth_mod.auth_manager, "needs_login", lambda: False, raising=False)
    yield


def _status(*, post_running=False, post_auto=False, acc_running=False, acc_auto=False,
            rate=None, post_result=None, acc_result=None) -> dict:
    # 帖子轮的 `last_result` 默认按**全量**造（`REPORT_KINDS` 只对全量出报告）——
    # 想验"别的轮次不出报告"的用例自己显式传 `kind`。
    if post_result is not None:
        post_result = {"kind": "full_all", **post_result}
    return {
        "account": {"running": acc_running, "auto": acc_auto, "task": "account",
                    "current": "七海", "index": 2, "total": 5,
                    "last_result": acc_result},
        "post": {"running": post_running, "auto": post_auto, "task": "full",
                 "vtuber_name": "七海", "index": 1, "total": 3,
                 "last_result": post_result},
        "external": {"running": False, "label": None},
        "manual_running": post_running or acc_running,
        "rate_limit": rate,
        "breaker": {},
        "quiet_hours": {},
    }


def _get(client, status: dict) -> dict:
    """直接用给定的 status 事实跑一遍汇总（不打网络、不依赖真调度器）。"""
    db = _Session()
    try:
        return N.build_notices(db, status=status)
    finally:
        db.close()


# ── ① 字段契约 ─────────────────────────────────────────────────────────

ALLOWED_KEYS = {"id", "kind", "text", "value", "detail", "source", "sticky",
                "expiresAt", "action"}


def test_contract_keys_exact(client):
    """① 契约：顶层**三个**键 + 每条通知的键集合（前端 `Notice` 的字段全集）。"""
    N.record_message("抓取完成")
    N.note_run("post", 1, witnessed=True)
    body = _get(client, _status(post_result={"seq": 1, "kind": "full_all", "stored": 3,
                                            "skipped": 1, "issues": []},
                                rate={"active": True, "reason": "412", "seconds_left": 47}))
    assert set(body) == {"now", "notices", "manual_running"}, (
        "顶层键集合变了（前端按 now 做 ttl 判定、按 manual_running 禁用按钮）")
    assert body["notices"], "这一组事实应当至少产出一条通知"
    for n in body["notices"]:
        assert set(n) <= ALLOWED_KEYS, f"多出前端不认识的键：{set(n) - ALLOWED_KEYS}"
        # 三个必备键：没有 id 就无法 ack / 去重，没有 kind 就排不了序，没有 text 就画不出
        assert {"id", "kind", "text"} <= set(n)
        assert n["kind"] in {"alert", "progress", "report", "message"}


def test_manual_running_is_carried_with_the_notices(client):
    """①″ `manual_running` 与通知同一趟给出（M5-2 前置：删 `kickPoll` 靠它保住按钮禁用）。

    ⚠️ 口径必须与 `fetch-status` 同源：**自动档持锁不算忙** —— 判据里专门有一条
    `acc_running=True, acc_auto=True` 的反例（用它当忙就会把自动节拍期间的按钮全禁掉）。
    """
    assert _get(client, _status())["manual_running"] is False
    assert _get(client, _status(post_running=True))["manual_running"] is True
    assert _get(client, _status(acc_running=True))["manual_running"] is True
    auto = _status(acc_running=True, acc_auto=True, post_running=True, post_auto=True)
    auto["manual_running"] = False            # 后端口径：自动档不算忙
    assert _get(client, auto)["manual_running"] is False, (
        "自动节拍期间把 manual_running 报成真 ⇒ 界面会把按钮全禁掉")


def test_quick_run_produces_no_report(client):
    """①‴ **只有全量轮出常驻报告**（R4，M5-2 发现的潜伏 bug）。

    为什么必须有这条：`quick`（手动"抓取帖子"）与 `adopt`（收录首屏）**都会**走
    `_set_post_last_result`，而 `witnessed` 在主窗口开着时恒为真 ⇒ 少了 `REPORT_KINDS`
    这道过滤，每次手动抓帖都会留下一条写着"**全量**帖子抓取完成"的假报告 + 一个
    「查看详情」。M5-1 期间没有消费者，所以直到 M5-2 接上前端才会现形。
    """
    res_quick = {"seq": 11, "kind": "quick", "stored": 2, "skipped": 0, "issues": []}
    N.note_run("post", 11, witnessed=True)
    assert [n for n in _get(client, _status(post_result=res_quick))["notices"]
            if n["kind"] == "report"] == [], "手动抓帖（quick）不该出常驻报告"

    res_adopt = {"seq": 12, "kind": "adopt", "stored": 5, "skipped": 1, "issues": []}
    N.note_run("post", 12, witnessed=True)
    assert [n for n in _get(client, _status(post_result=res_adopt))["notices"]
            if n["kind"] == "report"] == [], "收录首屏（adopt）不该出常驻报告"

    # 全量两态**都要**出（`full_vtuber` 是单 V 全量，用户同样要那个报告框）
    for i, kind in enumerate(("full_all", "full_vtuber"), start=13):
        N.note_run("post", i, witnessed=True)
        got = [n for n in _get(client, _status(post_result={"seq": i, "kind": kind,
                                                            "stored": 1, "skipped": 0,
                                                            "issues": []}))["notices"]
               if n["kind"] == "report"]
        assert len(got) == 1, f"{kind} 轮次的报告不见了（用户看不到完成详情）"


def test_report_contract_shape(client):
    """①′ 报告那条要带 `action` 与 `sticky`（它是"要你看一眼"的那类）。"""
    N.note_run("post", 7, witnessed=True)
    body = _get(client, _status(post_result={"seq": 7, "kind": "full_all", "stored": 9,
                                             "skipped": 0, "issues": [], "video_missing": 2}))
    rep = [n for n in body["notices"] if n["kind"] == "report"]
    assert len(rep) == 1
    assert rep[0]["id"] == "report-7"
    assert rep[0]["sticky"] is True
    assert rep[0]["action"] == {"label": "查看详情", "kind": "open-report"}
    assert "视频可能缺 2 条" == rep[0]["detail"]


# ── ②③ 排序与时间 ──────────────────────────────────────────────────────

def test_sorted_by_priority_and_now_is_server_ms(client):
    """②③ 排序 + `now` 口径 + `expiresAt` 以 `now` 为基准。"""
    N.record_message("随手一条")
    N.note_run("post", 2, witnessed=True)
    body = _get(client, _status(
        post_running=True,
        post_result={"seq": 2, "stored": 1, "skipped": 0, "issues": []},
        rate={"active": True, "reason": "412", "seconds_left": 47}))
    kinds = [n["kind"] for n in body["notices"]]
    assert kinds == sorted(kinds, key=lambda k: -N.KIND_PRIORITY[k]), f"没按优先级排：{kinds}"
    assert kinds[0] == "alert" and "progress" in kinds and "report" in kinds
    assert isinstance(body["now"], int) and body["now"] > 1_700_000_000_000
    rl = next(n for n in body["notices"] if n["id"] == "rate-limit")
    assert rl["value"] == "47s"                       # 活数据在 value 槽里
    assert rl["expiresAt"] == body["now"] + 47_000    # ttl 以服务端 now 为基准


# ── ④ 自动节拍不占位 ───────────────────────────────────────────────────

def test_auto_schedules_produce_no_progress(client):
    """④ 动态流/自动账号流**不产生**条目（2026-09-10 用户口径）。"""
    body = _get(client, _status(post_running=True, post_auto=True,
                                acc_running=True, acc_auto=True))
    assert [n for n in body["notices"] if n["kind"] == "progress"] == []


def test_manual_account_progress_text(client):
    """④′ 手动抓取的进度文案 = `任务名 - V名 - i/N`（与前端同格式）。"""
    body = _get(client, _status(acc_running=True))
    prog = [n for n in body["notices"] if n["kind"] == "progress"]
    assert len(prog) == 1 and prog[0]["id"] == "progress-account"
    assert prog[0]["text"] == "账号信息抓取中 - 七海 - 2/5"


# ── ⑤ 目睹才报 ─────────────────────────────────────────────────────────

def test_report_requires_witness(client):
    """⑤ 没人看时跑完的轮次**不出**报告（"目睹才报"，§8.5 拍板 C）。"""
    res = {"seq": 3, "stored": 5, "skipped": 0, "issues": []}
    # 没有 `note_run`（等于当时没有订阅者）⇒ 不报
    body = _get(client, _status(post_result=res))
    assert [n for n in body["notices"] if n["kind"] == "report"] == []
    # 明确记为"没人看" ⇒ 同样不报
    N.note_run("post", 3, witnessed=False)
    assert [n for n in _get(client, _status(post_result=res))["notices"]
            if n["kind"] == "report"] == []
    # 有人看 ⇒ 报
    N.note_run("post", 3, witnessed=True)
    assert len([n for n in _get(client, _status(post_result=res))["notices"]
                if n["kind"] == "report"]) == 1


def test_scheduler_notes_witness_from_subscriber_count(monkeypatch):
    """⑤′ 接线：`_set_post_last_result` 用**当时的订阅者数**记"谁在看"。"""
    from app.services import scheduler as sch

    class _FakeHub:
        """替身。⚠️ **形状必须与真身一致**：真身 `MessageHub.subscriber_count` 是
        **property**（`hub.subscriber_count`，不加括号）。第一版替身写成了**方法**，
        于是生产代码里 `subscriber_count()` 这个真 bug（全套 `test_services` `TypeError`）
        在**这里照样全绿** —— 替身形状不对 = 判据没牙（devlog/253 §五）。
        也不能直接 `monkeypatch.setattr(M.HUB, "subscriber_count", …)`：property 无 setter。
        """

        def __init__(self, n: int):
            self._n = n

        @property
        def subscriber_count(self) -> int:
            return self._n

        def publish(self, *a, **k) -> None:
            pass

    seen: list[tuple[str, int, bool]] = []
    monkeypatch.setattr(sch.notices_service, "note_run",
                        lambda kind, seq, witnessed: seen.append((kind, seq, witnessed)))
    monkeypatch.setattr(sch.message_hub, "HUB", _FakeHub(0))
    sch._set_post_last_result(11, "full", "全部账号", 1, 2, 3, 4, [], None)
    monkeypatch.setattr(sch.message_hub, "HUB", _FakeHub(2))
    sch._set_account_last_result(12, "全部账号", 1, 0, 0)
    assert seen == [("post", 11, False), ("account", 12, True)]


# ── ⑥ 已读写回 ─────────────────────────────────────────────────────────

def test_ack_is_idempotent_and_persisted(client, db):
    """⑥ `ack` 幂等 + 落库（重启后仍记得）。"""
    N.note_run("post", 5, witnessed=True)
    st = _status(post_result={"seq": 5, "stored": 2, "skipped": 0, "issues": []})
    assert len([n for n in _get(client, st)["notices"] if n["kind"] == "report"]) == 1

    r1 = client.post("/vtuber/notices/ack", json={"id": "report-5"})
    assert r1.status_code == 200 and r1.json()["acked"] == ["report-5"]
    # 幂等：再记一次结果一模一样（不重复、不报错）
    r2 = client.post("/vtuber/notices/ack", json={"id": "report-5"})
    assert r2.status_code == 200 and r2.json()["acked"] == ["report-5"]
    # 已读之后，同样的报告不再出现
    assert [n for n in _get(client, st)["notices"] if n["kind"] == "report"] == []
    # 落库：换一个会话读（等价于"重启后"）
    assert N.read_ids(db) == ["report-5"]


def test_ack_rejects_empty_id(client):
    """⑥′ 空 id 是 422（前端不许发空——否则会往已读集合里塞垃圾）。"""
    assert client.post("/vtuber/notices/ack", json={"id": ""}).status_code == 422


def test_route_serves_notices(client):
    """端点本身：走 HTTP 也能拿到（`now` / `notices` / `manual_running` 三键都在）。"""
    r = client.get("/vtuber/notices")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"now", "notices", "manual_running"}
    assert isinstance(body["manual_running"], bool)


# ── ⑦ 瞬时消息 / 开播边沿的 TTL ────────────────────────────────────────

def test_message_ttl_counts_from_record_time(client):
    """⑦ TTL 从**记录时刻**起算：拉多少次都不会往后漂（否则消息永不过期）。"""
    N.record_message("刚刚完成")
    st = _status()
    first = _get(client, st)
    msg = [n for n in first["notices"] if n["kind"] == "message"]
    assert len(msg) == 1 and msg[0]["expiresAt"] == first["now"] + N.MSG_TTL_MS

    # 时间往后推（模拟"又一次轮询"）：到期那一刻起消失，且过期时刻**不变**
    later = N.build_notices(_Session(), status=st, now_ms=first["now"] + N.MSG_TTL_MS - 1)
    assert [n for n in later["notices"] if n["kind"] == "message"]
    assert ([n for n in later["notices"] if n["kind"] == "message"][0]["expiresAt"]
            == msg[0]["expiresAt"]), "过期时刻跟着渲染时刻漂了 ⇒ 永远不过期"
    gone = N.build_notices(_Session(), status=st, now_ms=first["now"] + N.MSG_TTL_MS + 1)
    assert [n for n in gone["notices"] if n["kind"] == "message"] == []


def test_live_edge_becomes_alert_with_ttl(client):
    """⑦′ 开播边沿 → alert（优先级 4，压过进度），带 2 分钟 TTL，**不 sticky**。"""
    N.record_live_edge({"account_id": 9, "name": "七海", "live_title": "歌回"})
    body = _get(client, _status(acc_running=True))
    live = next(n for n in body["notices"] if n["id"] == "live-9")
    assert live["kind"] == "alert" and live["text"] == "七海 开播了"
    assert live["detail"] == "歌回" and live["source"] == "开播"
    assert live["expiresAt"] == body["now"] + N.LIVE_TTL_MS
    assert body["notices"][0]["id"] == "live-9", "alert 应当排在 progress 前面"


def test_login_expired_is_sticky_alert(client, monkeypatch):
    """③′ 登录失效：常驻 alert + 「去登录」动作（其余用例把这条钉成"已登录"，见 autouse 夹具）。"""
    from app.services import auth as auth_mod

    monkeypatch.setattr(auth_mod.auth_manager, "needs_login", lambda: True, raising=False)
    body = _get(client, _status())
    lg = next(n for n in body["notices"] if n["id"] == "login-expired")
    assert lg["kind"] == "alert" and lg["sticky"] is True
    assert lg["action"] == {"label": "去登录", "kind": "login"}
    assert lg["expiresAt"] is None, "常驻条不该有过期时刻"
