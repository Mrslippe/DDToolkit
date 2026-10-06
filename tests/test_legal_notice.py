# -*- coding: utf-8 -*-
"""用户协议闸门（2026-10-06，`devlog/369`；口径在 `devlog/372` 改成"声明版本"）。

用户口径：「第一次启动应用或者更新至这个版本时，都要阅读一个用户协议或者公告……
阅读完同意才可以关闭窗口」，并在 2026-10-06 第二次拍板：

> 「**不要每次版本更新都让用户确认一次**，如果用户协议没有更新那么就不用让用户确认了。
>  我希望的效果是在这次推送的版本更新中**所有用户都需要确认**（因为之前并没有用户协议），
>  而这次之后则**只有首次使用这个应用的用户**需要确认。」

这里钉的就是这套口径（前端只是照着 `needed` 挡界面）：

| # | 判据 | 不这么做会怎样 |
|---|---|---|
| ① | 没同意过 ⇒ `needed=true`（= 本次发版**所有老用户**都会看到） | 首次启动/本次升级不弹闸门 |
| ② | 同意当前**声明版本** ⇒ `needed=false` + 记下时刻，且**幂等** | 每次启动都弹 |
| ③ | **应用版本变了也`needed=false`** | 变成"每次版本更新都确认一次"（用户明确不要） |
| ④ | **声明版本变了才 `needed=true`** | 正文改了却不再要求确认 |
| ⑤ | 拿**别的版本号**来同意 ⇒ 400 且**不改状态** | 前端传空串/旧版本就能把闸门绕过去 |
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
    """① 从没同意过 ⇒ 要弹；`required` 是**声明自己的版本**（不是应用版本）。"""
    r = client.get("/settings/agreement")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["required"] == legal_notice.NOTICE_VERSION
    assert body["required"] != settings.VERSION, \
        "required 又变回应用版本了 ⇒ 每次发版都会骚扰老用户"
    assert body["app_version"] == settings.VERSION, "界面要显示应用版本，得单独给一个字段"
    assert body["accepted"] is None and body["accepted_at"] is None
    assert body["needed"] is True, "还没同意过却不弹闸门"


def test_agree_then_no_longer_needed_and_is_idempotent(client):
    """② 同意 ⇒ 放行 + 记时刻；再问一次仍是 false（幂等）。"""
    ok = client.post("/settings/agreement", json={"version": legal_notice.NOTICE_VERSION})
    assert ok.status_code == 200, ok.text
    assert ok.json()["needed"] is False
    assert ok.json()["accepted"] == legal_notice.NOTICE_VERSION
    assert ok.json()["accepted_at"], "没记同意时刻 —— 留痕就没了"

    again = client.get("/settings/agreement")
    assert again.json()["needed"] is False
    twice = client.post("/settings/agreement", json={"version": legal_notice.NOTICE_VERSION})
    assert twice.status_code == 200 and twice.json()["needed"] is False


def test_app_version_bump_does_not_ask_again(monkeypatch, client):
    """③ **应用版本变了不再要求确认**（用户 2026-10-06 明确："不要每次版本更新都确认一次"）。"""
    client.post("/settings/agreement", json={"version": legal_notice.NOTICE_VERSION})
    monkeypatch.setattr(settings, "VERSION", "9.9.9")
    body = client.get("/settings/agreement").json()
    assert body["app_version"] == "9.9.9", "应用版本要如实反映"
    assert body["needed"] is False, "应用版本一变又弹 ⇒ 正是用户点名不要的那种行为"
    assert body["required"] == legal_notice.NOTICE_VERSION


def test_notice_version_bump_asks_again(monkeypatch, client):
    """④ **声明正文改了（`NOTICE_VERSION` 提高）才再要求确认**，旧记录留着当账。"""
    client.post("/settings/agreement", json={"version": legal_notice.NOTICE_VERSION})
    monkeypatch.setattr(legal_notice, "NOTICE_VERSION", "2099-01-01")
    body = client.get("/settings/agreement").json()
    assert body["required"] == "2099-01-01"
    assert body["needed"] is True, "正文改了却没再要求确认"
    assert body["accepted"], "旧记录不该被抹掉（它是「同意过哪一版」的账）"

    after = client.post("/settings/agreement", json={"version": "2099-01-01"})
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

    legal_notice.accept(db, legal_notice.NOTICE_VERSION)
    repo = AppMetaRepo(db)
    assert repo.get(legal_notice.ACCEPTED_KEY) == legal_notice.NOTICE_VERSION
    assert repo.get(legal_notice.ACCEPTED_AT_KEY)


def test_notice_version_looks_like_a_date_and_is_documented():
    """`NOTICE_VERSION` 用日期当版本（人要能一眼看出新旧），且**代码里不重复写死**。

    ⚠️ 这条守的是"改正文忘了提版本"：正文在前端组件里，版本在后端常量里 ——
    如果哪天有人把版本号也写进前端**代码**（两处真源），这条就会红。
    （注释里出现日期是允许的：那是在记"哪一天定的"，不是第二份真源 ⇒ 先把注释剥掉再查。）
    """
    import re
    from pathlib import Path

    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", legal_notice.NOTICE_VERSION), \
        "声明版本用生效日期（YYYY-MM-DD）——一眼能看出新旧"
    tsx = (Path(__file__).resolve().parent.parent / "frontend" / "src" / "components"
           / "LegalNotice.tsx").read_text(encoding="utf-8")
    code = re.sub(r"/\*.*?\*/", "", tsx, flags=re.S)      # 块注释
    code = re.sub(r"^\s*//.*$", "", code, flags=re.M)     # 行注释
    assert legal_notice.NOTICE_VERSION not in code, \
        ("声明版本只该在后端这一处（`legal_notice.NOTICE_VERSION`）——"
         "前端要显示就从 `/settings/agreement` 读 `required`；两处写死迟早对不上")
