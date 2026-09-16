# -*- coding: utf-8 -*-
"""风控冷却的状态与策略（R27，devlog/125）。

为什么这批要专门测：冷却原先只是 `scheduler` 里的两个模块级变量（`_rate_limit_until` /
`_rate_limit_reason`），带来三个后果（2026-09-16 盘点见 devlog/124）：

1. **不落库** ⇒ 重启（含**应用内更新后的自动重启**）即遗忘、立刻恢复满速 ——
   而"被限流之后重启继续敲"恰恰是最容易被加重处罚的行为；
2. **固定 `RATE_LIMIT_COOLDOWN`、不升级**；
3. **没有解禁恢复期**。

本文件把三件事钉住：**升级梯度与归零**（纯函数）· **重启不遗忘**（真库读回）·
**自动档跳过、手动档不跳**（名单与账号两条路径）。
"""
import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.vtuber import Account, VTuber
from app.services import rate_limit as rl
from app.services import scheduler as sch


# ── 纯策略：升级梯度 / 归零 / 恢复期 ───────────────────────────────────

def test_escalation_ladder_and_cap():
    """1→base、2→2×base、≥3→4×base，且封顶 60 分钟。"""
    assert rl.escalated_seconds(600, 1) == 600
    assert rl.escalated_seconds(600, 2) == 1200
    assert rl.escalated_seconds(600, 3) == 2400
    assert rl.escalated_seconds(600, 9) == 2400          # 4×600 还没到上限
    assert rl.escalated_seconds(1200, 3) == 3600         # 4×1200 → 封顶 60 分钟
    assert rl.escalated_seconds(0, 3) == 0               # base=0（关掉冷却）不该变成 0×4=0 之外的怪值


def test_hits_decay_after_quiet_window():
    """连续 QUIET_SECONDS 没再命中 ⇒ 下次又从 base 起（"消停够久就重新开始"）。"""
    now = 1_000_000.0
    assert rl.decayed_hits(3, now - 5 * 3600, now) == 3
    assert rl.decayed_hits(3, now - rl.QUIET_SECONDS, now) == 0
    assert rl.decayed_hits(0, 0.0, now) == 0


def test_register_hit_escalates_then_resets():
    now = 1_000_000.0
    st = rl.State(platform="bilibili")
    st = rl.register_hit(st, "code=-352", now, 600)
    assert (st.hits, st.until, st.reason) == (1, now + 600, "code=-352")
    st = rl.register_hit(st, "code=-352", now + 10, 600)
    assert st.hits == 2 and st.until == now + 10 + 1200
    # 7 小时后（> 6h 归零窗口）再命中 → 回到 base、命中数重新从 1 起
    later = now + 7 * 3600
    st = rl.register_hit(st, "code=-352", later, 600)
    assert st.hits == 1 and st.until == later + 600


def test_mark_ended_opens_the_ramp_window():
    now = 1_000_000.0
    st = rl.register_hit(rl.State(platform="weibo"), "x", now, 600)
    st = rl.mark_ended(st, now + 600)
    assert st.until == 0.0 and st.ended_at == now + 600
    assert st.hits == 1                     # 命中数保留：恢复期与后续升级都要用
    assert rl.ramp_factor(st, now + 610) == rl.RAMP_FACTOR
    assert rl.ramp_factor(st, now + 600 + rl.RAMP_SECONDS + 1) == 1.0


def test_ramp_scale_takes_the_most_conservative_platform():
    now = 1000.0
    cooling = rl.mark_ended(rl.State(platform="bilibili"), now)
    quiet = rl.State(platform="weibo")
    assert rl.ramp_scale([cooling, quiet], now + 5) == rl.RAMP_FACTOR
    assert rl.ramp_scale([cooling, quiet], now + 5, platforms=["weibo"]) == 1.0
    assert rl.ramp_scale([cooling, quiet], now + rl.RAMP_SECONDS + 1) == 1.0


def test_state_json_round_trip_and_bad_input():
    st = rl.State(platform="bilibili", until=123.0, reason="r",
                  hits=2, last_hit_at=100.0, ended_at=99.0)
    assert rl.State.from_json("bilibili", st.to_json()) == st
    assert rl.State.from_json("x", "{不是 json") is None      # 坏数据跳过，不该炸调度
    assert rl.State.from_json("x", "") == rl.State(platform="x")


# ── 真库：重启不遗忘 ──────────────────────────────────────────────────

@pytest.fixture()
def db(monkeypatch):
    """内存库 + 把 `scheduler.SessionLocal` 指过来（与其它调度用例同款）。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(sch, "SessionLocal", Maker)
    monkeypatch.setattr(sch, "_rl_states", {})      # 每个用例一份干净的内存状态
    monkeypatch.setattr(sch, "_rl_loaded", False)
    session = Maker()
    yield session
    session.close()


def test_cooldown_survives_restart(db):
    """**R27 的核心**：写库 → 清内存（模拟重启）→ 读回，冷却与命中数都还在。"""
    sch._note_rate_limit("code=-352, msg=风控校验失败", None, "bilibili")
    assert sch.is_platform_cooling("bilibili") is True

    # 模拟"应用重启"：内存清空、标记未加载
    sch._rl_states.clear()
    sch._rl_loaded = False
    assert sch.is_platform_cooling("bilibili") is False      # 清空后确实忘了
    assert sch.rate_limit_status()["active"] is False

    sch._load_rate_limit_state()
    assert sch._rl_loaded is True
    assert sch.is_platform_cooling("bilibili") is True       # 读回来了
    status = sch.rate_limit_status()
    assert status["active"] is True
    assert status["platform"] == "bilibili"
    assert status["hits"] == 1
    assert status["seconds_left"] > 500                      # 剩余时间也在


def test_second_hit_escalates_and_is_reported(db):
    first = sch._note_rate_limit("x", None, "bilibili")
    second = sch._note_rate_limit("x", None, "bilibili")
    assert 590 <= first <= 600
    assert 1190 <= second <= 1200, second                    # 第 2 次翻倍
    assert sch.rate_limit_status()["hits"] == 2


def test_cooling_is_per_platform(db):
    """B 站被限流不该连带把微博也停掉（文档口径：只冷却出问题的平台）。"""
    sch._note_rate_limit("x", None, "bilibili")
    assert sch.is_platform_cooling("bilibili") is True
    assert sch.is_platform_cooling("weibo") is False
    note = sch.platform_cooling_note("bilibili")
    assert note and "冷却" in note and "1 次" in note
    assert sch.platform_cooling_note("weibo") is None


# ── 自动档跳过 / 手动档不跳 ───────────────────────────────────────────

def test_auto_only_filter_skips_cooling_platforms(monkeypatch):
    """`_filter_cooling_accounts`：auto=True 跳过冷却平台，auto=False 原样返回。"""

    class _Acc:
        def __init__(self, pf: str, uid: str):
            self.platform, self.platform_uid = pf, uid

    accounts = [_Acc("bilibili", "1"), _Acc("weibo", "2")]
    monkeypatch.setattr(sch, "_rl_states", {
        "bilibili": rl.State(platform="bilibili", until=time.time() + 600)})

    kept, cooling = sch._filter_cooling_accounts(accounts, auto=True)
    assert [a.platform for a in kept] == ["weibo"] and cooling == ["bilibili"]

    kept_manual, cooling_manual = sch._filter_cooling_accounts(accounts, auto=False)
    assert len(kept_manual) == 2 and cooling_manual == []     # **手动档不受影响**
    assert sch._filter_cooling_accounts([], auto=True) == ([], [])


def test_cooling_platform_is_skipped_from_dynamics_lanes(db, monkeypatch):
    """冷却中的平台整条动态名单跳过，并给出可读原因（重启后"等完剩余时间"的落地方式）。"""
    v = VTuber(name="测试V")
    db.add(v)
    db.commit()
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="123"))
    db.commit()
    # 把"未登录/登录态失效"这条既有判据摘掉，隔离出本批新增的冷却判据
    monkeypatch.setattr(sch, "_lane_skip_reason", lambda pf: None)

    lanes, skipped = sch._active_dynamics_lanes(db)
    assert "bilibili" in lanes and skipped == {}

    sch._note_rate_limit("x", None, "bilibili")
    lanes, skipped = sch._active_dynamics_lanes(db)
    assert "bilibili" not in lanes
    assert "冷却" in skipped["bilibili"] and "剩余" in skipped["bilibili"]


def test_expired_cooldown_no_longer_blocks(db, monkeypatch):
    """冷却过期后（哪怕状态还在库里）名单与账号都不再被跳过。"""
    v = VTuber(name="测试V")
    db.add(v)
    db.commit()
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="123"))
    db.commit()
    monkeypatch.setattr(sch, "_lane_skip_reason", lambda pf: None)
    monkeypatch.setattr(sch, "_rl_states", {
        "bilibili": rl.State(platform="bilibili", until=time.time() - 1, hits=1)})

    lanes, skipped = sch._active_dynamics_lanes(db)
    assert "bilibili" in lanes and skipped == {}
    assert sch.rate_limit_status()["active"] is False
    assert sch.is_platform_cooling("bilibili") is False
