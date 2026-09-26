# -*- coding: utf-8 -*-
"""调度生命周期（R1，批次 6）：**能停、只停一次、不留残余**。

改造前的事实（`docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §2.10 核实）：
  · 5 处不可中断的 `time.sleep`，其中综合档线程是 `while True` + 10s 级睡眠
    ⇒ **没有任何停止手段**；`_wait_for_manual_tasks` 最坏睡 1800s；
  · `start_scheduler()` / `start_live_poller()` / `start_tier_scheduler()` 每次调用
    **无条件再起一份** ⇒ 连续两次 `TestClient(app)` lifespan 会真的双跑
    （两套线程各跑各的轮次，抢同一把抓取锁）。

本文件钉住的判据（每条都能被一种反向改法弄红，见 devlog/211）：
  ① 三个线程各只有一份，`start()` 幂等；
  ② `stop()` 让线程**真的退出** + 幂等 + 没启动过也不抛；
  ③ 线程停在等待里时 `stop()` **立刻**返回（把 `wait` 换回 `time.sleep` ⇒ 这条必红）；
  ④ 正在跑的轮次会被取消（`run()` 登记的循环被 cancel，不是"等它跑完"）；
  ⑤ 停在"等手动任务"里的外部批次也能被叫停，且**不继续执行**；
  ⑥ start-stop-start 不留上一代的线程对象；
  ⑦ 真 lifespan 连跑两次不双跑、退出后线程归零；
  ⑧ 运行时**不持有 asyncio 原语**（跨线程 / 跨循环复用，见 `ARCHITECTURE.md` §6 第 15 条）。

⚠️ **为什么不用 `with TestClient(app)` 走真 lifespan**：测试进程里 `settings.DATA_DIR`
= **仓库根** ⇒ 真 lifespan 会在**开发者那本真库**上跑迁移 / 备份 / auto_vacuum
（devlog/200 那一类"用例碰了真实数据目录，而它不会红"）。这里直接驱动
`app.main.lifespan`，把"碰盘 / 碰网"的四件事（迁移、库维护、运行时设置载入、
WBI 预热 + auth 心跳）换成替身，**只留接线部分**验证。
"""
from __future__ import annotations

import asyncio
import inspect
import threading
import time
from unittest.mock import MagicMock

import pytest

from app.services import scheduler as sch

# 三个守护线程的名字（与 `SchedulerRuntime` 里登记的一致）
NAMES = ("tier-scheduler", "t0-live-poller", "startup-external")


async def _never_finishes() -> dict:
    """替身：外部补抓"永远跑不完"，用来验证 stop 能把它取消掉。"""
    await asyncio.sleep(3600)
    return {"status": "never"}


async def _async_noop(*_a, **_k) -> None:
    return None


def _alive(names: tuple[str, ...] = NAMES) -> dict[str, int]:
    """当前**活着**的同名线程计数（重名 = 双跑）。"""
    counts: dict[str, int] = {}
    for t in threading.enumerate():
        if t.name in names:
            counts[t.name] = counts.get(t.name, 0) + 1
    return counts


def _inert_scheduler(monkeypatch) -> None:
    """把调度器调成"起来就停在**可中断**等待里、不碰真库、不发请求"的姿态。"""
    monkeypatch.setattr(sch.settings, "STARTUP_CHAIN_DELAY", 300.0)
    monkeypatch.setattr(sch.settings, "TIER_TICK_SECONDS", 300)
    monkeypatch.setattr(sch.settings, "LIVE_POLL_SECONDS", 300.0)
    monkeypatch.setattr(sch, "run_startup_external_catchup", _never_finishes)
    monkeypatch.setattr(sch, "SessionLocal", lambda: MagicMock())


@pytest.fixture
def rt(monkeypatch):
    """一条互不干扰的运行时（不是进程级那个单例）。"""
    _inert_scheduler(monkeypatch)
    runtime = sch.SchedulerRuntime()
    yield runtime
    runtime.stop(timeout=5.0)          # 用例红了也要收干净，别把线程漏给后面的用例


# ── ① 幂等启动：三个线程各只有一份 ──────────────────────────────────────

def test_start_is_idempotent_and_starts_one_thread_each(rt):
    rt.start()
    first = dict(rt.threads)
    assert sorted(first) == sorted(NAMES), "运行时该且只该管这三个线程"
    rt.start()                          # 幂等：不许再起一份
    rt.start()
    assert dict(rt.threads) == first
    assert _alive() == {n: 1 for n in NAMES}, f"线程数不对（双跑？）：{_alive()}"


# ── ② stop：真的退出、幂等、没启动过也不抛 ──────────────────────────────

def test_stop_joins_every_thread_and_is_idempotent(rt):
    rt.start()
    assert rt.stop(timeout=5.0) is True
    assert rt.alive_threads() == (), f"stop 返回了却还有线程活着：{rt.alive_threads()}"
    assert _alive() == {}
    assert rt.stop(timeout=5.0) is True         # 再停一次不许抛
    assert rt.accepting() is False


def test_stop_without_start_is_safe_and_leaves_no_fake_stop_state():
    """没启动过的运行时：`stop()` 安全返回，但**不许**留下"正在停止"的假状态。

    为什么单列这一条：停止事件是"本代正在停"，不是"这个进程永远完了"。第一版让它
    在从未启动时也置位，结果 `_wait_for_manual_tasks()` / 外部批次都会读到它 ——
    实测毒到了**后面两条与调度无关的用例**（`test_services.py` 的外部批次排队）。
    """
    runtime = sch.SchedulerRuntime()
    assert runtime.started is False
    assert runtime.stop(timeout=1.0) is True      # 没启动过也安全
    assert runtime.accepting() is False
    assert runtime.stop_requested() is False, "从未启动 ⇒ 不该有停止请求"


def test_wait_returns_immediately_after_a_real_stop(rt):
    """线程都停干净后停止请求要**收回**（否则"已停止"会一直粘在这个进程上）。"""
    rt.start()
    assert rt.wait(0.05) is False                 # 在跑：等满 50ms 才返回 False
    assert rt.stop(timeout=5.0) is True
    assert rt.stop_requested() is False
    assert rt.stop(timeout=5.0) is True           # 幂等停止不许重新粘上
    assert rt.stop_requested() is False


# ── ③ 等待中可停止（反向改法：wait → time.sleep ⇒ 必红）──────────────────

def test_stop_interrupts_threads_that_are_waiting(rt):
    rt.start()
    time.sleep(0.05)                             # 让线程真的进到等待里
    t0 = time.monotonic()
    assert rt.stop(timeout=5.0) is True
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0, (
        f"stop 花了 {elapsed:.1f}s —— 线程还停在不可中断的 sleep 里"
        "（改成 stop_event.wait 之后应当是毫秒级）"
    )


def test_start_after_stop_does_not_inherit_the_stop_request(rt):
    """start-stop-start：新一代不许继承上一代的停止请求（否则一起来就自杀）。"""
    rt.start()
    rt.stop(timeout=5.0)
    rt.start()
    assert rt.stop_requested() is False, "start() 必须开新一代停止事件"
    assert rt.wait(0.05) is False, "新一代在跑，等待不该立刻返回"


# ── ④ 在飞轮次会被取消 ──────────────────────────────────────────────────

def test_stop_cancels_an_inflight_round(rt, monkeypatch):
    """`run()` 把事件循环登记在册 ⇒ `stop()` 取消在飞轮次，而不是等它跑完。"""
    started = threading.Event()

    async def _slow_round(**_kwargs):
        started.set()
        await asyncio.sleep(3600)               # 模拟一次"卡在网络上"的轮次

    monkeypatch.setattr(sch.settings, "STARTUP_CHAIN_DELAY", 0.0)
    monkeypatch.setattr(sch.settings, "STARTUP_CHAIN_ENABLED", False)
    monkeypatch.setattr(sch.settings, "TIER_TICK_SECONDS", 1)
    monkeypatch.setattr(sch, "_run_combined_tier", _slow_round)
    monkeypatch.setattr(sch, "_dynamics_due_or_retry",
                        lambda db, **kw: time.monotonic() - 1)   # 永远到期
    monkeypatch.setattr(sch, "_next_dynamics_cost", lambda db: {})
    monkeypatch.setattr(sch, "_account_sweep_due_now", lambda db: False)
    monkeypatch.setattr(sch, "_drain_pending_fetches", lambda: None)

    rt.start()
    assert started.wait(5.0), "综合档没跑起来（到期时刻的替身没生效？）"
    t0 = time.monotonic()
    assert rt.stop(timeout=5.0) is True, "在飞轮次没被取消 ⇒ join 超时"
    assert time.monotonic() - t0 < 3.0
    assert rt.alive_threads() == ()


# ── ⑤ 等手动任务那一支（最坏 30 分钟的 sleep）也进停止语义 ────────────────

def test_manual_task_wait_can_be_interrupted(monkeypatch):
    """停在「等手动任务」里的外部批次也能被叫停（最坏 30 分钟的等待）。

    这一支读的是**进程级**运行时（APScheduler 的批次任务就是这么调的），
    所以这里起的是 `sch.runtime` 本身，不是夹具那条独立实例。
    """
    _inert_scheduler(monkeypatch)
    monkeypatch.setattr(sch, "any_fetch_running", lambda: True)
    done = threading.Event()
    result: list[bool] = []

    def _wait() -> None:
        result.append(sch._wait_for_manual_tasks(timeout_seconds=600.0, poll_seconds=30.0))
        done.set()

    sch.runtime.start()
    try:
        t = threading.Thread(target=_wait, name="manual-wait-probe", daemon=True)
        t.start()
        time.sleep(0.1)                         # 让它进到等待里
        t0 = time.monotonic()
        assert sch.runtime.stop(timeout=5.0) is True
        assert done.wait(2.0), "停止请求没能叫醒「等手动任务」的线程（还是 sleep？）"
        assert time.monotonic() - t0 < 2.0
        assert result == [False], "被叫停的外部批次必须返回 False（本轮放弃），不能照跑"
        t.join(2.0)
    finally:
        sch.runtime.stop(timeout=5.0)


# ── ⑥ start-stop-start 不留上一代 ───────────────────────────────────────

def test_start_stop_start_leaves_no_previous_generation(rt):
    rt.start()
    gen1 = dict(rt.threads)
    rt.stop(timeout=5.0)
    rt.start()
    gen2 = dict(rt.threads)
    assert sorted(gen1) == sorted(gen2) == sorted(NAMES)
    for name, old in gen1.items():
        assert old is not gen2[name], f"{name} 还是上一代那个线程对象（没重建）"
        assert not old.is_alive(), f"{name} 上一代的线程还活着"
    assert _alive() == {n: 1 for n in NAMES}


# ── ⑦ 真 lifespan：连跑两次不双跑、退出后归零 ───────────────────────────

def test_two_consecutive_lifespans_do_not_double_run(monkeypatch):
    import app.main as app_main
    from app.core import runtime_settings
    from app.routers import img_proxy
    from app.services import db_maintenance
    from app.services.auth import auth_manager

    # 只留接线：迁移 / 库维护 / 设置覆盖层 / WBI 预热 / auth 心跳 全换替身
    monkeypatch.setattr(app_main, "_run_migrations", lambda: None)
    monkeypatch.setattr(db_maintenance, "ensure_incremental_autovacuum", lambda: "already")
    monkeypatch.setattr(db_maintenance, "checkpoint_wal", lambda: None)
    monkeypatch.setattr(runtime_settings, "load", lambda: None)
    monkeypatch.setattr(app_main, "_warm_wbi", _async_noop)
    monkeypatch.setattr(auth_manager, "run_maintenance", _async_noop)
    monkeypatch.setattr(img_proxy, "close_client", _async_noop)
    monkeypatch.setattr(sch.settings, "STARTUP_CHAIN_DELAY", 300.0)
    monkeypatch.setattr(sch, "run_startup_external_catchup", _never_finishes)

    seen: list[dict[str, int]] = []

    async def _one_lifespan() -> None:
        async with app_main.lifespan(app_main.app):
            seen.append(_alive())

    for i in range(2):
        asyncio.run(_one_lifespan())
        assert _alive() == {}, f"第 {i + 1} 次 lifespan 退出后仍有调度线程活着：{_alive()}"
    assert seen == [{n: 1 for n in NAMES}] * 2, f"两次 lifespan 的线程数不对：{seen}"


# ── ⑧ 结构性判据：不许再退回不可中断的 sleep / loop-bound 原语 ─────────────

def test_scheduler_loops_have_no_uninterruptible_sleep():
    """三个守护线程 + 外部批次等待：函数体里不许再出现 `time.sleep`。

    这是③的结构版判据（行为版在 `test_stop_interrupts_threads_that_are_waiting`）：
    行为版只抓得住"停止那一刻恰好在睡"的那一处，这条把整类写法都钉住。
    """
    for fn in (sch._tier_loop, sch._live_poller_loop, sch._startup_catchup_loop,
               sch._wait_for_manual_tasks):
        src = inspect.getsource(fn)
        code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
        assert "time.sleep" not in code, f"{fn.__name__} 里还有不可中断的 sleep"


def test_runtime_holds_no_event_loop_primitives(rt):
    """§6 第 15 条的延伸：运行时跨线程、跨事件循环复用 ⇒ 只能拿同步原语。"""
    loop_bound = (asyncio.Lock, asyncio.Semaphore, asyncio.Event, asyncio.Queue,
                  asyncio.Condition)
    for name, value in vars(rt).items():
        assert not isinstance(value, loop_bound), \
            f"SchedulerRuntime.{name} 持有 {type(value).__name__}（跨循环必炸，见 §6 第 15 条）"
    assert isinstance(rt._stop, threading.Event), "停止通知必须是 threading.Event"
