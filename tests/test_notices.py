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
                "expiresAt", "createdAt", "form", "read", "action"}

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


def test_task_text_tables_match(client):
    """④⁗⁗ 任务名两张表**逐字对齐**（L2）：`scheduler.TASK_TEXT` 是真源，`notices.TASK_TEXT` 是副本。

    为什么必须是副本而不是共享：`scheduler` 顶层 import 本模块（`notices_service`），
    所以 `notices` 顶层不能 import 它（循环）—— 而进度推送在上游、轮询文案在下游，
    两边都要这张表。漂了的症状很具体：**同一条任务两种说法**（推送说「全量抓取中」、
    轮询说「帖子抓取中」），而它们在前端是同一条进度条目。
    """
    from app.services import scheduler as sch

    assert N.TASK_TEXT == sch.TASK_TEXT, "两张任务名表漂了 ⇒ 同一条进度会有两种说法"
    # 反向验证的支点：新增任务名时**两份都要加**（只加一份 ⇒ 上面那条当场红）
    assert set(N.TASK_TEXT) == set(sch.TASK_TEXT)


def test_live_edge_is_recorded_into_the_ring(client):
    """④⁗⁗′ 开播告警**两条路都有**（L2）：推送（谁在线谁立刻看到）+ 汇总（断线也还在）。

    ⚠️ 这条修的是一个**写了但没人调**的洞：`notices.record_live_edge` 此前**一个调用点都没有**
    （只有本文件的用例在调），于是开播告警只活在推送那一路上 —— 推送断线/重连窗口里，
    `GET /vtuber/notices` 这份权威列表里根本没有它。调度器现在在发 `domain.live.edge` 的**同一处**
    也调它（判据就是这条：同一份事实、两条出口）。
    """
    N.reset_state()
    N.record_live_edge({"account_id": 5, "name": "七海", "live_title": "歌回"})
    body = _get(client, _status())
    live = next((n for n in body["notices"] if n["id"] == "live-5"), None)
    assert live is not None, "记进环形缓冲的开播告警没出现在汇总列表里"
    assert live["form"] == "notice" and live["source"] == "开播"
    assert live["createdAt"] and live["expiresAt"] == live["createdAt"] + N.LIVE_TTL_MS


def test_scheduler_wires_live_edge_into_the_ring():
    """④⁗⁗″ 接线：调度器发 `domain.live.edge` 的**同一处**也要记进通知汇总（L2）。

    为什么用源码级判据：那段代码在 T0 直播轮询的深处（真机才跑得到），而漏掉的症状是
    "推送断了就再也看不到那条开播"——**静默**且只在断线时出现。源码级判据钉住"两个出口
    挨着写在一起"，比造一整套假数据库去跑 T0 划算（与 `devlog/338` 对保存路径的手法一致）。
    """
    import pathlib

    src = pathlib.Path(__file__).resolve().parents[1] / "app" / "services" / "scheduler.py"
    code = src.read_text(encoding="utf-8")
    i = code.find("MSG_LIVE_EDGE, {")
    assert i > 0, "找不到开播边沿的发布点"
    seg = code[i:i + 2000]
    assert "record_live_edge" in seg, \
        "发 `domain.live.edge` 的地方没有同时记进通知汇总 ⇒ 推送断线时那条开播就没了"


def test_account_progress_records_started_at(client):
    """④⁗ 账号流在 `running` 变真的那一处记 `started_at`（面板"进行中 N 分钟"的来源）。"""
    from app.services import scheduler as sch

    assert "started_at" in sch._status["account"] and "started_at" in sch._status["post"], \
        "状态字典里没有 started_at 这个键 ⇒ 前端永远拿不到开始时刻"


# ── ④-补：进度**推送**（L2）──────────────────────────────────────────────

class _RecordingHub:
    """记下每一次 publish 的替身（形状照真身：`subscriber_count` 是 property）。"""

    subscriber_count = 1

    def __init__(self):
        self.sent: list[tuple[str, dict]] = []

    def publish(self, type_: str, payload: dict) -> int:
        self.sent.append((type_, payload))
        return len(self.sent)

    def progress_texts(self) -> list[str]:
        from app.services import messages as M

        return [p["text"] for t, p in self.sent if t == M.MSG_NOTICE_PROGRESS]


def _scheduler_with_recorder(monkeypatch) -> _RecordingHub:
    from app.services import scheduler as sch

    hub = _RecordingHub()
    monkeypatch.setattr(sch.message_hub, "HUB", hub)
    sch.reset_progress_push_state()
    return hub


def test_progress_is_pushed_with_same_text_deduped(monkeypatch):
    """L2：进度**推**给界面（不再只等 3–10s 轮询），且**同值不发第二遍**。

    判据的三段对照（缺一段这条就退化成"发了就行"）：
    ① 第一次一定发；② 文案没变**不发**（重复发 = 白唤醒前端，还会刷新面板里的到达时刻）；
    ③ 文案变了**且过了窗口**要发（否则界面停在旧数字上）。
    ②③ 的窗口本身由下面 `..._throttle_window_and_force` 用注入时钟钉死。
    """
    from app.services import scheduler as sch

    hub = _scheduler_with_recorder(monkeypatch)
    clock = {"t": 1_700_000_000_000}
    monkeypatch.setattr(sch, "_now_ms", lambda: clock["t"])
    try:
        sch._set_post_progress("full", "七海", 1, 3)          # ①
        assert hub.progress_texts() == ["全量抓取中 - 七海 - 1/3"]
        sch._set_post_progress("full", "七海", 1, 3)          # ② 同值
        assert len(hub.progress_texts()) == 1, "同值又发了一遍 ⇒ 前端会被无谓唤醒"
        clock["t"] += 600
        sch._set_post_progress("full", "七海", 2, 3)          # ③ 变了 + 过窗口
        assert hub.progress_texts() == ["全量抓取中 - 七海 - 1/3", "全量抓取中 - 七海 - 2/3"]
    finally:
        sch._reset_post_status()


def test_progress_throttle_window_and_force(monkeypatch):
    """L2 节流：500ms 内不发第二条，但**收尾/首次必发**（`force=True`）。

    ⚠️ 时钟注入（与 `expiresAt` 两条同款理由）：拿真实 `_now_ms()` 断言"隔了 400ms 没发"
    会时绿时红 —— 测试机忙一点就真的过 500ms 了。
    """
    from app.services import scheduler as sch

    hub = _scheduler_with_recorder(monkeypatch)
    clock = {"t": 1_700_000_000_000}
    monkeypatch.setattr(sch, "_now_ms", lambda: clock["t"])
    try:
        sch._set_post_progress("full", "七海", 1, 5)          # ① 第一条：发
        assert hub.progress_texts() == ["全量抓取中 - 七海 - 1/5"]
        clock["t"] += 400
        sch._set_post_progress("full", "七海", 2, 5)          # ② 窗口内、文案变了：不发
        assert len(hub.progress_texts()) == 1, "节流窗口内发了 ⇒ 500ms 这档形同虚设"
        clock["t"] += 200                                     # 累计 600ms > 500ms
        sch._set_post_progress("full", "七海", 3, 5)          # ③ 过了窗口：发
        assert hub.progress_texts()[-1] == "全量抓取中 - 七海 - 3/5"
        # ④ force（首次/收尾那种"必须发"）：即使刚发过、同值也发
        sch._push_progress("post", force=True)
        assert len(hub.progress_texts()) == 3
    finally:
        sch._reset_post_status()


def test_progress_push_state_is_cleared_between_rounds(monkeypatch):
    """L2：一轮结束后节流账本要清 —— 否则**下一轮的第一条进度会被上一轮的账本挡掉**
    （症状：第二次抓取时界面一直不动，直到第一条过了窗口）。"""
    from app.services import scheduler as sch

    hub = _scheduler_with_recorder(monkeypatch)
    try:
        sch._set_post_progress("full", "七海", 1, 3)
        assert len(hub.progress_texts()) == 1
        sch._set_post_last_result(1, "full_all", "七海", 1, 0, 1, 0, [], None)   # 收尾（清账本）
        sch._set_post_progress("full", "七海", 1, 3)          # 下一轮同样的第一条
        assert len(hub.progress_texts()) == 2, "收尾没清账本 ⇒ 下一轮的第一条被同值去重挡掉"
    finally:
        sch._reset_post_status()


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


def test_read_mode_is_explicit_and_states_are_not_ackable(client, db):
    """⑥‴ **已读方式**是显式口径（L4），且**状态类不许进已读集合**。

    两条判据守两个不同的错法：
    ① `read` 字段按形态给出（`notice`→auto / `action`→confirm / `state`→auto）——
       前端与后端都按它决定"要不要用户确认"，少一个键就等于把语义藏在 `form` 里；
    ② **稳定的状态 id 一旦进已读集合，同一条状态再次成立时会被误判成已读** ——
       症状最阴：再次被限流时界面什么都不显示。所以 ack 那两个口都要拒收。
    """
    body = _get(client, _status(
        acc_running=True, ext_running=True, ext_auto=False,
        rate={"active": True, "reason": "412", "seconds_left": 30}))
    N.note_run("post", 21, witnessed=True)
    N.record_message("完成")
    body = _get(client, _status(
        acc_running=True, ext_running=True, ext_auto=False,
        post_result={"seq": 21, "kind": "full_all", "stored": 1, "skipped": 0, "issues": []},
        rate={"active": True, "reason": "412", "seconds_left": 30}))
    by_form = {n["id"]: (n["form"], n["read"]) for n in body["notices"]}
    assert by_form["progress-account"] == ("state", N.READ_AUTO)
    assert by_form["rate-limit"] == ("state", N.READ_AUTO)
    assert by_form["report-21"] == ("action", N.READ_CONFIRM)
    assert by_form["msg-1" if "msg-1" in by_form else next(
        k for k in by_form if k.startswith("msg-"))][1] == N.READ_AUTO

    # ② 状态类 id：单条与批量两个口都拒收（幂等返回，不写盘）
    assert client.post("/vtuber/notices/ack", json={"id": "rate-limit"}).json()["acked"] == []
    assert client.post("/vtuber/notices/ack", json={"id": "progress-account"}).json()["acked"] == []
    got = client.post("/vtuber/notices/ack",
                      json={"ids": ["rate-limit", "login-expired", "report-21"]}).json()["acked"]
    assert got == ["report-21"], "批量口只该收下处置类那条"
    assert N.read_ids(db) == ["report-21"]
    # 反向对照：状态**没有**被写进去 ⇒ 再次限流时它照样出得来
    again = _get(client, _status(rate={"active": True, "reason": "412", "seconds_left": 20}))
    assert any(n["id"] == "rate-limit" for n in again["notices"]), \
        "状态类被误写进已读集合 ⇒ 再次限流时界面什么都不显示"


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


def test_ack_drops_ring_notices_and_leaves_no_residue(client, db, monkeypatch):
    """⑧ 点掉"环里的"条目 = **真的删掉它**（2026-10-05 修，用户报的"点了已读没反应"）。

    环（`_ring`）装的是瞬时消息与开播边沿，它们此前**完全不看已读集合** ⇒ 用户点"已读"
    之后它照样在面板里待到 TTL 到点（6s / 2min），观感就是"点了没反应"。

    两条判据，第二条是**这次修法的关键**（它决定了"删掉"而不是"记已读"）：

    ① 消息（`msg-<ms>`，一次性 id）：ack 之后不再出现，且**不写进已读集合** ——
       让 6 秒寿命的瞬时 id 去挤 `READ_LIMIT` 的格子会把真正要落库的处置类顶出去；
    ② 开播边沿（`live-<account_id>`，**按账号稳定**的 id）：ack 之后那个账号**下次开播
       照样要出现**。若改用"记进已读集合再过滤"的写法，这个断言就会红 ——
       那正是 `is_state_id` 那里防的同一类 bug（稳定 id 进已读 = 未来的同类事件被吞）。
    """
    monkeypatch.setattr(N, "_now_ms", lambda: 1_700_000_000_000)
    N.record_message("抓取完成")
    N.record_live_edge({"account_id": 5, "name": "七海", "live_title": "歌回"})
    ids = [n["id"] for n in N.build_notices(_Session(), status=_status(),
                                            now_ms=1_700_000_000_000)["notices"]]
    msg_id = next(i for i in ids if i.startswith("msg-"))
    assert "live-5" in ids

    # ① 单条口（点面板里某一条走的就是它）
    assert client.post("/vtuber/notices/ack", json={"id": msg_id}).json()["acked"] == [msg_id]
    left = [n["id"] for n in N.build_notices(_Session(), status=_status(),
                                             now_ms=1_700_000_000_000)["notices"]]
    assert msg_id not in left, "点掉了却还在（用户看到的就是「点了没反应」）"
    assert N.read_ids(db) == [], "瞬时消息的 id 不该进已读集合"

    # ② 批量口（面板「全部已读」走的就是它）+ 开播边沿
    assert client.post("/vtuber/notices/ack", json={"ids": ["live-5"]}).json()["acked"] == ["live-5"]
    left = [n["id"] for n in N.build_notices(_Session(), status=_status(),
                                             now_ms=1_700_000_000_000)["notices"]]
    assert "live-5" not in left
    assert N.read_ids(db) == [], "开播 id 是按账号稳定的，落库会吞掉下一次开播"
    # 反向对照：同一个账号**再次开播** ⇒ 必须重新出现
    N.record_live_edge({"account_id": 5, "name": "七海", "live_title": "第二次"})
    again = [n["id"] for n in N.build_notices(_Session(), status=_status(),
                                              now_ms=1_700_000_000_000)["notices"]]
    assert "live-5" in again, "同一个账号下次开播被上一次的已读吞掉了"


# ── B 站登录临期提醒（2026-10-08，devlog/455） ──────────────────────────
#
# 为什么要有这一条：B 站 web 会话的标称寿命约一个月，而**过期是突然的** ——
# 失效后"需要登录才能抓"的那部分会静默停下（用户 2026-10-08 就是这么发现的）。
# 提醒的判据只认 `auth_manager.set_at`（用户侧新登录盖的章），**不拿 .env 的最后写入时间顶替**：
# 内部续期也会写 .env，那样算出来的年龄永远从零开始。

def _pin_bili_age(monkeypatch, days: float | None, *, needs_login: bool = False):
    from datetime import datetime, timedelta

    from app.services import auth as auth_mod

    mgr = auth_mod.auth_manager
    monkeypatch.setattr(mgr, "needs_login", lambda: needs_login, raising=False)
    monkeypatch.setattr(
        mgr, "set_at",
        "" if days is None else (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds"),
        raising=False)


def test_login_aging_warns_before_expiry(client, monkeypatch):
    """登录了 26 天（还没失效）⇒ **warn + 「去登录」**，可 ack（不是状态类）。"""
    _pin_bili_age(monkeypatch, 26.2)
    body = _get(client, _status())
    aging = [n for n in body["notices"] if n["id"] == "login-aging"]
    assert len(aging) == 1, "26 天的登录该有临期提醒（否则过期那天用户只会觉得「抓取怎么不动了」）"
    n = aging[0]
    assert n["kind"] == "warn" and n["form"] == "action" and n["sticky"] is False
    assert "26" in n["text"] and "过期" in n["text"]
    assert n["action"] == {"label": "去登录", "kind": "login"}
    # 它是**可 ack 的处置类**：状态类 id 名单里不许有它（有就永远关不掉）
    assert "login-aging" not in N._STATE_IDS


def test_login_aging_is_quiet_before_threshold(client, monkeypatch):
    """24 天 ⇒ 什么都不说（提醒早了就是噪音，还会训练用户忽略它）。"""
    _pin_bili_age(monkeypatch, 24.0)
    ids = [n["id"] for n in _get(client, _status())["notices"]]
    assert "login-aging" not in ids


def test_login_aging_boundary_is_the_constant(client, monkeypatch):
    """边界就是常量本身（25 天整 ⇒ 提醒）—— 防止有人把阈值改成"差不多"的魔数。"""
    from app.services.auth import SESSDATA_WARN_DAYS

    _pin_bili_age(monkeypatch, float(SESSDATA_WARN_DAYS))
    ids = [n["id"] for n in _get(client, _status())["notices"]]
    assert "login-aging" in ids


def test_login_expired_replaces_aging(client, monkeypatch):
    """已失效 ⇒ 只出 alert（一条就够）；别再叠一条"快过期了"（两句自相矛盾的话）。"""
    _pin_bili_age(monkeypatch, 40.0, needs_login=True)
    ids = [n["id"] for n in _get(client, _status())["notices"]]
    assert "login-expired" in ids and "login-aging" not in ids