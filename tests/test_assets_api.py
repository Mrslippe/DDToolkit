# -*- coding: utf-8 -*-
"""轻资产的**端点**判据（L2，devlog/260）。

服务层判据在 `tests/test_assets.py`（稳定键 / 落盘 / 合并 / prune 语义）。这里只判
"从 HTTP 走一遍是不是同一个语义"——三件事最容易在接线处走样：

| # | 判据 | 走样了会怎样 |
|---|---|---|
| ① | `POST /settings/assets/prune` 的 `dry_run` **默认真**，且它**一个字节都不删** | 界面上那句"将要清理 N 项"变成"已经删了"，用户没有反悔机会 |
| ② | dry-run 与实际删除**是同一个集合**（同参数下逐条相等） | 预览与实际不一致 ⇒ 用户按预览点了确认，删掉的却是别的东西 |
| ③ | `pin` 过的、被引用的（`vtubers.avatar` / 账本行）**route 这一层也删不掉** | 用户的头像在某次"清理"后破图（服务层有判据，接线处再钉一遍） |

⚠️ 为什么"接线处再钉一遍"不算重复：服务层的 `prune` 是纯函数式的，而端点这一层
多了 `db.commit()`、默认值填充、以及"报告里附带读数"三件事 —— 任何一件写错，
服务层那 14 条判据**照样全绿**。
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
from app.models.vtuber import Account, LocalAsset, VTuber
from app.services import assets

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-assets-api-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'assets_api.db').as_posix()}",
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


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """资产根指到 tmp（与 `tests/test_assets.py` 同款；conftest 另有一道全局守卫）。"""
    monkeypatch.setattr(assets, "data_root", lambda: tmp_path)
    return tmp_path


def _seed(db, *urls: str, size: int = 100):
    """造几份资产：`last_used_at` 递增（LRU 顺序确定）。"""
    from datetime import datetime, timedelta

    base = datetime(2026, 9, 29, 10, 0, 0)
    rows = []
    for i, url in enumerate(urls):
        row = assets.put(db, assets.KIND_AVATAR, url, b"x" * size, hint=f"w{i}")
        row.created_at = base + timedelta(minutes=i)
        row.last_used_at = base + timedelta(minutes=i)
        rows.append(row)
    db.commit()
    return rows


def _files(root: Path) -> list[Path]:
    p = root / "static" / "assets"
    return sorted(f for f in p.rglob("*") if f.is_file()) if p.exists() else []


# ── ① 读数 ─────────────────────────────────────────────────────────────

def test_assets_readout_shape_and_totals(db, client, data_dir):
    _seed(db, "https://x/0.jpg", "https://x/1.jpg")

    body = client.get("/settings/assets").json()
    assert {"kinds", "total", "img_cache"} <= set(body), "读数少键（界面按它画）"
    av = body["kinds"][assets.KIND_AVATAR]
    assert {"files", "bytes", "pinned", "missing", "oldest", "max_bytes", "rows"} <= set(av)
    assert av["files"] == 2 and av["bytes"] == 200
    assert av["max_bytes"] is None, "头像的默认上限就是'不限'（用户口径）"
    assert body["total"] == {"files": 2, "bytes": 200}
    assert "files" in body["img_cache"], "要和图片缓存并排显示（两套缓存的边界）"


# ── ②③ dry-run 与保护 ─────────────────────────────────────────────────

def test_prune_endpoint_defaults_to_dry_run_and_deletes_nothing(db, client, data_dir):
    """① `dry_run` 缺省 = 真（界面上"预览"是默认动作），且预览时一个字节都不删。"""
    _seed(db, "https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg")

    body = client.post("/settings/assets/prune", json={"max_bytes": 150}).json()

    assert body["dry_run"] is True, "缺省必须是 dry-run（UI 的第一次调用就是拿预览）"
    assert len(body["kinds"][assets.KIND_AVATAR]["evicted"]) >= 1, "这份参数下应当有淘汰候选"
    assert len(_files(data_dir)) == 3 and db.query(LocalAsset).count() == 3, "dry-run 删了东西"


def test_prune_endpoint_dry_run_matches_the_real_run(db, client, data_dir):
    """② 预览与实际**逐条相等**（否则用户按预览点确认，删的却是别的东西）。"""
    _seed(db, "https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg")

    dry = client.post("/settings/assets/prune", json={"max_bytes": 250}).json()
    real = client.post("/settings/assets/prune",
                       json={"max_bytes": 250, "dry_run": False}).json()

    assert (dry["dry_run"] is True) and (real["dry_run"] is False)
    assert ([c["key"] for c in dry["kinds"][assets.KIND_AVATAR]["evicted"]]
            == [c["key"] for c in real["kinds"][assets.KIND_AVATAR]["evicted"]])
    assert real["kinds"][assets.KIND_AVATAR]["freed_bytes"] == 200
    assert len(_files(data_dir)) == 2
    # 报告里顺带带最新读数 ⇒ 界面不必再打一次 GET
    assert real["assets"]["kinds"][assets.KIND_AVATAR]["files"] == 2
    # ⚠️ **另开一个会话**再数一次：`dry_run=false` 必须**真的落库**。
    #    只在本会话里断言的话，"端点忘了 commit"这种错**照样全绿**
    #    （flush 让删除对本会话可见、文件也已经 unlink 了）—— 反向验证抓出过这个洞。
    fresh = _Session()
    try:
        assert fresh.query(LocalAsset).count() == 2, "删除没落库（dry_run=false 却没提交）"
    finally:
        fresh.close()


def test_prune_endpoint_protects_pinned_and_referenced(db, client, data_dir):
    """③ pin 的 / 被 `vtubers.avatar` 引用的 —— route 这一层也不许删。"""
    rows = _seed(db, "https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg")

    v = VTuber(name="引用V", avatar="https://x/1.jpg")     # 用户显式选中
    db.add(v)
    db.flush()
    db.add(Account(vtuber_id=v.id, platform="weibo", platform_uid="w1",
                   avatar_url="https://x/2.jpg", followers_count=0))   # 账号现值
    db.commit()
    assert client.post("/settings/assets/pin",
                       json={"kind": "avatar", "url": "https://x/0.jpg"}).status_code == 200

    # 上限压到 0 = "把没受保护的全清掉"（设置页那个"清理未使用"就是这个语义）
    body = client.post("/settings/assets/prune",
                       json={"kind": "avatar", "max_bytes": 0, "dry_run": False}).json()
    left = {r.key for r in db.query(LocalAsset).all()}

    for url in ("https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg"):
        assert assets.key_of(url) in left, f"{url} 被清掉了（pin/引用保护没生效）"
    assert body["kinds"][assets.KIND_AVATAR]["evicted"] == []
    assert len(_files(data_dir)) == 3


def test_pin_endpoint_round_trip_and_404(db, client, data_dir):
    _seed(db, "https://x/0.jpg")
    before = client.get("/settings/assets").json()["kinds"][assets.KIND_AVATAR]["pinned"]
    assert before == 0

    on = client.post("/settings/assets/pin", json={"kind": "avatar", "url": "https://x/0.jpg"})
    assert on.status_code == 200 and on.json()["pinned"] is True
    assert on.json()["assets"]["kinds"][assets.KIND_AVATAR]["pinned"] == 1

    off = client.post("/settings/assets/pin",
                      json={"kind": "avatar", "url": "https://x/0.jpg", "on": False})
    assert off.json()["pinned"] is False
    assert off.json()["assets"]["kinds"][assets.KIND_AVATAR]["pinned"] == 0

    missing = client.post("/settings/assets/pin",
                          json={"kind": "avatar", "url": "https://x/never-seen.jpg"})
    assert missing.status_code == 404, "索引里没有它却报成功 ⇒ 界面会显示'已固定'而实际没有"


def test_prune_endpoint_rejects_unknown_kind(db, client, data_dir):
    """不认识的 kind 是 **422**（白名单在 schema 上）—— 静默忽略会让界面显示"清理完成"
    而实际一个 kind 都没扫到。"""
    _seed(db, "https://x/0.jpg")
    r = client.post("/settings/assets/prune", json={"kind": "whatever", "dry_run": False})
    assert r.status_code == 422, f"未知 kind 应当是 422，实际 {r.status_code}"
    assert db.query(LocalAsset).count() == 1 and len(_files(data_dir)) == 1, "422 之前动了数据"


def test_diagnostics_bundle_includes_light_assets(db, data_dir, monkeypatch):
    """诊断包里要有**按 kind 摊开**的轻资产读数（用户问"哪块在长"时要能一眼答）。

    ⚠️ `build_diagnostics()` 内部自己开 `SessionLocal`（生产里 = 数据目录的库）——
    判据里把它指到测试会话，否则读到的是仓库根那个库（`no such table`）。
    """
    _seed(db, "https://x/0.jpg", "https://x/1.jpg")
    import app.core.database as db_mod
    from app.services import diagnostics

    monkeypatch.setattr(db_mod, "SessionLocal", _Session)
    text = diagnostics.build_diagnostics()["text"]

    i = text.find("轻资产")
    assert i > 0, "诊断包里没有轻资产那一节"
    seg = text[i:i + 400]
    assert assets.KIND_AVATAR in seg, f"没有按 kind 摊开：{seg[:120]!r}"
    assert "2 份" in seg, f"文件数没进诊断包：{seg[:120]!r}"
