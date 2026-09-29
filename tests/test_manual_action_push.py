# -*- coding: utf-8 -*-
"""手动动作走推送（M2，devlog/244；方案 `docs/design/notices/message-hub-execution.md` §M2）。

## 这一批解决什么

用户点按钮到"顶栏出现「…抓取中」"原本要等下一次 `fetch-status` 轮询
（`TopBar` 3s 忙 / 10s 闲）—— `kickPoll` 那个补丁就是为这段等待打的。现在：

- **任务受理** ⇒ 推一条 `notice.progress`（点按钮的人**立刻**看到，不等轮询）；
- **任务完成** ⇒ 推一条 `notice.message`，带 `originator`（谁点的）：
  **发起方自己的窗口不重复提示**（它已经从响应里拿到结果并弹了胶囊）。

## 判据（方案 §M2 三条 + 本批补的两条）

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | `POST /vtuber/{id}/fetch` ⇒ **受理即产生** `notice.progress` | 又要等 3–10s（这批白做） |
| ② | `X-DDToolkit-Host` 原样进 payload 的 `originator` | 自家回环，重复提示 |
| ③ | 完成 ⇒ 一条 `notice.message`（文案带计数） | 别的窗口永远不知道做完了 |
| ④ | 没带宿主头 ⇒ `originator` 是空串（**不等于任何宿主**） | "不知道谁点的"被当成自己点的 ⇒ 静默丢提示 |
| ⑤ | `skipped`（已有任务在跑）**不发**受理消息 | 顶栏亮起一条根本没跑的进度 |

⚠️ 用例把 `async_fetch_vtuber` / `async_update_unarchived_posts` 换成替身（不打上游），
但**走真端点、真依赖注入、真 hub**：`originator` 那条链（请求头 → 依赖 → payload）正是判据本体。
"""
from __future__ import annotations

import atexit
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base, get_db
from app.main import app
from app.models.vtuber import Account, VTuber
from app.services import messages as M

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-manual-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'manual.db').as_posix()}",
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


@pytest.fixture(autouse=True)
def _fresh_hub(monkeypatch):
    hub = M.MessageHub()
    monkeypatch.setattr(M, "HUB", hub)
    return hub


@pytest.fixture
def client(monkeypatch):
    """端点级客户端。**不用 `with TestClient(...)`**：那会跑 lifespan（起真调度器 + 迁移）。"""
    import app.routers.vtuber as R

    async def _fake_fetch_vtuber(_vid: int):
        return type("R", (), {"success": 1, "failed": 0, "skipped": 0, "details": []})()

    async def _fake_update(_name):
        return {"status": "done", "total": {"stored": 3, "skipped": 1}, "details": []}

    monkeypatch.setattr(R, "async_fetch_vtuber", _fake_fetch_vtuber, raising=False)
    monkeypatch.setattr(R, "async_update_unarchived_posts", _fake_update, raising=False)
    monkeypatch.setattr(R, "manual_task_running", lambda: False)
    # 内容闸门（未登录 → 403）不是本文件的判据对象：这里只验"受理/完成各自推什么"
    monkeypatch.setattr(R, "_require_content_fetch", lambda *a, **k: None, raising=False)
    return TestClient(app)


def _mk_v(db, name="手动V") -> VTuber:
    v = VTuber(name=name)
    db.add(v)
    db.commit()
    db.refresh(v)
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="11073",
                   display_name=name, followers_count=1))
    db.commit()
    return v


def _of_type(hub, type_: str) -> list[M.Message]:
    return [m for m in hub.replay_since(0) if m.type == type_]


# ── ① 受理即推送（不等轮询）──────────────────────────────────────────────

def test_single_vtuber_fetch_publishes_progress_immediately(db, client, _fresh_hub):
    v = _mk_v(db)
    r = client.post(f"/vtuber/{v.id}/fetch", headers={M.HOST_HEADER: "main"})
    assert r.status_code == 200 and r.json()["status"] == "done"

    got = _of_type(_fresh_hub, M.MSG_NOTICE_PROGRESS)
    assert len(got) == 1, f"受理时应当**立刻**推一条进度，实际 {len(got)}"
    p = got[0].payload
    assert p["task"] == "account"
    assert "账号信息抓取中" in p["text"] and v.name in p["text"], p["text"]


def test_completion_publishes_a_message_with_counts(db, client, _fresh_hub):
    """③ 完成 ⇒ 一条 `notice.message`，文案带计数（别的窗口据此播报）。"""
    v = _mk_v(db)
    client.post(f"/vtuber/{v.id}/fetch", headers={M.HOST_HEADER: "widget"})

    done = _of_type(_fresh_hub, M.MSG_NOTICE_MESSAGE)
    assert len(done) == 1
    assert "账号信息更新完成" in done[0].payload["text"]
    assert "成功 1" in done[0].payload["text"]


# ── ② 宿主标识原样带回 ───────────────────────────────────────────────────

def test_originator_comes_from_the_request_header(db, client, _fresh_hub):
    v = _mk_v(db)
    client.post(f"/vtuber/{v.id}/fetch", headers={M.HOST_HEADER: "widget"})
    msgs = _of_type(_fresh_hub, M.MSG_NOTICE_PROGRESS) + _of_type(_fresh_hub, M.MSG_NOTICE_MESSAGE)
    assert msgs and all(m.payload.get("originator") == "widget" for m in msgs), \
        [(m.type, m.payload.get("originator")) for m in msgs]


def test_originator_is_empty_without_the_header(db, client, _fresh_hub):
    """④ 没带宿主头 ⇒ 空串（**不等于任何宿主** ⇒ 消息照常播给所有人）。

    反向验证：把这里的 `""` 改成 `myHost()` 那种"默认算自己"的写法 ⇒ 前端那条
    `shouldToast` 用例会红（本仓的默认必须是"不知道谁点的 → 播"，不是"静默"）。
    """
    v = _mk_v(db)
    client.post(f"/vtuber/{v.id}/fetch")
    assert _of_type(_fresh_hub, M.MSG_NOTICE_PROGRESS)[0].payload["originator"] == ""


def test_update_endpoint_publishes_start_and_done(db, client, _fresh_hub):
    """第三个动作（动态更新）同样有受理与完成两条 —— 前端的三个按钮都覆盖到。"""
    client.post("/vtuber/update-posts?name=手动V", headers={M.HOST_HEADER: "main"})
    assert len(_of_type(_fresh_hub, M.MSG_NOTICE_PROGRESS)) == 1
    done = _of_type(_fresh_hub, M.MSG_NOTICE_MESSAGE)
    assert len(done) == 1 and "动态更新完成" in done[0].payload["text"]
    assert "新增 3" in done[0].payload["text"]


def test_adopt_reports_first_screen_completion(db, monkeypatch, _fresh_hub):
    """收录/加账号的首屏抓取完成**也要报**（M5-2b，devlog/259）。

    为什么必须有这条：这条反馈原先住在 `TopBar` 的 `post.last_result` 分支里
    （v0.9.4 的「新 V 首屏抓取完成 · 投稿 N · 动态 M · 入库 K」），而 M5-2b 把汇总交给
    后端之后那个分支就删了 —— 不在后端补上，收录完就**没有任何反馈**（v0.9.4 那条需求
    会静默回退）。⚠️ `originator=""`：发起方自己也要看到（旧行为就是本地弹胶囊）。
    """
    import asyncio

    import app.routers.vtuber as R

    async def _fake_accounts(ids, label=""):
        return None

    async def _fake_first_screen(_aid):
        return type("P", (), {"videos": 7, "dynamics": 3, "stored": 9, "skipped": 1})()

    monkeypatch.setattr(R, "async_fetch_accounts", _fake_accounts, raising=False)
    monkeypatch.setattr(R, "async_fetch_first_screen", _fake_first_screen, raising=False)
    monkeypatch.setattr(R, "_spawn_background", lambda coro: coro.close(), raising=False)

    asyncio.run(R._adopt_background(vtuber_id=1, account_id=2))

    done = _of_type(_fresh_hub, M.MSG_NOTICE_MESSAGE)
    assert len(done) == 1, f"首屏抓取完成没有报出来，实际 {len(done)} 条"
    text = done[0].payload["text"]
    assert "首屏抓取完成" in text and "投稿 7" in text and "动态 3" in text and "入库 9" in text, text
    assert done[0].payload.get("originator") == "", (
        "发起方自己也要看到这条 —— originator 必须是空串（不等于任何宿主）")


def test_adopt_reports_nothing_when_first_screen_fails(db, monkeypatch, _fresh_hub):
    """首屏那条抛异常时**不许**报"完成 0/0/0"（假报比不报更糟）。"""
    import asyncio

    import app.routers.vtuber as R

    async def _fake_accounts(ids, label=""):
        return None

    async def _boom(_aid):
        raise RuntimeError("上游挂了")

    async def _ok(_aid):
        return type("P", (), {"videos": 0, "dynamics": 0, "stored": 0, "skipped": 0})()

    monkeypatch.setattr(R, "async_fetch_accounts", _fake_accounts, raising=False)
    monkeypatch.setattr(R, "async_fetch_first_screen", _boom, raising=False)
    monkeypatch.setattr(R, "_spawn_background", lambda coro: coro.close(), raising=False)
    asyncio.run(R._adopt_background(vtuber_id=1, account_id=2))
    assert _of_type(_fresh_hub, M.MSG_NOTICE_MESSAGE) == [], "异常被 return_exceptions 吞了，不该报完成"

    # 正对照：换成正常返回 ⇒ 又有那条消息（证明上一条不是"永远不报"）
    monkeypatch.setattr(R, "async_fetch_first_screen", _ok, raising=False)
    asyncio.run(R._adopt_background(vtuber_id=1, account_id=2))
    assert len(_of_type(_fresh_hub, M.MSG_NOTICE_MESSAGE)) == 1


# ── ⑤ 被拒绝的任务不许发受理消息 ─────────────────────────────────────────

def test_skipped_task_publishes_nothing(db, client, monkeypatch, _fresh_hub):
    import app.routers.vtuber as R
    monkeypatch.setattr(R, "manual_task_running", lambda: True)
    v = _mk_v(db)
    r = client.post(f"/vtuber/{v.id}/fetch", headers={M.HOST_HEADER: "main"})
    assert r.json()["status"] == "skipped"
    assert _fresh_hub.replay_since(0) == [], "被拒绝的任务不该在顶栏亮起一条进度"
