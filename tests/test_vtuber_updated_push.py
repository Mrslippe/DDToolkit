# -*- coding: utf-8 -*-
"""V 本体改推送（M3b，devlog/248；方案 §M3 的第三刀 / 风险最高的一条）。

## 为什么这条风险最高

它碰的是 **R33 那条事故路径**：`frontend/src/utils/appEvents.ts` 的开头写着
「右栏改了签名要通知左栏（**R33 那条"改了左栏没同步"的事故**）」。今天这条同步靠前端
**存完之后自己** `emit(vtuberUpdated)` —— 只有"发起那个窗口"知道；改由后端广播之后，
所有订阅者（前端各窗口；2026-10-01 前还含桌面小窗，小窗已整窗退役，见 `devlog/270`）都能收到，
**消费侧一行不动**。

## 判据

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | `PUT /vtuber/{id}` ⇒ 一条 `domain.vtuber.updated`，载荷 = **接口返回值同一份** | 左栏 / 其它订阅者看不到 |
| ② | 载荷必须**能过 JSON**（库里是 naive datetime） | SSE 帧 `json.dumps` 直接抛 ⇒ **整条流断** |
| ③ | V 不存在 ⇒ 404 且**不发** | 推一条"幽灵 V"给所有订阅者 |
| ④ | 改的是**账号**而不是 V ⇒ 这条**不发**（那是 `domain.account.snapshot` 的活） | 两条通道互相刷 |

⚠️ R33 的**既有不变量**不在本文件里（它们在前端与 `tests/test_vtuber_api.py`）——
本批的纪律是：动同步链前后各跑一次那两组，绿才继续。
"""
from __future__ import annotations

import atexit
import json
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

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-vupd-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'vupd.db').as_posix()}",
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
    import app.routers.vtuber as R

    monkeypatch.setattr(R, "_adopt_background", lambda *a, **k: None, raising=False)
    return TestClient(app)


def _mk_v(db, name="本体V") -> VTuber:
    v = VTuber(name=name)
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _updates(hub) -> list[M.Message]:
    return [m for m in hub.replay_since(0) if m.type == M.MSG_VTUBER_UPDATED]


# ── ① 改 V ⇒ 一条消息，载荷与接口返回值同一份 ─────────────────────────────

def test_update_vtuber_publishes_the_api_payload(db, client, _fresh_hub):
    v = _mk_v(db)
    resp = client.put(f"/vtuber/{v.id}", json={"sign_override": "新签名", "faction": "新阵营"})
    assert resp.status_code == 200
    body = resp.json()

    got = _updates(_fresh_hub)
    assert len(got) == 1, f"改一次 V 应当恰好一条，实际 {len(got)}"
    assert got[0].payload == body, "推送的必须与接口返回**同一份**（消费侧两边用同一套类型）"
    assert got[0].payload["sign_override"] == "新签名"
    assert got[0].payload["faction"] == "新阵营"
    assert got[0].payload["id"] == v.id and got[0].payload["name"] == "本体V"


def test_payload_survives_json_dumps(db, client, _fresh_hub):
    """② 载荷必须能过 JSON：库里是 naive datetime，SSE 帧要 `json.dumps`。

    忘了 `model_dump(mode="json")` 的症状特别难看 —— **不是这一条消息失败，而是
    `stream_events` 里 `json.dumps` 抛异常 ⇒ 整条推送流断掉**（所有窗口一起失聪）。
    """
    v = _mk_v(db)
    client.put(f"/vtuber/{v.id}", json={"notes": "备注"})
    payload = _updates(_fresh_hub)[0].payload

    text = json.dumps(payload, ensure_ascii=False)          # 不抛 = 过
    assert "本体V" in text
    # 时间字段应当是**字符串**（ISO），不是 datetime 对象
    for k in ("created_at", "updated_at", "birthday", "debut_date"):
        if k in payload and payload[k] is not None:
            assert isinstance(payload[k], str), f"{k} 不是字符串：{type(payload[k])}"


# ── ③④ 不该发的情形 ─────────────────────────────────────────────────────

def test_missing_vtuber_publishes_nothing(client, _fresh_hub):
    assert client.put("/vtuber/99999", json={"name": "不存在"}).status_code == 404
    assert _fresh_hub.replay_since(0) == [], "404 不许推一条幽灵 V"


def test_account_only_change_does_not_publish_a_vtuber_message(db, client, _fresh_hub):
    """④ 改账号 ≠ 改 V：这条通道不该被账号流刷屏（那是 `domain.account.snapshot` 的活）。"""
    from app.services import scheduler as sch

    v = _mk_v(db)
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="11073",
                  display_name="账号名", followers_count=1)
    db.add(acc)
    db.commit()

    sch._push_account_snapshot(acc)

    assert _updates(_fresh_hub) == []
    assert [m.type for m in _fresh_hub.replay_since(0)] == [M.MSG_ACCOUNT_SNAPSHOT]
