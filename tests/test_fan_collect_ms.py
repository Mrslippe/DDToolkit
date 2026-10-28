"""逐场耗时 `ms`（2026-10-28，四批改造的最后一个字段）。

为什么单独钉：`ms` 是**旁路信息**（浮窗显示"这一场花了多久"），最容易犯的两种错都很难看出来 ——
① 跳过/前置失败也写 `ms: 0`（假装花了 0 毫秒，比不写更误导）；
② 更新状态时把已有的 `title` 冲掉（`_mark` 是 update 而非替换，必须保住其它键）。
"""

from __future__ import annotations

from app.services.fan.collector import CollectProgress, _mark


def _prog_with_running() -> CollectProgress:
    p = CollectProgress(vtuber="弥月Mizuki", since="2026-09-01", until="2026-09-30")
    p.sessions_detail.append({
        "live_id": "L1", "start_at": "2026-09-01 20:00", "title": "杂谈回",
        "state": "running", "records": 0, "reason": "",
    })
    return p


def test_mark_writes_ms_and_keeps_title() -> None:
    p = _prog_with_running()
    _mark(p, "L1", "ok", 3200, "", 1234)
    item = p.sessions_detail[0]
    assert item["state"] == "ok"
    assert item["records"] == 3200
    assert item["ms"] == 1234
    assert item["title"] == "杂谈回", "更新状态不许把场次标题冲掉"


def test_mark_without_ms_does_not_fake_zero() -> None:
    p = _prog_with_running()
    _mark(p, "L1", "skipped", 0, "已存在")          # 跳过没有耗时概念
    assert "ms" not in p.sessions_detail[0]


def test_mark_creates_entry_without_ms_when_not_given() -> None:
    p = CollectProgress(vtuber="x", since="", until="")
    _mark(p, "L9", "failed", 0, "上游没数据")        # 新条目（没有 start_at）
    assert p.sessions_detail[0]["state"] == "failed"
    assert "ms" not in p.sessions_detail[0]
