# -*- coding: utf-8 -*-
"""动态流空闲退避与预算真上限（R28，devlog/127）。

起因（2026-09-16 盘点，devlog/124）：动态流占日请求量约 **90%**，而且**无论有没有新帖**
都按预算允许多快跑多快 —— 一个"三天没动静"的库照样每天一万多条请求；账号数超过 rpm 时
`_PlatformBudget._rpm_for()` 还会把上限抬到"至少装得下一轮"，于是稳态速率**随账号数线性上抬**。

用户 2026-09-16 定两条口径：① 退避梯度 **2 / 5 / 10 分钟**（连续 3 / 6 / 12 轮无新帖），
恢复条件 = 抓到新帖 / 手动抓一次 / T0 检测到开播；② 预算改成**真上限**（逃逸口只保证
"这一轮跑得动"，下一轮按比例拉长，稳态回到 rpm）。

⚠️ 与 R25 推送时效的关系：**开播检测走 T0（1 请求/分钟），不受本批影响** —— 这条写在
`TODO.md` §0 的 R28 行里，免得以后被"推送要快"整条否掉。
"""
import re
import time
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, VTuber
from app.services import scheduler as sch

# 时间下限断言的容差（2026-09-25，CI 首跑抓到的**浮点 ULP**问题）。
#
# 现象：CI 上偶发 `assert (1167.687 - 567.687) >= 600`，本地单跑 20 次不复现。
# 真因**不是"时钟漂移"**，是浮点精度：`time.monotonic()` 在 2e5 量级时，
# `(t + 600) - t` 实测 = `599.9999992999947` —— 比 600 少 7e-7。
# 而 `_dynamics_next_due` 的 `since + idle_floor` 正是这个形状
# （`scheduler.py:3369` 的 `due = max(due, base + idle_floor)`），
# 于是**严格 `>=` 会随机红**，红的概率取决于当时的 monotonic 绝对值。
#
# 为什么用容差而不是"把下限钉成 599"：那会把判据改弱成一个不存在的阈值。
# 1e-3 秒比 ULP 效应（~1e-6）大三个数量级，又远小于任何有意义的时间差。
#
# ⚠️ **同类事故到 2026-09-26 已经两次**（第二次 = devlog/204）：第一次抓到 600 / 150 那几处，
# 却**漏了 `>= 300` 那一处** ⇒ CI 的 Windows 腿又偶发红（本地/干净 clone 都不复现，
# 因为要不要红取决于当时 `time.monotonic()` 的绝对值与小数部分）。
# ⇒ 规矩：**这一族下限断言一律写 `>= N - FLOOR_EPS`**，且由
# `test_every_lower_bound_uses_the_ulp_tolerance`（本文件末尾）扫源码钉住 —— 别靠人记得。
FLOOR_EPS = 1e-3


# ── 纯函数：退避梯度 ──────────────────────────────────────────────────

def test_idle_ladder_steps():
    """连续 3 / 6 / 12 轮无新帖 ⇒ 间隔下限 2 / 5 / 10 分钟；未达第一档不干预。"""
    assert sch.dynamics_idle_floor(0) == 0.0
    assert sch.dynamics_idle_floor(2) == 0.0
    assert sch.dynamics_idle_floor(3) == 120.0
    assert sch.dynamics_idle_floor(5) == 120.0
    assert sch.dynamics_idle_floor(6) == 300.0
    assert sch.dynamics_idle_floor(11) == 300.0
    assert sch.dynamics_idle_floor(12) == 600.0
    assert sch.dynamics_idle_floor(999) == 600.0          # 封顶


def test_round_counter_resets_on_new_posts(monkeypatch):
    """抓到新帖 → 立即清零（"有事发生"）；连续没抓到 → 累加并跨档。"""
    monkeypatch.setattr(sch, "_dynamics_idle_streak", 0)
    for _ in range(2):
        sch._note_dynamics_round(stored=0)
    assert sch._dynamics_idle_streak == 2

    sch._note_dynamics_round(stored=7)
    assert sch._dynamics_idle_streak == 0                 # 恢复满速

    for _ in range(12):
        sch._note_dynamics_round(stored=0)
    assert sch._dynamics_idle_streak == 12


def test_manual_activity_resets_the_streak(monkeypatch):
    """手动抓取 / 开播都走 `note_dynamics_activity` 清零。"""
    monkeypatch.setattr(sch, "_dynamics_idle_streak", 9)
    sch.note_dynamics_activity("手动抓取帖子")
    assert sch._dynamics_idle_streak == 0


# ── 纯函数：预算真上限 ────────────────────────────────────────────────

def test_round_budget_seconds_only_bites_when_over_rpm():
    """一轮装得下预算 → 不干预；装不下 → 下一轮至少等"这一轮消耗的预算时长"。"""
    assert sch._dynamics_round_budget_seconds({"bilibili": 8}, 12) == 0.0
    assert sch._dynamics_round_budget_seconds({"bilibili": 12}, 12) == 0.0
    assert sch._dynamics_round_budget_seconds({"bilibili": 30}, 12) == 150.0   # 30/12×60
    # 取最严重的那个平台
    assert sch._dynamics_round_budget_seconds({"bilibili": 30, "weibo": 36}, 12) == 180.0
    assert sch._dynamics_round_budget_seconds({"bilibili": 30}, 0) == 0.0      # rpm 关掉 = 不管


def test_more_accounts_no_longer_raise_the_sustained_rate():
    """口径本身：稳态速率 = rpm（逃逸口只让这一轮跑得动）。

    账号数 30、rpm 12：一轮 30 个请求 ⇒ 间隔下限 150s ⇒ 稳态 30/150s = 12 req/min ✓
    （改动前：每一轮都按 30 装得下 ⇒ 周期只有 60s 下限 ⇒ 稳态 30 req/min）。
    """
    interval = sch._dynamics_round_budget_seconds({"bilibili": 30}, 12)
    assert 30 / interval * 60 == pytest.approx(12.0)


# ── 接线：`_dynamics_next_due` 真的被这两条影响 ────────────────────────

@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    monkeypatch.setattr(sch, "SessionLocal", Maker)
    monkeypatch.setattr(sch, "_lane_skip_reason", lambda pf: None)   # 隔离登录闸门
    monkeypatch.setattr(sch.capabilities, "content_fetch_allowed", lambda: (True, ""))
    session = Maker()
    # 一个 V 一个账号 → 一轮 1 个请求（远小于 rpm，用来隔离"预算上限"那条）
    v = VTuber(name="测试V")
    session.add(v)
    session.commit()
    session.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="11"))
    session.commit()
    yield session
    session.close()


def test_next_due_honours_idle_floor(db, monkeypatch):
    """空闲到第 3 轮 ⇒ 下一轮不得早于"本轮开始 + 2 分钟"。"""
    monkeypatch.setattr(sch, "_dynamics_idle_streak", 0)
    since = time.monotonic()
    due_active = sch._dynamics_next_due(db, since=since)
    assert due_active - since < 120          # 正常档：远小于 2 分钟（周期下限 60s 兜着）

    monkeypatch.setattr(sch, "_dynamics_idle_streak", 6)
    due_idle = sch._dynamics_next_due(db, since=since)
    # ⚠️ 容差见文件头 FLOOR_EPS —— 这一处 2026-09-26 就是漏了它才让 CI 的 Windows 腿红的
    #    （`assert (698.031 - 398.031) >= 300`：真值是 299.99999999999994）
    assert due_idle - since >= 300 - FLOOR_EPS    # 第 6 轮档位：≥ 5 分钟

    monkeypatch.setattr(sch, "_dynamics_idle_streak", 12)
    # 容差见文件头的 FLOOR_EPS（浮点 ULP，不是漂移）
    assert sch._dynamics_next_due(db, since=since) - since >= 600 - FLOOR_EPS


def test_next_due_grows_with_account_count_over_rpm(db, monkeypatch):
    """账号数超过 rpm 时，轮间隔按下限拉长（预算成了真上限）。"""
    monkeypatch.setattr(sch, "_dynamics_idle_streak", 0)
    monkeypatch.setattr(sch.settings, "DYNAMICS_BUDGET_RPM", 2)
    # ⚠️ 把轮间抖动钉成 0：否则 ±15s 的随机量会让"≥150s"这种断言时红时绿
    # （第一版就因为 −13.6s 的抖动红过一次）
    monkeypatch.setattr(sch.settings, "DYNAMICS_JITTER_SECONDS", 0.0)
    # 5 个账号 → 一轮 5 个请求 / rpm 2 ⇒ 下限 150s
    for uid in ("12", "13", "14", "15"):
        db.add(Account(vtuber_id=db.query(VTuber).first().id,
                       platform="bilibili", platform_uid=uid))
    db.commit()
    since = time.monotonic()
    due = sch._dynamics_next_due(db, since=since)
    # 同 `test_next_due_honours_idle_floor`：浮点 ULP 容差（见文件头 FLOOR_EPS）
    assert due - since >= 150 - FLOOR_EPS


def test_manual_entry_resets_idle_streak(monkeypatch):
    """手动抓取入口确实清了空闲计数（不是在文档里说说）。

    手法：让内容闸门直接拒绝 —— `async_fetch_posts` 是**先清零、再查闸门**，
    于是函数在发任何请求之前就返回，本用例只需断言清零被调用过。
    """
    import asyncio

    calls: list[str] = []
    monkeypatch.setattr(sch, "note_dynamics_activity", lambda why="": calls.append(why))
    monkeypatch.setattr(sch.capabilities, "content_fetch_allowed",
                        lambda: (False, "未登录（测试）"))

    out = asyncio.run(sch.async_fetch_posts("bilibili", "11", 1, 1))
    assert out.stop_reason == "login_required"
    assert calls == ["手动抓取帖子"]


def test_live_start_resets_idle_streak(db, monkeypatch):
    """T0 检测到开播 ⇒ 动态流立即恢复满速（这是"别用推送要快否掉退避"的落点）。"""
    import asyncio

    acc = db.query(Account).first()
    acc.live_status = 0
    db.commit()

    async def _fake_batch(mids, client=None, **kw):
        return {str(acc.platform_uid): {"live_status": 1, "live_title": "开播啦",
                                        "live_url": "https://live.bilibili.com/1",
                                        "room_id": 1}}

    monkeypatch.setattr(sch, "fetch_bilibili_live_batch", _fake_batch)
    monkeypatch.setattr(sch, "_dynamics_idle_streak", 9)

    asyncio.run(sch.live_sweep_core(db))
    assert sch._dynamics_idle_streak == 0        # 开播边沿把退避清零了


# ── 判据自身的纪律：下限断言必须带 ULP 容差（2026-09-26 加，devlog/204）──────
#
# "把浮点 ULP 当容差"这件事**靠人记得已经失败两次**：第一次（devlog/200）补了 600/150/900/1800
# 那几处，却漏了 `>= 300` 那一处 ⇒ 2026-09-26 CI 的 Windows 腿又偶发红，而本地与干净 clone
# 都不复现（要不要红取决于当时 `time.monotonic()` 的绝对值）。
# ⇒ 判据改成**扫源码**：凡是"两个时间量相减 >= 数字"的形状，没带容差就算漏。

#: `- <名字> >= <数字>`（差值比较的形状；`< 120` 那种上界不受 ULP 影响，不在此列）
_LOWER_BOUND = re.compile(r"-\s*\w+\s*>=\s*[\d.]+")
#: 带容差的两种合法写法（命名常量 / 内联 1e-3）
_TOLERANCE = ("FLOOR_EPS", "1e-3")


def test_every_lower_bound_uses_the_ulp_tolerance():
    """本文件与 `test_quiet_hours.py` 里所有下限断言都必须减掉 ULP 容差。

    反向验证：把那处 300 秒的断言改回**不带容差的裸比较** ⇒ 本用例红并点名行号
    —— 这正是 2026-09-26 CI 的 Windows 腿红的那一处。
    """
    offenders: list[str] = []
    for name in ("test_dynamics_backoff.py", "test_quiet_hours.py"):
        text = (Path(__file__).parent / name).read_text(encoding="utf-8")
        for no, line in enumerate(text.splitlines(), 1):
            if _LOWER_BOUND.search(line) and not any(t in line for t in _TOLERANCE):
                offenders.append(f"{name}:{no}: {line.strip()}")
    assert not offenders, (
        "这些下限断言没带 ULP 容差（`>= N - FLOOR_EPS`）—— 它们会随 monotonic 的绝对值偶发红，"
        "而且**本地不会复现**（CI 专属红，2026-09-25 / 2026-09-26 各一次）：\n  "
        + "\n  ".join(offenders)
    )


# ── 热更设置必须真的生效（批次 5 切片一，devlog/209）──────────────────────
#
# 这一组守的是一句**用户能感觉到的话**：「我在设置里改了抓取节奏，它到底吃不吃？」
# 原来两个模块级单例在 import 期就把 `settings.X` 取成了固定值 ⇒ 改了不生效，
# 而 `runtime_settings` 的承诺是"每一轮读一次"。

def test_production_budget_reads_the_hot_setting(monkeypatch):
    """**用真单例**断言：改 `DYNAMICS_BUDGET_RPM` ⇒ 预算立刻跟着变。

    ⚠️ 必须打真单例（`sch._dynamics_budget`）而不是新建一个 —— 新建的话，
    就算有人把 `_PlatformBudget(settings.X)` 写回 import 期，这条用例照样绿。

    反向验证：把 `_dynamics_budget = _PlatformBudget()` 改回
    `_PlatformBudget(settings.DYNAMICS_BUDGET_RPM)` ⇒ 本用例红。
    """
    monkeypatch.setattr(sch.settings, "DYNAMICS_BUDGET_RPM", 3)
    assert sch._dynamics_budget.rpm == 3
    monkeypatch.setattr(sch.settings, "DYNAMICS_BUDGET_RPM", 30)
    assert sch._dynamics_budget.rpm == 30


def test_explicit_budget_stays_fixed(monkeypatch):
    """显式传值的用法**不受影响**（用例与别的调用方要能钉一个固定值）。"""
    monkeypatch.setattr(sch.settings, "DYNAMICS_BUDGET_RPM", 30)
    fixed = sch._PlatformBudget(12, window_seconds=60.0)
    assert fixed.rpm == 12
    assert sch._PlatformBudget(0).rpm == 0        # 0 = 不启用，别被当成"没传"


def test_production_pacer_reads_the_hot_setting(monkeypatch):
    """起跑闸门同理：改 `STARTUP_DYNAMICS_INTERVAL_*` ⇒ 下一个时隙就按新值排。

    反向验证：把 `_dynamics_pacer = _PlatformPacer()` 改回传 settings ⇒ 红。
    """
    pacer = sch._dynamics_pacer
    pacer._last.clear()
    monkeypatch.setattr(sch.settings, "STARTUP_DYNAMICS_INTERVAL_MIN", 5.0)
    monkeypatch.setattr(sch.settings, "STARTUP_DYNAMICS_INTERVAL_MAX", 5.0)
    pacer._reserve("bilibili", now=0.0)                 # 占下第一个时隙
    monkeypatch.setattr(sch.settings, "STARTUP_DYNAMICS_INTERVAL_MIN", 60.0)
    monkeypatch.setattr(sch.settings, "STARTUP_DYNAMICS_INTERVAL_MAX", 60.0)
    assert pacer._reserve("bilibili", now=0.0) == 60.0  # 热更后立刻按 60s 排

