"""顶栏进度条目里的**粉丝采集**（2026-10-28，D 批）。

钉三件事：

1. 运行中的 fan 采集 ⇒ 顶栏多一条 `progress-fan`（`progress` 状态类，文案带主播与
   `已完成/总场次`）；
2. 没有任务 ⇒ **不占顶栏**（不是"显示一条 0/0"—— 顶栏只放现在正在发生的事）；
3. `manual_running` 把它算进来（正在采几百场时关窗该拦一下），且**不丢**帖子任务那条老口径。
"""

from __future__ import annotations

import pytest

from app.services import notices


def _fake(monkeypatch: pytest.MonkeyPatch, snap: dict | None) -> None:
    """把 fan 路由的快照换成固定值（真实实现在 `app/routers/fan.py::tasks_snapshot`）。"""
    monkeypatch.setattr("app.routers.fan.tasks_snapshot", lambda: snap)


def test_fan_task_shows_progress_notice(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake(monkeypatch, {"label": "采集弹幕", "who": "弥月Mizuki 42/75 场", "started_at": 123.0})
    out = notices._progress_notices({}, 999)
    fan = [n for n in out if n["id"] == "progress-fan"]
    assert len(fan) == 1, out
    n = fan[0]
    assert n["kind"] == "progress"
    assert n["form"] == notices.FORM_STATE        # 状态类：跟事实同寿命、不许 ack
    assert "弥月Mizuki" in n["text"] and "42/75" in n["text"]
    # `createdAt` = 状态开始成立的时刻（缺 started_at 才退回 now，不猜）
    assert n["createdAt"] == 123


def test_no_fan_task_does_not_take_the_pill(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake(monkeypatch, None)
    assert [n for n in notices._progress_notices({}, 1) if n["id"] == "progress-fan"] == []


def test_manual_running_includes_fan_collect(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake(monkeypatch, None)
    assert notices._any_manual_running({}) is False
    _fake(monkeypatch, {"label": "采集弹幕", "who": "x 1/2 场", "started_at": 0})
    assert notices._any_manual_running({}) is True
    # 帖子/账号任务的老口径不能被这次改动弄丢
    assert notices._any_manual_running({"manual_running": True}) is True
