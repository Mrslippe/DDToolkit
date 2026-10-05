# -*- coding: utf-8 -*-
"""用户协议闸门（2026-10-06，`devlog/369`）。

用户口径：「第一次启动应用或者**更新至这个版本**时，都要阅读一个用户协议或者公告……
**阅读完同意才可以关闭窗口**」。这里钉的是判定那一层（前端只是照着 `needed` 挡界面）：

| # | 判据 | 不这么做会怎样 |
|---|---|---|
| ① | 没同意过 ⇒ `needed=true`，`required` = 应用版本 | 首次启动不弹闸门 |
| ② | 同意当前版本 ⇒ `needed=false` + 记下时刻，且**幂等** | 每次启动都弹（用户被烦到关掉它） |
| ③ | **版本一变又变成 `needed=true`**（旧记录留着） | "更新至这个版本时也要读"这条落空 |
| ④ | 拿**别的版本号**来同意 ⇒ 400 且**不改状态** | 前端传空串/旧版本就能把闸门绕过去 |
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.database import Base, get_db
from app.main import app
from app.services import legal_notice


@pytest.fixture
def db():
    # ⚠️ 必须 StaticPool：内存 SQLite 是"每连接一份"，而 TestClient 把同步端点丢到工作线程里跑
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture
def client(db):
    prev = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: db
    # ⚠️ **不要用 `with TestClient(...)`**：那会跑应用的 lifespan（起后台任务），
    #    而外部数据任务的状态是**进程级**的 ⇒ 泄漏到后面所有用例（实测：本文件一加进来，
    #    `test_services.py` / `test_thirdparty_overview.py` 的 8 条当场变 409）。
    #    仓里的惯例就是 `yield TestClient(app)`（见 `test_runtime_settings.py`）。
    yield TestClient(app, client=("127.0.0.1", 51234))
    if prev is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev


def test_first_run_needs_agreement(client):
    """① 从没同意过 ⇒ 要弹，且"要同意的版本"就是应用版本（单一真源）。"""
    r = client.get("/settings/agreement")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["required"] == settings.VERSION
    assert body["accepted"] is None and body["accepted_at"] is None
    assert body["needed"] is True, "首次启动不弹闸门"


def test_agree_then_no_longer_needed_and_is_idempotent(client):
    """② 同意 ⇒ 放行 + 记时刻；再问一次仍是 false（幂等，不会每次启动都弹）。"""
    ok = client.post("/settings/agreement", json={"version": settings.VERSION})
    assert ok.status_code == 200, ok.text
    assert ok.json()["needed"] is False
    assert ok.json()["accepted"] == settings.VERSION
    assert ok.json()["accepted_at"], "没记同意时刻 —— 留痕就没了"

    again = client.get("/settings/agreement")
    assert again.json()["needed"] is False
    # 幂等：再同意一次不报错、时刻被刷新
    twice = client.post("/settings/agreement", json={"version": settings.VERSION})
    assert twice.status_code == 200 and twice.json()["needed"] is False


def test_version_bump_asks_again(monkeypatch, client):
    """③ 换版本 ⇒ 再弹一次（"或者更新至这个版本时"）；旧记录留着，不当成没同意过。"""
    client.post("/settings/agreement", json={"version": settings.VERSION})
    monkeypatch.setattr(settings, "VERSION", "9.9.9")
    body = client.get("/settings/agreement").json()
    assert body["required"] == "9.9.9"
    assert body["needed"] is True, "换版本却没再要求同意"
    assert body["accepted"], "旧记录不该被抹掉（它是「同意过哪一版」的账）"

    # 拿新版本同意 ⇒ 放行
    after = client.post("/settings/agreement", json={"version": "9.9.9"})
    assert after.status_code == 200 and after.json()["needed"] is False


def test_other_version_is_rejected_and_changes_nothing(client):
    """④ 版本号对不上 ⇒ 400 且**不改状态**（否则传个空串就能绕过闸门）。"""
    bad = client.post("/settings/agreement", json={"version": "0.0.1"})
    assert bad.status_code == 400, bad.text
    assert "0.0.1" in bad.json()["detail"]
    assert client.get("/settings/agreement").json()["needed"] is True, "被绕过去了"

    empty = client.post("/settings/agreement", json={"version": " "})
    assert empty.status_code in (400, 422), empty.text
    assert client.get("/settings/agreement").json()["needed"] is True


def test_state_reads_meta_keys(db):
    """状态真的落在 `app_meta` 里（跟着数据目录与迁移走，不是进程内变量）。"""
    from app.repositories.vtuber_repo import AppMetaRepo

    legal_notice.accept(db, settings.VERSION)
    repo = AppMetaRepo(db)
    assert repo.get(legal_notice.ACCEPTED_KEY) == settings.VERSION
    assert repo.get(legal_notice.ACCEPTED_AT_KEY)
