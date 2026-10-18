"""采集器用例（2026-10-18）。

**核心判据是"闭环"**：采集器写出来的东西，必须能被 `loader` 读进来、并且**通过 `checks` 的 C1**。
这条不通，整个工作台就是"能采不能用"—— 而且失败是静默的（每场都会被自己判 `dropped`）。

另外三条：
- `aggregate()` 的 `type0` / `sum_price` 必须**从原始记录现算**（不能取上游汇总）；
- `list_sessions_from_db()` 只认 uuid 形态的 `live_id`、按区间闭区间筛；
- 写盘顺序是**先 raw 后 stats**（stats 存在 ⇒ 这一场齐了），半途挂掉不会被当成完整场次。

⚠️ 采集**不走 HTTP 端点**：`start_collect` 用 `asyncio.create_task`，`TestClient` 每请求一个
portal、响应返回后循环就关，任务不会推进（实测会一直停在 running）。所以这里直调 `collect()`。
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

import pytest

from app.services.fan.checks import STATUS_DROPPED, check_identity, verdict
from app.services.fan.collector import (
    STATE_DONE,
    CollectProgress,
    SessionPlan,
    aggregate,
    collect,
    plan_range,
)
from app.services.fan.loader import load_window

SUB = "pilot_v3_mizuki"


# ── aggregate ──────────────────────────────────────────────────────────────
def _rec(t: int, uid: int, *, ms: int = 1_790_000_000_000, price: float | None = None,
         message: str | None = None, name: str = "某人") -> dict:
    rec: dict = {"type": t, "uId": uid, "uName": name, "sendDate": ms}
    if price is not None:
        rec["price"] = price
    if message is not None:
        rec["message"] = message
    return rec


def test_aggregate_counts_types_and_money() -> None:
    """`type0` / `sum_price` 必须与原始记录一致 —— 它们是 C1 恒等式的两端。"""
    recs = [
        _rec(0, 1), _rec(0, 1), _rec(0, 2),          # 3 条弹幕
        _rec(1, 1, price=10.0),                       # 礼物
        _rec(3, 2, price=30.0),                       # SC
        _rec(2, 3, price=138.0, message="舰长"),      # 上舰
        _rec(4, 1), _rec(4, 2),                       # 入场
        _rec(11, -1),                                 # 系统消息（uId=-1）
    ]
    raw, stats = aggregate(recs)

    assert stats["type0"] == 3
    assert stats["type4"] == 2
    assert stats["sum_price"] == pytest.approx(178.0)
    assert stats["records"] == len(recs)
    # 系统消息不建人；uId=-1 不能出现
    assert set(raw) == {"1", "2", "3"}

    assert raw["1"]["m"] == 2
    assert raw["1"]["p"] == pytest.approx(10.0)
    assert raw["1"]["sc_cnt"] == 0 and raw["1"]["gift_cnt"] == 1
    assert raw["2"]["sc_cnt"] == 1 and raw["2"]["sc"] == pytest.approx(30.0)
    assert raw["3"]["guard_top"] == "舰长" and raw["3"]["guard_cnt"] == 1


def test_aggregate_guard_top_keeps_highest() -> None:
    recs = [_rec(2, 9, price=138.0, message="舰长"),
            _rec(2, 9, price=1998.0, message="提督"),
            _rec(2, 9, price=138.0, message="舰长")]
    raw, _ = aggregate(recs)
    assert raw["9"]["guard_top"] == "提督"


def test_aggregate_empty_is_safe() -> None:
    raw, stats = aggregate([])
    assert raw == {} and stats["records"] == 0 and stats["type0"] == 0


# ── plan_range ─────────────────────────────────────────────────────────────
def test_plan_range_is_closed_interval() -> None:
    sessions = [SessionPlan("a", "2026-09-01 10:00:00"),
                SessionPlan("b", "2026-09-15 10:00:00"),
                SessionPlan("c", "2026-09-30 10:00:00")]
    got = [s.live_id for s in plan_range(sessions, "2026-09-15", "2026-09-30")]
    assert got == ["b", "c"], "两端都必须含（闭区间）"
    assert plan_range(sessions, "2026-10-01", "2026-10-31") == []


# ── list_sessions_from_db ─────────────────────────────────────────────────
def test_list_sessions_from_db_filters_and_requires_uuid(tmp_path: Path) -> None:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    from app.models.vtuber import Account, LiveSession, VTuber
    from app.services.fan.collector import list_sessions_from_db

    engine = create_engine(f"sqlite:///{(tmp_path / 'db.sqlite').as_posix()}",
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    S = sessionmaker(bind=engine)
    db = S()
    try:
        v = VTuber(name="测试V")
        db.add(v)
        db.flush()
        a = Account(vtuber_id=v.id, platform="bilibili", platform_uid="123")
        db.add(a)
        db.flush()
        db.add(LiveSession(account_id=a.id, live_id="00491249-aaaa-bbbb-cccc-ddddeeeeffff",
                           start_at=datetime(2026, 9, 15, 20, 0)))
        db.add(LiveSession(account_id=a.id, live_id="11111111-2222-3333-4444-555566667777",
                           start_at=datetime(2026, 10, 1, 20, 0)))
        db.add(LiveSession(account_id=a.id, live_id="short-id-not-uuid",
                           start_at=datetime(2026, 9, 20, 20, 0)))
        db.commit()
        v_ref = __import__("app.services.fan.loader", fromlist=["VtuberRef"]).VtuberRef(
            "测试V", SUB, "123", "测试")
        got = list_sessions_from_db(db, v_ref, "2026-09-01", "2026-09-30")
        assert [s.live_id for s in got] == ["00491249-aaaa-bbbb-cccc-ddddeeeeffff"], \
            "非 uuid 形态要被过滤掉"
        assert plan_range(got, "2026-10-01", "2026-10-31") == [], "区间外的不该进来"
    finally:
        db.close()


# ── 闭环：采集器写的东西，loader 能读、且过 C1 ─────────────────────────────
def test_collected_files_pass_loader_and_c1(tmp_path: Path,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    """★ 最重要的一条：`collect()` 落盘 → `load_window()` 读回 → C1 不判 dropped。"""
    from app.services.fan import collector as col

    recs = [_rec(0, 1, ms=1_790_000_000_000), _rec(0, 2, ms=1_790_000_001_000),
            _rec(3, 2, price=30.0, ms=1_790_000_002_000),
            _rec(4, 1, ms=1_790_000_003_000), _rec(4, 2, ms=1_790_000_004_000)]
    # 造 120 条弹幕，跨过 MIN_RECORDS=100
    recs += [_rec(0, 1, ms=1_790_000_100_000 + i) for i in range(120)]

    async def fake_get(client, path, params, **kw):
        if path == "/api/v2/live":
            return {"data": {"data": {"danmakus": recs}}}
        return None

    monkeypatch.setattr(col, "_get_json", fake_get)

    root = tmp_path / "data"
    v = __import__("app.services.fan.loader", fromlist=["VtuberRef"]).VtuberRef(
        "测试V", SUB, "123", "测试")
    prog = CollectProgress("测试V", "2026-09-01", "2026-09-30")
    got = asyncio.run(collect(v, "2026-09-01", "2026-09-30", root=root, progress=prog,
                              sessions=[SessionPlan("aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                                                    "2026-09-15 20:00:00")]))

    assert got.state == STATE_DONE and got.done == 1

    # 写盘顺序：raw 与 stats 都在
    assert (root / SUB / "raw" / "aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json").is_file()
    assert (root / SUB / "stats" / "aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json").is_file()

    # loader 能读，且 C1 不判 dropped
    win = load_window(v, 10, root=root)
    assert win.n == 1
    assert win.users["1"].m == 121
    problems = check_identity(win.sessions[0])
    assert problems == [], f"C1 不该红：{problems}"
    assert verdict(win.sessions[0]).status != STATUS_DROPPED


def test_collect_skips_already_collected(tmp_path: Path,
                                              monkeypatch: pytest.MonkeyPatch) -> None:
    """已有 stats 且 raw 都在 ⇒ 跳过，不重复下载。"""
    from app.services.fan import collector as col

    calls = {"n": 0}

    async def fake_get(client, path, params, **kw):
        calls["n"] += 1
        return {"data": {"data": {"danmakus": [_rec(0, 1)] * 200}}}

    monkeypatch.setattr(col, "_get_json", fake_get)
    root = tmp_path / "data"
    v = __import__("app.services.fan.loader", fromlist=["VtuberRef"]).VtuberRef(
        "测试V", SUB, "123", "测试")
    sessions = [SessionPlan("aaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-09-15 20:00:00")]

    asyncio.run(collect(v, "2026-09-01", "2026-09-30", root=root,
                        progress=CollectProgress("V", "a", "b"), sessions=sessions))
    first = calls["n"]
    prog2 = CollectProgress("V", "a", "b")
    asyncio.run(collect(v, "2026-09-01", "2026-09-30", root=root, progress=prog2, sessions=sessions))

    assert prog2.skipped == 1
    assert calls["n"] == first, "第二次不该再下载"


def test_collect_fails_fast_when_no_sessions(tmp_path: Path) -> None:
    v = __import__("app.services.fan.loader", fromlist=["VtuberRef"]).VtuberRef(
        "测试V", SUB, "123", "测试")
    prog = asyncio.run(collect(v, "2026-09-01", "2026-09-30", root=tmp_path / "d",
                               sessions=[]))
    assert prog.state == "failed"
    assert "没有场次" in prog.message
