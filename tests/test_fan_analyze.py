"""分析任务化（2026-10-28，第四批的后端部分）。

钉三件事：

1. `load_window(on_progress=…)` 真的**逐场**回调（1..n 递增、总数恒定、带场次标签）；
2. **回调报错不许影响加载** —— 进度是旁路信息，不能因为"报进度失败"让一次分析崩掉；
3. 分析任务与采集任务**互斥**（409），且 `tasks_snapshot()` 会把分析任务报给顶栏。
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from app.routers import fan as fan_router
from app.services.fan import load_window
from tests.test_fan_loader import _make_dataset, _ref


def test_load_window_reports_per_session_progress(tmp_path) -> None:
    _make_dataset(tmp_path)
    seen: list[tuple[int, int, str]] = []
    load_window(_ref(), 10, root=tmp_path,
                on_progress=lambda i, n, lb: seen.append((i, n, lb)))
    assert seen, "必须逐场回调（否则浮窗看不到'正在读第几场'）"
    assert [i for i, _, _ in seen] == list(range(1, len(seen) + 1))
    assert {n for _, n, _ in seen} == {len(seen)}
    assert all(isinstance(lb, str) and lb for *_, lb in seen)


def test_progress_callback_failure_does_not_break_loading(tmp_path) -> None:
    _make_dataset(tmp_path)

    def boom(i: int, n: int, label: str) -> None:
        raise RuntimeError("回调炸了")

    w = load_window(_ref(), 10, root=tmp_path, on_progress=boom)
    assert w.users, "回调报错不许影响加载结果"


def test_analyze_rejected_while_collecting() -> None:
    fan_router.reset_state()

    class _P:
        state = "running"
        vtuber = "别人的采集"

    fan_router._TASKS["x"] = _P()          # type: ignore[assignment]
    try:
        with pytest.raises(HTTPException) as ei:
            asyncio.run(fan_router.start_analyze("弥月", 75, None, None, None))
        assert ei.value.status_code == 409
        assert "采集" in str(ei.value.detail)
    finally:
        fan_router.reset_state()


def test_tasks_snapshot_reports_analyze() -> None:
    fan_router.reset_state()
    fan_router._ANALYZE["pilot_v3_mizuki"] = {
        "vtuber": "弥月Mizuki", "state": "running", "done": 3, "total": 75,
        "current": "", "started_at": 1.0,
    }
    try:
        snap = fan_router.tasks_snapshot()
        assert snap is not None
        assert snap["label"] == "分析名单"
        assert "3/75" in snap["who"]
    finally:
        fan_router.reset_state()
