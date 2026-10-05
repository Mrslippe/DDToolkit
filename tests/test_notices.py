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
def _isolate_scheduler_state():
    """把**调度器的进程内状态**在每个用例前后围起来（2026-10-05 踩到）。

    为什么需要：`_external_labels` 是模块级的"谁在跑"登记表，而本文件里有用例会调
    `external_task_started/​finished`。它留下的 token 会让**别的文件**里"跑完该复位"的断言
    （`test_services.py` 两条）红 —— 症状是"单独跑绿、全量跑红"，最难查的那一类。

    判据不许依赖"别的用例干不干净"：这里按值存一份、用完还原（不是清空 —— 清空同样会
    改掉别人留下的现场）。

    ⚠️ **`_external_done_seq` 也要还原**（第一版漏了它）：它是模块级的完成序号计数器，
    本文件调一次 `external_task_finished` 就把它 +1 ⇒ `test_services` 里那条
    "`seq == base_seq + 1`"会变成 `3 == 1`。计数器类状态比字典更阴 ——
    它**看不出被改过**，只在别人的差值断言里现形。
    """
    from app.services import scheduler as sch

    saved_labels = dict(sch._external_labels)
    saved_seq = sch._external_done_seq
    saved_ext = dict(sch._status["external"])
    saved_running = (sch._status["account"].get("running"), sch._status["post"].get("running"))
    yield
    sch._external_labels.clear()
    sch._external_labels.update(saved_labels)
    sch._external_done_seq = saved_seq
    sch._status["external"].update(saved_ext)
    sch._status["account"]["running"], sch._status["post"]["running"] = saved_running


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
            rate=None, post_result=None, acc_result=None,
            ext_running=False, ext_auto=False, ext_started=None,
            acc_started=None) -> dict:
    # 帖子轮的 `last_result` 默认按**全量**造（`REPORT_KINDS` 只对全量出报告）——
    # 想验"别的轮次不出报告"的用例自己显式传 `kind`。
    if post_result is not None:
        post_result = {"kind": "full_all", **post_result}
    return {
        "account": {"running": acc_running, "auto": acc_auto, "task": "account",
                    "current": "七海", "index": 2, "total": 5,
                    "started_at": acc_started,
                    "last_result": acc_result},
        "post": {"running": post_running, "auto": post_auto, "task": "full",
                 "vtuber_name": "七海", "index": 1, "total": 3, "started_at": None,
                 "last_result": post_result},
        "external": {"running": ext_running, "label": "第三方数据日批次", "seq": 0,
                     "auto": ext_auto, "started_at": ext_started},
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
                "expiresAt", "createdAt", "form", "action"}

#: 三形态（`docs/design/notices/channel-and-layering.md` §2.2）—— 与 `kind` **正交**：
#: `kind` 管长相（字形/点色）、`form` 管行为（活多久、怎么消失）。两者今天恰好一一对应是巧合。
ALLOWED_FORMS = {"state", "notice", "action"}


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
        # L1：形态必须显式给出（前端按它分组/推导时长），且不许是没见过的值
        assert n["form"] in ALLOWED_FORMS, f"未知形态 {n['form']!r}"


def test_every_notice_carries_a_created_at(client, monkeypatch):
    """①″ **每条**通知都要有 `createdAt`（面板要显示"3 分钟前"）。

    为什么单列一条：`createdAt` 是"每条都要有"的字段，而它的**来源按形态各不相同**
    （状态=开始时刻 / 告知=记录时刻 / 处置=收尾时刻）—— 新增一类通知时最容易漏的就是它，
    漏了的症状是面板上那一行**安静地没有时间**（不报错、不红）。
    """
    monkeypatch.setattr(N, "_now_ms", lambda: 1_700_000_000_000)
    N.record_message("抓取完成")
    N.record_live_edge({"account_id": 3, "name": "七海", "live_title": "歌回"})
    N.note_run("post", 4, witnessed=True)
    body = _get(client, _status(
        acc_running=True, acc_started=1_699_999_000_000, ext_running=True, ext_auto=False,
        post_result={"seq": 4, "kind": "full_all", "stored": 1, "skipped": 0, "issues": [],
                     "finished_at": 1_699_999_500_000},
        rate={"active": True, "reason": "412", "seconds_left": 47, "window_seconds": 300}))
    missing = [n["id"] for n in body["notices"] if not n.get("createdAt")]
    assert missing == [], f"这些条目没有 createdAt（面板上会安静地没有时间）：{missing}"
    # 状态类：用**状态开始**的时刻，不是 now（否则"进行中"永远显示"刚刚"）
    acc = next(n for n in body["notices"] if n["id"] == "progress-account")
    assert acc["createdAt"] == 1_699_999_000_000
    # 处置类：用报告收尾时刻
    rep = next(n for n in body["notices"] if n["kind"] == "report")
    assert rep["createdAt"] == 1_699_999_500_000
    # 告知类：用记录时刻（== 钉死的 now）
    live = next(n for n in body["notices"] if n["id"] == "live-3")
    assert live["createdAt"] == 1_700_000_000_000


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


def test_auto_external_task_produces_no_progress(client):
    """④″ **第三方同步的自动批次同样不产生条目**（L1 修的洞，`devlog/341`）。

    原先 `_progress_notices` 对 `post`/`account` 查了 `auto`，而 `external` 状态里
    **根本没有这个字段** ⇒ 收录回填 / 每日批次 / 启动补抓都会产生一条常驻进度，
    而它们**没有终局**：一条"正在同步…"会把胶囊一直占着。
    判据直接打在"自动档不出条目 / 手动档照样出"这一对反差上（只测前者会让函数退化成 `return []`）。
    """
    auto = _get(client, _status(ext_running=True, ext_auto=True))
    assert [n for n in auto["notices"] if n["id"] == "progress-external"] == [], \
        "自动批次占了顶栏 ⇒ 胶囊会被一条没有终局的进度一直占着"

    manual = _get(client, _status(ext_running=True, ext_auto=False))
    ext = [n for n in manual["notices"] if n["id"] == "progress-external"]
    assert len(ext) == 1 and ext[0]["form"] == "state"
    assert ext[0]["text"] == "正在同步第三方数据日批次"


def test_external_task_started_defaults_to_auto(monkeypatch):
    """④‴ 调度器那侧：`external_task_started` **默认 auto=True**（保守）。

    默认值的方向是判据的一部分：新加一条外部链路时忘了声明，表现应该是"安静"，
    而不是"永久占位"。只有"用户刚点了按钮、必须立刻看到反馈"才显式传 `auto=False`。

    ⚠️ **必须自己清 `_external_labels`**（2026-10-05 实测踩到）：它是模块级的
    "谁在跑"登记表，而全量跑时**别的用例可能留了 token 在里面** —— 那时
    `external_task_finished` 不会走到"全部结束"那一支（`running` 仍为真），
    于是这条用例单独跑绿、全量跑红（连带把 `test_services` 里两条"跑完该复位"的也带红）。
    判据不许依赖"别的用例干不干净"。
    """
    from app.services import scheduler as sch

    saved = dict(sch._external_labels)
    sch._external_labels.clear()
    try:
        sch._status["external"].update({"running": False, "auto": False, "started_at": None})
        sch.external_task_started("unit-test-auto", "某自动批次")
        assert sch._status["external"]["auto"] is True
        assert sch._status["external"]["started_at"], \
            "状态类条目没有开始时刻 ⇒ 面板显示不了'进行中 N 分钟'"
        sch.external_task_finished("unit-test-auto")
        assert sch._status["external"]["auto"] is False          # 收尾复位，别留给下一次
        assert sch._status["external"]["started_at"] is None
        assert sch._status["external"]["running"] is False

        sch.external_task_started("unit-test-manual", "用户点的同步", auto=False)
        assert sch._status["external"]["auto"] is False
        sch.external_task_finished("unit-test-manual")
    finally:
        # 恢复现场（把别的用例留下的 token 还回去）—— 不清的话后面"跑完该复位"的用例会红
        sch._external_labels.clear()
        sch._external_labels.update(saved)
        sch._status["external"]["running"] = bool(saved)
        sch._status["external"]["auto"] = False
        sch._status["external"]["started_at"] = None


def test_account_progress_records_started_at(client):
    """④⁗ 账号流在 `running` 变真的那一处记 `started_at`（面板"进行中 N 分钟"的来源）。"""
    from app.services import scheduler as sch

    assert "started_at" in sch._status["account"] and "started_at" in sch._status["post"], \
        "状态字典里没有 started_at 这个键 ⇒ 前端永远拿不到开始时刻"


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
    """⑥′ 空请求是 422（前端不许发空——否则会往已读集合里塞垃圾）。

    ⚠️ 判据从"`id: ""` 被 Pydantic 拦下"改成"**两者都空**才 422"（L1 加批量 `ids` 之后）：
    `id: ""` + `ids: []` 仍然是 422，但错误来源是路由里那句显式判断（Pydantic 不再限制
    `id` 的最小长度 —— 否则"只给 ids"的批量调用会被它拦掉）。
    """
    assert client.post("/vtuber/notices/ack", json={"id": ""}).status_code == 422
    assert client.post("/vtuber/notices/ack", json={"ids": []}).status_code == 422
    assert client.post("/vtuber/notices/ack", json={}).status_code == 422


def test_ack_batch_is_one_round_trip(client, db):
    """⑥″ 批量已读（「一键已读」，L1）：一次请求清一组，且**幂等**、去重、不覆盖旧的。

    为什么必须有批量口：前端循环发 N 次单条会出现"清到一半失败、面板半干净"的中间态，
    而用户看到的是一次点击。
    """
    r = client.post("/vtuber/notices/ack", json={"ids": ["report-1", "report-2", "report-2"]})
    assert r.status_code == 200
    assert r.json()["acked"] == ["report-1", "report-2"], "同一批里重复的 id 不该占两格"
    # 再发一批：新的排在前面，旧的**不丢**
    r2 = client.post("/vtuber/notices/ack", json={"ids": ["report-3"]})
    assert r2.json()["acked"] == ["report-3", "report-1", "report-2"]
    # 幂等：重发同一批，集合不变
    r3 = client.post("/vtuber/notices/ack", json={"ids": ["report-1", "report-2"]})
    assert r3.json()["acked"] == ["report-3", "report-1", "report-2"]
    assert N.read_ids(db) == ["report-3", "report-1", "report-2"]
    # 批量里的空串被忽略（不让垃圾进集合）
    client.post("/vtuber/notices/ack", json={"ids": ["  ", "report-9"]})
    assert N.read_ids(db) == ["report-9", "report-3", "report-1", "report-2"]


def test_route_serves_notices(client):
    """端点本身：走 HTTP 也能拿到（`now` / `notices` / `manual_running` 三键都在）。"""
    r = client.get("/vtuber/notices")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"now", "notices", "manual_running"}
    assert isinstance(body["manual_running"], bool)


# ── ⑦ 瞬时消息 / 开播边沿的 TTL ────────────────────────────────────────

def test_message_ttl_counts_from_record_time(client, monkeypatch):
    """⑦ TTL 从**记录时刻**起算：拉多少次都不会往后漂（否则消息永不过期）。

    ⚠️ **钟要注入**（2026-09-29，与上面开播那条同款）：`expiresAt` 的起算点是**记录那一刻**，
    而 `build_notices` 又现取一次 `now` —— 拿 "`first["now"] + TTL`" 去断言**只在两次取钟
    同一毫秒时成立**（实测就红过一次：`…327660 != …323661 + 4000`）。
    钉死 `_now_ms` 并显式传 `now_ms=` 之后，"不往后漂"这条性质照样被下面两次不同 `now_ms` 看住。
    """
    monkeypatch.setattr(N, "_now_ms", lambda: 1_700_000_000_000)
    N.record_message("刚刚完成")
    st = _status()
    first = N.build_notices(_Session(), status=st, now_ms=1_700_000_000_000)
    msg = [n for n in first["notices"] if n["kind"] == "message"]
    assert len(msg) == 1 and msg[0]["expiresAt"] == 1_700_000_000_000 + N.MSG_TTL_MS

    # 时间往后推（模拟"又一次轮询"）：到期那一刻起消失，且过期时刻**不变**
    later = N.build_notices(_Session(), status=st, now_ms=first["now"] + N.MSG_TTL_MS - 1)
    assert [n for n in later["notices"] if n["kind"] == "message"]
    assert ([n for n in later["notices"] if n["kind"] == "message"][0]["expiresAt"]
            == msg[0]["expiresAt"]), "过期时刻跟着渲染时刻漂了 ⇒ 永远不过期"
    gone = N.build_notices(_Session(), status=st, now_ms=first["now"] + N.MSG_TTL_MS + 1)
    assert [n for n in gone["notices"] if n["kind"] == "message"] == []


def test_live_edge_becomes_alert_with_ttl(client, monkeypatch):
    """⑦′ 开播边沿 → alert（优先级 4，压过进度），带 2 分钟 TTL，**不 sticky**。

    ⚠️ **钟要注入**（2026-09-29 实测踩到）：`expiresAt` 的起算点是**记录那一刻**
    （`record_live_edge` 里的 `_now_ms()`），而 `build_notices` 又会现取一次 `now`
    —— 原来断言 `expiresAt == body["now"] + TTL` **只在两次取钟落在同一毫秒时成立**，
    于是它偶尔红（CI 的 3.12 腿就这么红过一次，本地全量跑 20 次才复现一次）。
    ⇒ 钉死 `_now_ms` 并显式传 `now_ms=`，判据从"毫秒巧合"变成"确定等式"。
    **别把它改成范围断言**（那是把判据放宽，会把真的漂移一起放过去）。
    """
    monkeypatch.setattr(N, "_now_ms", lambda: 1_700_000_000_000)
    N.record_live_edge({"account_id": 9, "name": "七海", "live_title": "歌回"})
    body = _get(client, _status(acc_running=True))
    live = next(n for n in body["notices"] if n["id"] == "live-9")
    assert live["kind"] == "alert" and live["text"] == "七海 开播了"
    assert live["detail"] == "歌回" and live["source"] == "开播"
    assert live["expiresAt"] == 1_700_000_000_000 + N.LIVE_TTL_MS
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
