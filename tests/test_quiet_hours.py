# -*- coding: utf-8 -*-
"""静默时段（R30，devlog/130）。

用户口径：「夜间降频可以改为**定时时段**降频，因为即使 vtuber 全天都会开播，
但**用户不会全天醒着**」。用户当场定两条：

1. **默认关闭** —— 由用户显式开启并指定时刻（绝不悄悄改变行为）；
2. **只降动态流** —— T0 直播轮询保持 60s，因为直播日历的场次起止时间由 live 跳变推导，
   降它会把场次时间变粗（而动态流降频只影响"帖子多久变新"，发帖时间本身不受影响）。

本文件钉住：时段判定的边界与跨午夜 · `start == end` 不当成"整天静默" ·
关闭时行为**完全不变** · 与 R28 空闲档位取更保守的那个 · **T0 一行都没碰**。
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, VTuber
from app.services import scheduler as sch


def _quiet(on: bool, start: int = 3, end: int = 9) -> None:
    """把设置项调到指定值（这几个键都是可热更的）。"""
    sch.settings.QUIET_HOURS_ENABLED = on
    sch.settings.QUIET_HOURS_START = start
    sch.settings.QUIET_HOURS_END = end


@pytest.fixture(autouse=True)
def _restore_quiet_defaults():
    """用例改完把这四项恢复成默认（默认关闭），免得影响后面的用例。"""
    yield
    _quiet(False, 3, 9)
    sch.settings.QUIET_HOURS_DYNAMICS_MIN_SECONDS = 900


# ── 纯函数：时段判定 ──────────────────────────────────────────────────

def test_disabled_never_active():
    assert sch.quiet_hours_active(datetime(2026, 9, 16, 4), enabled=False, start=3, end=9) is False


def test_same_start_and_end_does_not_mean_all_day():
    """`start == end` 当**不生效**：否则误设一次就变成"整天静默"，用户会以为抓取坏了。"""
    for hour in (0, 3, 12, 23):
        assert sch.quiet_hours_active(datetime(2026, 9, 16, hour),
                                      enabled=True, start=5, end=5) is False


def test_normal_window_is_start_inclusive_end_exclusive():
    assert sch.quiet_hours_active(datetime(2026, 9, 16, 2), enabled=True, start=3, end=9) is False
    assert sch.quiet_hours_active(datetime(2026, 9, 16, 3), enabled=True, start=3, end=9) is True
    assert sch.quiet_hours_active(datetime(2026, 9, 16, 8), enabled=True, start=3, end=9) is True
    assert sch.quiet_hours_active(datetime(2026, 9, 16, 9), enabled=True, start=3, end=9) is False
    assert sch.quiet_hours_active(datetime(2026, 9, 16, 23), enabled=True, start=3, end=9) is False


def test_wraps_across_midnight():
    """23 → 7：23 点与次日凌晨都算静默，7 点整结束、22 点还没开始。"""
    for hour in (23, 0, 3, 6):
        assert sch.quiet_hours_active(datetime(2026, 9, 16, hour),
                                      enabled=True, start=23, end=7) is True, hour
    for hour in (7, 12, 22):
        assert sch.quiet_hours_active(datetime(2026, 9, 16, hour),
                                      enabled=True, start=23, end=7) is False, hour


def test_floor_only_inside_window():
    _quiet(True, 3, 9)
    sch.settings.QUIET_HOURS_DYNAMICS_MIN_SECONDS = 900
    assert sch.quiet_dynamics_floor(datetime(2026, 9, 16, 4)) == 900.0
    assert sch.quiet_dynamics_floor(datetime(2026, 9, 16, 12)) == 0.0
    _quiet(False, 3, 9)
    assert sch.quiet_dynamics_floor(datetime(2026, 9, 16, 4)) == 0.0     # 关掉 = 不干预


def test_status_snapshot_explains_itself():
    _quiet(True, 3, 9)
    st = sch.quiet_hours_status()
    assert set(st) == {"enabled", "active", "start", "end", "dynamics_min_seconds"}
    assert st["enabled"] is True and st["start"] == 3 and st["end"] == 9
    # 快照里的 active 与真实小时一致（不写死 True/False，免得跑在别的钟点就红）
    expected = sch.quiet_hours_active(datetime.now(), enabled=True, start=3, end=9)
    assert st["active"] is expected


# ── 接线：动态流真的被降下来，而 T0 一行都没碰 ────────────────────────

@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    monkeypatch.setattr(sch, "SessionLocal", Maker)
    monkeypatch.setattr(sch, "_lane_skip_reason", lambda pf: None)
    monkeypatch.setattr(sch.capabilities, "content_fetch_allowed", lambda: (True, ""))
    monkeypatch.setattr(sch.settings, "DYNAMICS_JITTER_SECONDS", 0.0)   # 抖动会让断言不稳
    session = Maker()
    v = VTuber(name="测试V")
    session.add(v)
    session.commit()
    session.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="11"))
    session.commit()
    yield session
    session.close()


def test_next_due_honours_quiet_floor(db, monkeypatch):
    """静默期内：下一轮不得早于"本轮开始 + 静默下限"。"""
    import time
    monkeypatch.setattr(sch, "_dynamics_idle_streak", 0)

    _quiet(False, 3, 9)
    since = time.monotonic()
    assert sch._dynamics_next_due(db, since=since) - since < 120      # 正常档（周期下限 60s 兜着）

    # 把"现在"钉进静默时段：直接让 floor 生效（避免用例随机器时钟漂）
    monkeypatch.setattr(sch, "quiet_dynamics_floor", lambda now_local=None: 900.0)
    assert sch._dynamics_next_due(db, since=since) - since >= 900


def test_quiet_and_idle_floors_take_the_more_conservative(db, monkeypatch):
    """两个下限同时存在时取更大的那个（R28 空闲档 vs R30 静默档）。"""
    import time
    monkeypatch.setattr(sch, "_dynamics_idle_streak", 12)             # R28 顶档 = 600s
    monkeypatch.setattr(sch, "quiet_dynamics_floor", lambda now_local=None: 1800.0)
    since = time.monotonic()
    assert sch._dynamics_next_due(db, since=since) - since >= 1800


def test_live_poller_is_not_slowed_by_quiet_hours():
    """**用户口径的直接护栏**：静默时段只降动态流，T0 一行都没碰。

    做法是源码级检查：`_live_poller_loop` 的函数体里不许出现 quiet 相关标识 ——
    否则某天有人"顺手"把开播轮询也降下来，直播日历的场次时间就会悄悄变粗。
    """
    import inspect

    src = inspect.getsource(sch._live_poller_loop)
    assert "quiet" not in src.lower(), "T0 直播轮询不该受静默时段影响（日历场次时间会变粗）"
    assert "LIVE_POLL_SECONDS" in src and "LIVE_POLL_JITTER_SECONDS" in src
