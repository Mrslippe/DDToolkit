import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# 独立测试库，避免污染开发数据库
test_engine = create_engine("sqlite:///./test_vtuber.db", connect_args={"check_same_thread": False})
TestingSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

from app.main import app
from app.core.database import Base, get_db
from app.models.vtuber import VTuber, Account, Post


def override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    db = TestingSession()
    try:
        for t in (Post, Account, VTuber):
            db.query(t).delete()
        db.commit()
    finally:
        db.close()
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def client():
    return TestClient(app)


# ── VTuber ─────────────────────────────────────────────────────────

def test_create_vtuber(client):
    resp = client.post("/vtuber", json={"name": "测试主播", "birthday": "01-01"})
    assert resp.status_code == 201
    assert resp.json()["name"] == "测试主播"


def test_list_vtubers(client):
    client.post("/vtuber", json={"name": "A"})
    client.post("/vtuber", json={"name": "B"})
    assert len(client.get("/vtuber/list").json()) == 2


def test_get_vtuber(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    assert client.get(f"/vtuber/{vid}").json()["name"] == "测试"


def test_update_vtuber(client):
    vid = client.post("/vtuber", json={"name": "旧"}).json()["id"]
    assert client.put(f"/vtuber/{vid}", json={"name": "新"}).json()["name"] == "新"


def test_delete_vtuber(client):
    vid = client.post("/vtuber", json={"name": "待删除"}).json()["id"]
    assert client.delete(f"/vtuber/{vid}").status_code == 204
    assert client.get(f"/vtuber/{vid}").status_code == 404


# ── Account ─────────────────────────────────────────────────────────

def test_add_account(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    resp = client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "123"})
    assert resp.status_code == 201
    assert resp.json()["platform_uid"] == "123"


def test_list_accounts(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "111"})
    client.post(f"/vtuber/{vid}/accounts", json={"platform": "youtube", "platform_uid": "222"})
    assert len(client.get(f"/vtuber/{vid}/accounts").json()) == 2


def test_update_account(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "123"}).json()["id"]
    assert client.put(f"/account/{aid}", json={"display_name": "新昵称"}).json()["display_name"] == "新昵称"


def test_delete_account(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "123"}).json()["id"]
    assert client.delete(f"/account/{aid}").status_code == 204


# ── Post ────────────────────────────────────────────────────────────

def test_add_post(client):
    resp = client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "123", "platform_post_id": "BV123",
        "type": "video", "title": "新视频",
    })
    assert resp.status_code == 201
    assert resp.json()["platform"] == "bilibili"


def test_list_posts(client):
    client.post("/posts", json={"platform": "bilibili", "platform_uid": "U1", "platform_post_id": "p1", "type": "text"})
    client.post("/posts", json={"platform": "bilibili", "platform_uid": "U1", "platform_post_id": "p2", "type": "video"})
    client.post("/posts", json={"platform": "bilibili", "platform_uid": "U2", "platform_post_id": "p3", "type": "text"})
    assert len(client.get("/posts/bilibili/U1").json()) == 2


# ── Error cases ─────────────────────────────────────────────────────

def test_get_nonexistent_vtuber(client):
    assert client.get("/vtuber/99999").status_code == 404


def test_delete_nonexistent_vtuber(client):
    assert client.delete("/vtuber/99999").status_code == 404


def test_cascade_delete(client):
    vid = client.post("/vtuber", json={"name": "级联"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "999"})
    client.delete(f"/vtuber/{vid}")
    assert client.get(f"/vtuber/{vid}/accounts").status_code == 404


# ── 分页 / 统计端点（前端帖子列表用） ─────────────────────────────────

def _seed_posts(client, uid="U1", n=25):
    for i in range(n):
        client.post("/posts", json={
            "platform": "bilibili", "platform_uid": uid,
            "platform_post_id": f"p{i:03d}",
            "type": "video" if i % 2 == 0 else "text",
            "title": f"标题 {i}",
        })


def test_posts_paginated(client):
    _seed_posts(client, n=25)
    r1 = client.get("/posts/bilibili/U1/paginated?page=1&page_size=10").json()
    assert r1["total"] == 25
    assert len(r1["items"]) == 10
    assert r1["page"] == 1 and r1["page_size"] == 10
    r3 = client.get("/posts/bilibili/U1/paginated?page=3&page_size=10").json()
    assert len(r3["items"]) == 5
    # 越界页返回空列表但 total 不变
    r9 = client.get("/posts/bilibili/U1/paginated?page=9&page_size=10").json()
    assert r9["items"] == []
    assert r9["total"] == 25


def test_posts_paginated_filter_by_type(client):
    _seed_posts(client, n=10)
    r = client.get("/posts/bilibili/U1/paginated?type=video").json()
    assert r["total"] == 5
    assert all(p["type"] == "video" for p in r["items"])
    # 兼容性：旧端点（无分页参数）仍返回完整列表
    legacy = client.get("/posts/bilibili/U1").json()
    assert len(legacy) == 10


def test_posts_stats(client):
    _seed_posts(client, n=10)
    r = client.get("/posts/bilibili/U1/stats").json()
    assert r["total"] == 10
    assert r["archived"] == 0
    assert r["by_type"] == {"video": 5, "text": 5}
    assert r["platform"] == "bilibili" and r["platform_uid"] == "U1"


# ── 归档规则 + 未归档动态更新（devlog/016） ─────────────────────────────

def test_archive_posts_endpoint(client):
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1", "platform_post_id": "OLD",
        "type": "text", "published_at": "2026-01-01T00:00:00",
    })
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1", "platform_post_id": "NEW",
        "type": "text", "published_at": "2026-08-15T00:00:00",
    })
    r = client.post("/posts/archive?days=30").json()
    assert r["status"] == "done"
    assert r["archived"] == 1
    assert r["unarchived_total"] == 1
    # 幂等：再次执行不再归档
    assert client.post("/posts/archive?days=30").json()["archived"] == 0


def test_update_posts_endpoint(client, monkeypatch):
    from app.routers import vtuber as vrouter

    async def fake_update(name=None):
        return {"status": "done", "archived": 5,
                "total": {"dynamics": 3, "stored": 1, "skipped": 2},
                "details": [{"platform_uid": "123", "dynamics": 3, "stored": 1,
                             "skipped": 2, "archived_stop": True, "rate_limited": False}]}

    monkeypatch.setattr(vrouter, "async_update_unarchived_posts", fake_update)
    r1 = client.post("/vtuber/update-posts?name=明前").json()
    assert r1["status"] == "done" and r1["archived"] == 5
    r2 = client.post("/vtuber/update-posts").json()  # 无 name = 全部
    assert r2["total"]["stored"] == 1
    assert r2["details"][0]["archived_stop"] is True


def test_fetch_vtuber_endpoint(client, monkeypatch):
    from app.routers import vtuber as vrouter

    vid = client.post("/vtuber", json={"name": "单V测试"}).json()["id"]
    client.post(f"/vtuber/{vid}/accounts", json={"platform": "bilibili", "platform_uid": "123"})

    async def fake_fetch(vtuber_id):
        return type("R", (), {"success": 1, "failed": 0, "skipped": 0, "details": []})()

    monkeypatch.setattr(vrouter, "async_fetch_vtuber", fake_fetch)
    r = client.post(f"/vtuber/{vid}/fetch").json()
    assert r["status"] == "done"
    assert r["result"]["success"] == 1
    # 不存在的 VTuber → 404
    assert client.post("/vtuber/99999/fetch").status_code == 404


# ── 优化项：唯一约束 409 / 删帖作用域 ───────────────────────────────────

def test_duplicate_account_returns_409(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    payload = {"platform": "bilibili", "platform_uid": "123"}
    assert client.post(f"/vtuber/{vid}/accounts", json=payload).status_code == 201
    r = client.post(f"/vtuber/{vid}/accounts", json=payload)
    assert r.status_code == 409  # 修复：此前 IntegrityError 冒泡成 500


def test_duplicate_post_returns_409(client):
    data = {"platform": "bilibili", "platform_uid": "U1", "platform_post_id": "p1", "type": "text"}
    assert client.post("/posts", json=data).status_code == 201
    assert client.post("/posts", json=data).status_code == 409


def test_delete_account_cleans_posts(client):
    """修复：删单个账号此前只删 account，其帖子成孤儿数据。"""
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(f"/vtuber/{vid}/accounts",
                      json={"platform": "bilibili", "platform_uid": "U1"}).json()["id"]
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1", "platform_post_id": "p1", "type": "text",
    })
    assert client.delete(f"/account/{aid}").status_code == 204
    assert client.get("/posts/bilibili/U1").json() == []


def test_delete_vtuber_does_not_delete_other_platform_same_uid(client):
    """修复：解订阅删帖曾只按 platform_uid 过滤，跨平台同 UID 会误删。"""
    vid1 = client.post("/vtuber", json={"name": "A"}).json()["id"]
    client.post(f"/vtuber/{vid1}/accounts", json={"platform": "bilibili", "platform_uid": "123"})
    vid2 = client.post("/vtuber", json={"name": "B"}).json()["id"]
    client.post(f"/vtuber/{vid2}/accounts", json={"platform": "youtube", "platform_uid": "123"})
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "123", "platform_post_id": "B1", "type": "text",
    })
    client.post("/posts", json={
        "platform": "youtube", "platform_uid": "123", "platform_post_id": "Y1", "type": "text",
    })
    assert client.delete(f"/vtuber/{vid1}").status_code == 204
    assert client.get("/posts/bilibili/123").json() == []
    assert len(client.get("/posts/youtube/123").json()) == 1  # youtube 帖保留
