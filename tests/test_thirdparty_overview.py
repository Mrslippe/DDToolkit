# -*- coding: utf-8 -*-
"""「第三方数据」现状与手动补拉（2026-10-05，`devlog/354`）。

## 为什么这两条判据值得单独一个文件

用户原话：「当前如果历史第三方数据丢失了就没法获取了，例如恬豆发芽了 9.28-10.2 的直播记录」。
第三方数据（zeroroku 粉丝历史/礼物日、danmakus 直播场次）**只靠每日批次入库**，那条路会
失败（WAF 拦）或被清掉 —— 那时界面上既看不出缺了什么，也没有手动入口。所以这批加了两件事：

1. `GET /vtuber/{id}/thirdparty` —— 现状（条数 + 最新日期 + 两个源开没开）；
2. `POST /vtuber/{id}/thirdparty/refresh` 与 `POST /vtuber/batch/fetch-externals` —— 手动补拉。

钉住的四件事：
| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | 现状**按账号分别算**（不是整批一个数抄给每个账号）| "这个账号缺哪段"答不出来（第一版就是这个 bug）|
| ② | 第三方与**本工具直采**分开报 | 用户以为第三方有 1500 条，其中一大半是自己抓的 |
| ③ | 补拉**按白名单只打这个 V**、且带 `auto=False`（进度可见）| 为一条记录全量扫第三方站 / 点完没有任何反馈 |
| ④ | 已经有第三方任务在跑 ⇒ **409**（不去同时打第三方站）| 两个任务并行打同一个站，正是触发 WAF 的形状 |
"""
from __future__ import annotations

import asyncio
import atexit
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base, get_db
from app.main import app
from app.models.vtuber import Account, AccountStatSnapshot, LiveGiftDay, LiveSession, VTuber
from app.services.externals import overview as OV

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-thirdparty-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'tp.db').as_posix()}",
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
    yield
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


def _seed(db, *, second_account: bool = True) -> tuple[int, list[int]]:
    """一个 V + 两个 B 站账号，第三方三块数据**故意不对称**（考"按账号分别算"）。"""
    v = VTuber(name="恬豆发芽了")
    db.add(v)
    db.flush()
    a1 = Account(vtuber_id=v.id, platform="bilibili", platform_uid="1660392980",
                 display_name="恬豆发芽了")
    a2 = Account(vtuber_id=v.id, platform="bilibili", platform_uid="16548039",
                 display_name="普通小栗")
    db.add_all([a1, a2] if second_account else [a1])
    db.flush()
    # a1：第三方场次 3 场、礼物 2 天、第三方粉丝历史 5 条；本工具快照 2 条
    for i, day in enumerate(("2026-09-28", "2026-10-01", "2026-10-02")):
        db.add(LiveSession(account_id=a1.id, platform="bilibili", source="danmakus",
                           live_id=f"live-{i}", title=f"第 {i} 场",
                           start_at=datetime.fromisoformat(day + "T12:00:00")))
    for day in ("2026-10-01", "2026-10-02"):
        db.add(LiveGiftDay(account_id=a1.id, source="zeroroku", gift_date=day))
    for i in range(5):
        db.add(AccountStatSnapshot(account_id=a1.id, followers_count=1000 + i,
                                   source="zeroroku",
                                   captured_at=datetime(2026, 9, 20 + i, 10, 0)))
    for i in range(2):
        db.add(AccountStatSnapshot(account_id=a1.id, followers_count=2000 + i,
                                   source="self",
                                   captured_at=datetime(2026, 10, 3 + i, 10, 0)))
    # a2：**什么都没有**（现实里就是这样：副账号的第三方数据常常是零）
    db.commit()
    return v.id, [a1.id, a2.id]


def test_overview_counts_per_account_not_per_vtuber(db):
    """① 按账号分别算 + ② 第三方与直采分开报。

    ⚠️ 第一版实现是"整批聚合一次、每个账号都填同一份数字"，在真库上直接露馅
    （恬豆发芽了的两个账号给出完全相同的 2643 条）——这条用例就钉这一点。
    """
    vid, (a1, a2) = _seed(db)
    out = OV.overview(db, vid)
    rows = {r["account_id"]: r for r in out["thirdparty_accounts"]}
    assert set(rows) == {a1, a2}
    assert rows[a1]["live_sessions"] == {"rows": 3, "first_at": "2026-09-28T12:00:00",
                                        "last_at": "2026-10-02T12:00:00"}
    assert rows[a1]["gift_days"]["rows"] == 2
    assert rows[a1]["fan_history"]["rows"] == 5          # 第三方
    assert rows[a1]["fan_history_local"]["rows"] == 2    # 本工具直采（别混成一个数）
    # 第二个账号一条都没有 ⇒ 全是 0，而不是把 a1 的数字抄过来
    assert rows[a2]["live_sessions"]["rows"] == 0 and rows[a2]["gift_days"]["rows"] == 0
    assert rows[a2]["fan_history"]["rows"] == 0
    # 只算 bilibili：没有别的平台账号时这一条恒成立，但口径要写死在代码里（见 overview 文件头）
    assert all(r["platform_uid"] for r in out["thirdparty_accounts"])


def test_overview_route_shape_and_404(client, db):
    """端点契约：键集合逐字钉住（前端照它渲染，少一个键就是界面上一格空白）。"""
    vid, _ = _seed(db)
    r = client.get(f"/vtuber/{vid}/thirdparty")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"vtuber_id", "thirdparty_accounts", "sources", "running"}
    acc = body["thirdparty_accounts"][0]
    assert set(acc) == {"account_id", "platform_uid", "display_name", "fan_history",
                        "fan_history_local", "live_sessions", "live_sessions_feed", "gift_days"}
    for key in ("fan_history", "fan_history_local", "live_sessions", "live_sessions_feed",
                "gift_days"):
        assert set(acc[key]) == {"rows", "first_at", "last_at"}
    assert body["running"] is False
    assert client.get("/vtuber/999999/thirdparty").status_code == 404


def test_refresh_pulls_only_this_vtuber_and_is_visible(client, db, monkeypatch):
    """③ 按白名单只打这个 V、进度必须可见（`auto=False`）+ 完成报一条。"""
    from app.services import scheduler as sch

    vid, (a1, a2) = _seed(db)
    calls: list[dict] = []

    async def fake_run(interval, account_ids=None):
        calls.append({"interval": interval, "account_ids": account_ids,
                      "label": dict(sch._external_labels),
                      "auto": sch._status["external"]["auto"]})
        return [{"source": "danmakus", "kind": "live_sessions", "label": "直播场次同步",
                 "stored": 3, "skipped": 0, "error": None}]

    monkeypatch.setattr("app.services.externals.runner.run_external_interval", fake_run)
    r = client.post(f"/vtuber/{vid}/thirdparty/refresh")
    assert r.status_code == 200 and r.json()["accounts"] == [a1, a2]

    # BackgroundTasks 在 TestClient 里是**同步**跑完的 ⇒ 这里能直接断言调用参数
    assert calls and calls[0]["account_ids"] == [a1, a2], "只该打这个 V 的账号"
    assert calls[0]["interval"] == "daily"
    assert calls[0]["auto"] is False, "用户点的按钮 ⇒ 进度必须可见（auto=False）"
    assert any("第三方数据" in v for v in calls[0]["label"].values())
    # 收尾：运行态复位（否则按钮会一直显示"在跑"）
    assert sch._status["external"]["running"] is False


def test_refresh_rejects_when_already_running(client, db, monkeypatch):
    """④ 已有第三方任务在跑 ⇒ 409（不去同时打第三方站）。"""
    from app.services import scheduler as sch

    vid, _ = _seed(db)
    sch.external_task_started("manual:other", "别的第三方任务", auto=False)
    try:
        r = client.post(f"/vtuber/{vid}/thirdparty/refresh")
        assert r.status_code == 409 and "第三方" in r.json()["detail"]
        assert client.post("/vtuber/batch/fetch-externals").status_code == 409
    finally:
        sch.external_task_finished("manual:other")


def test_batch_endpoint_runs_all_accounts(client, monkeypatch):
    """全量入口：`account_ids=None`（与每日批次同口径）+ 完成回执进通知汇总。"""
    from app.services import notices as N
    from app.services import scheduler as sch

    seen: list = []

    async def fake_run(interval, account_ids=None):
        seen.append(account_ids)
        return [{"source": "zeroroku", "kind": "fan_history", "label": "粉丝历史回填/增量",
                 "stored": 7, "skipped": 1, "error": None},
                {"source": "danmakus", "kind": "live_sessions", "label": "直播场次同步",
                 "stored": 2, "skipped": 0, "error": "HTTP 302"}]

    monkeypatch.setattr("app.services.externals.runner.run_external_interval", fake_run)
    N.reset_state()
    r = client.post("/vtuber/batch/fetch-externals")
    assert r.status_code == 200 and r.json()["status"] == "started"
    assert seen == [None], "全量口径 = 不传白名单"
    assert sch._status["external"]["running"] is False
    # 完成回执：如实带新增条数，并点名有一项失败（不静默）
    texts = [item.get("text") or "" for item, _at in N._ring]
    assert any("第三方数据拉取完成" in t for t in texts), \
        f"完成回执没进通知汇总：{texts}"


def test_refresh_requires_a_bilibili_account(client, db):
    """没有 B 站账号 ⇒ 400 且说清为什么（不是静默什么都不做）。"""
    v = VTuber(name="只有微博的 V")
    db.add(v)
    db.flush()
    db.add(Account(vtuber_id=v.id, platform="weibo", platform_uid="6745922326"))
    db.commit()
    r = client.post(f"/vtuber/{v.id}/thirdparty/refresh")
    assert r.status_code == 400 and "bilibili" in r.json()["detail"]


def test_sources_state_follows_the_switch(monkeypatch):
    """两个源的开/关状态来自 runner 的同一份判定（界面据此说明为什么不能点）。"""
    from app.core.config import settings

    monkeypatch.setattr(settings, "EXTERNAL_ENABLED", False, raising=False)
    off = {s["name"]: s["enabled"] for s in OV.sources_state()}
    assert off.get("zeroroku") is False and off.get("danmakus") is False
    monkeypatch.setattr(settings, "EXTERNAL_ENABLED", True, raising=False)
    on = {s["name"]: s["enabled"] for s in OV.sources_state()}
    assert on.get("zeroroku") is True and on.get("danmakus") is True
    # 空壳源（laplace：没有 jobs）不该出现在界面里
    assert "laplace" not in on


def test_refresh_async_helper_reports_no_jobs(monkeypatch):
    """一个源都没跑（总开关关着）时，回执要说"没有可跑的任务"，不能说成"新增 0 条"。"""
    from app.routers import vtuber as R
    from app.services import notices as N
    from app.services import scheduler as sch

    async def empty(interval, account_ids=None):
        return []

    monkeypatch.setattr("app.services.externals.runner.run_external_interval", empty)
    N.reset_state()
    asyncio.run(R._refresh_thirdparty([1], "某个 V 的第三方数据", "manual:test"))
    assert sch._status["external"]["running"] is False
    texts = [item.get("text") or "" for item, _at in N._ring]
    assert any("没有可跑的任务" in t for t in texts), texts
