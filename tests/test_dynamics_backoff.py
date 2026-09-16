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
import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, VTuber
from app.services import scheduler as sch


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
    assert due_idle - since >= 300           # 第 6 轮档位：≥ 5 分钟

    monkeypatch.setattr(sch, "_dynamics_idle_streak", 12)
    assert sch._dynamics_next_due(db, since=since) - since >= 600


def test_next_due_grows_with_account_count_over_rpm(db, monkeypatch):
    """账号数超过 rpm 时，轮间隔按下限拉长（预算成了真上限）。"""
    monkeypatch.setattr(sch, "_dynamics_idle_streak", 0)
    monkeypatch.setattr(sch.settings, "DYNAMICS_BUDGET_RPM", 2)
    # 5 个账号 → 一轮 5 个请求 / rpm 2 ⇒ 下限 150s
    for uid in ("12", "13", "14", "15"):
        db.add(Account(vtuber_id=db.query(VTuber).first().id,
                       platform="bilibili", platform_uid=uid))
    db.commit()
    since = time.monotonic()
    due = sch._dynamics_next_due(db, since=since)
    assert due - since >= 150


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

