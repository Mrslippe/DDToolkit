import json
import pytest
from datetime import datetime, timezone
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# 独立测试库，避免污染开发数据库
test_engine = create_engine("sqlite:///./test_vtuber.db", connect_args={"check_same_thread": False})
TestingSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

from app.main import app
from app.core.database import Base, get_db
from app.models.vtuber import (VTuber, Account, Post, AccountStatSnapshot,
                               LiveSession, LiveCategoryOverride)
from app.repositories.vtuber_repo import AccountStatSnapshotRepo


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
        for t in (Post, AccountStatSnapshot, LiveSession, Account, VTuber,
                  LiveCategoryOverride):
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


def test_posts_paginated_filter_multi_type(client):
    # 逗号分隔多型（前端「投稿/图文」分组 chip）：video+text → 全部 10 条
    _seed_posts(client, n=10)
    r = client.get("/posts/bilibili/U1/paginated?type=video,text").json()
    assert r["total"] == 10
    assert all(p["type"] in ("video", "text") for p in r["items"])
    # 逗号带空格同样生效（strip 容错）
    r2 = client.get("/posts/bilibili/U1/paginated?type=video,%20text").json()
    assert r2["total"] == 10


def test_posts_stats(client):
    _seed_posts(client, n=10)
    r = client.get("/posts/bilibili/U1/stats").json()
    assert r["total"] == 10
    assert r["archived"] == 0
    assert r["by_type"] == {"video": 5, "text": 5}
    assert r["platform"] == "bilibili" and r["platform_uid"] == "U1"


def test_posts_paginated_search_matches_body_text(client):
    # P2 全文搜索：q 命中正文正文（title/summary 均不含）——body_text 由后端
    # 从 body_json 派生（create_post），检索逻辑扩展 OR 匹配
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1",
        "platform_post_id": "pbody", "type": "text",
        "title": "第一个帖子", "summary": "第一段摘要",
        "body_json": json.dumps({"text": "海马体在深海里开花了吗", "images": []}, ensure_ascii=False),
    })
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1",
        "platform_post_id": "phead", "type": "text",
        "title": "标题命中", "summary": "摘要也在",
    })
    r = client.get("/posts/bilibili/U1/paginated?q=海马体").json()
    assert r["total"] == 1
    assert r["items"][0]["platform_post_id"] == "pbody"
    # 标题/摘要命中回归不变
    r2 = client.get("/posts/bilibili/U1/paginated?q=标题命中").json()
    assert r2["total"] == 1
    assert r2["items"][0]["platform_post_id"] == "phead"
    # 正文 HTML（content）剥离标签后亦可命中
    client.post("/posts", json={
        "platform": "bilibili", "platform_uid": "U1",
        "platform_post_id": "phtml", "type": "article",
        "title": "专栏", "summary": "专栏摘要",
        "body_json": json.dumps({"content": "<p>深处埋着霓虹色的鲸歌</p>"}, ensure_ascii=False),
    })
    r3 = client.get("/posts/bilibili/U1/paginated?q=霓虹色").json()
    assert r3["total"] == 1
    assert r3["items"][0]["platform_post_id"] == "phtml"


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


# ── 自定义背景：上传 / 清除 ─────────────────────────────────────────────

def test_set_and_clear_background(client, monkeypatch):
    """沙箱限制：不用 pytest tmp_path（%TEMP% 可能无权限），改用工作区临时目录。"""
    import shutil
    from pathlib import Path

    from app.core.config import settings

    bg_dir = Path("./.bgtest")
    bg_dir.mkdir(exist_ok=True)
    old_dir = settings.DATA_DIR
    monkeypatch.setattr(settings, "DATA_DIR", bg_dir)
    try:
        vid = client.post("/vtuber", json={"name": "背景测试"}).json()["id"]
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 64  # 伪 PNG 字节
        r = client.post(
            f"/vtuber/{vid}/background",
            files={"file": ("bg.png", png, "image/png")},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["background_path"] and body["background_path"].startswith("static/custom_bg/")
        assert (bg_dir / body["background_path"]).exists()  # 落盘
        # VTuberOut 序列化已含背景字段（前端直接取用）
        assert client.get(f"/vtuber/{vid}").json()["background_path"] == body["background_path"]
        # 非图片类型 → 415
        bad = client.post(
            f"/vtuber/{vid}/background",
            files={"file": ("bg.txt", b"not-an-image", "text/plain")},
        )
        assert bad.status_code == 415
        # 不存在 → 404
        assert client.post(
            "/vtuber/99999/background", files={"file": ("b.png", png, "image/png")},
        ).status_code == 404
        # 清除：字段置空 + 文件删除
        r2 = client.delete(f"/vtuber/{vid}/background")
        assert r2.status_code == 200
        assert r2.json()["background_path"] is None
        assert not (bg_dir / body["background_path"]).exists()
    finally:
        shutil.rmtree(bg_dir, ignore_errors=True)
        settings.DATA_DIR = old_dir


# ── Account 统计快照端点（P0，v0.5.0） ───────────────────────────────

def test_list_account_stat_snapshots(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    repo = AccountStatSnapshotRepo(db)
    repo.add(aid, 1000, 0, None, captured_at=datetime(2026, 8, 1, tzinfo=timezone.utc))
    repo.add(aid, 1100, 1, "开播了", captured_at=datetime(2026, 8, 2, tzinfo=timezone.utc))
    db.commit()
    db.close()

    resp = client.get(f"/account/{aid}/stat-snapshots")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert data[0]["followers_count"] == 1100           # 时间倒序：最新的在前
    assert data[0]["live_status"] == 1
    assert data[0]["live_title"] == "开播了"
    assert data[0]["captured_at"].endswith(("Z", "+00:00"))  # naive UTC 补时区，前端按本地解析不偏 8h
    assert data[1]["followers_count"] == 1000


def test_stat_snapshots_limit_and_404(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    repo = AccountStatSnapshotRepo(db)
    for i in range(5):
        repo.add(aid, i * 100, 0)
    db.commit()
    db.close()

    assert len(client.get(f"/account/{aid}/stat-snapshots?limit=3").json()) == 3
    # limit 超上限被 Query 约束拒绝（422）
    assert client.get(f"/account/{aid}/stat-snapshots?limit=99999").status_code == 422
    # 账号不存在 → 404
    assert client.get("/account/99999/stat-snapshots").status_code == 404


# ── 直播场次端点（v0.9.x 内容管道 M1） ───────────────────────────────

def test_live_sessions_endpoint_merged(client):
    vid = client.post("/vtuber", json={"name": "测试", "birthday": "09-07"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    repo = AccountStatSnapshotRepo(db)
    repo.add(aid, 1000, 1, "杂谈回", captured_at=datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc))
    repo.add(aid, 1000, 0, None, captured_at=datetime(2026, 9, 7, 13, 0, tzinfo=timezone.utc))
    # danmakus 表内场次（同窗口，live_id 匹配）
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-a",
                       title="深夜杂谈", start_at=datetime(2026, 9, 7, 12, 5),
                       end_at=None, area_name="虚拟日常", parent_area_name="虚拟主播",
                       total_income=88.5, max_online_count=777, danmakus_count=66))
    db.commit()
    db.close()

    resp = client.get(f"/account/{aid}/live-sessions")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1                                 # 合并为一场，不双份
    s = data[0]
    assert s["source"] == "danmakus+self"
    assert s["start_at"].endswith(("Z", "+00:00"))
    assert s["end_at"].endswith(("Z", "+00:00"))          # 快照补 end
    assert s["duration_minutes"] == 55
    assert s["live_title"] == "深夜杂谈"
    assert s["area_name"] == "虚拟日常"
    assert s["total_income"] == 88.5
    assert s["max_online_count"] == 777
    assert s["category"] == "chat"                        # 标题「深夜杂谈」→ 杂谈
    assert s["category_from"] == "title"
    # 账号不存在 → 404
    assert client.get("/account/99999/live-sessions").status_code == 404


# ── 直播分类校正（v0.9.x 类型引擎 v2 第⑦信号） ─────────────────────

def test_live_category_override_flow(client):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-a",
                       title="深夜杂谈", start_at=datetime(2026, 9, 7, 12, 5),
                       end_at=None, area_name="虚拟日常", parent_area_name="虚拟主播"))
    # 系列传播：同骨架「晚上好」×2（无标题信号）
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-b",
                       title="晚上好", start_at=datetime(2026, 9, 8, 20, 0),
                       end_at=None, area_name="虚拟日常", parent_area_name="虚拟主播"))
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-c",
                       title="晚上好", start_at=datetime(2026, 9, 9, 20, 0),
                       end_at=None, area_name="虚拟日常", parent_area_name="虚拟主播"))
    db.commit()
    db.close()

    # 校正 → override 源生效（并立即反哺系列投票）
    resp = client.put(f"/account/{aid}/live-sessions/uuid-a/category",
                      json={"category": "game"})
    assert resp.status_code == 200
    assert resp.json()["category_from"] == "override"
    resp = client.put(f"/account/{aid}/live-sessions/uuid-b/category",
                      json={"category": "watch"})
    assert resp.status_code == 200

    data = client.get(f"/account/{aid}/live-sessions").json()
    by_live = {s["live_id"]: s for s in data}
    assert by_live["uuid-a"]["category"] == "game"
    assert by_live["uuid-a"]["category_from"] == "override"
    # 同系列其他场次随校正传播（series 源）
    assert by_live["uuid-b"]["category_from"] == "override"
    assert by_live["uuid-c"]["category"] == "watch"
    assert by_live["uuid-c"]["category_from"] == "series"

    # 非法分类 → 422（不含 live 兜底）
    assert client.put(f"/account/{aid}/live-sessions/uuid-a/category",
                      json={"category": "nope"}).status_code == 422
    assert client.put(f"/account/{aid}/live-sessions/uuid-a/category",
                      json={"category": "live"}).status_code == 422

    # 撤除 → 恢复自动推断
    assert client.delete(f"/account/{aid}/live-sessions/uuid-a/category").status_code == 204
    data = client.get(f"/account/{aid}/live-sessions").json()
    by_live = {s["live_id"]: s for s in data}
    assert by_live["uuid-a"]["category"] == "chat"        # 标题「深夜杂谈」→ 杂谈
    assert by_live["uuid-a"]["category_from"] == "title"

    # 账号不存在 → 404；撤除无记录 → 404
    assert client.put("/account/99999/live-sessions/x/category",
                      json={"category": "game"}).status_code == 404
    assert client.delete(f"/account/{aid}/live-sessions/uuid-a/category").status_code == 404


# ── 单场次详情（点击日期格 → 独立弹窗；danmaku 已接入 / analysis 预留） ──

def test_live_session_detail_endpoint(client, monkeypatch):
    vid = client.post("/vtuber", json={"name": "测试"}).json()["id"]
    aid = client.post(
        f"/vtuber/{vid}/accounts",
        json={"platform": "bilibili", "platform_uid": "123"},
    ).json()["id"]

    db = TestingSession()
    db.add(LiveSession(account_id=aid, source="danmakus", live_id="uuid-a",
                       title="深夜杂谈", start_at=datetime(2026, 9, 7, 12, 5),
                       end_at=datetime(2026, 9, 7, 13, 0),
                       area_name="虚拟日常", parent_area_name="虚拟主播",
                       total_income=88.5, max_online_count=777, danmakus_count=66))
    # feed 场次（无弹幕数据源，详情不请求网络）
    db.add(LiveSession(account_id=aid, source="feed", live_id="feed-1",
                       title="无限流游戏", start_at=datetime(2026, 9, 8, 20, 0),
                       end_at=None, area_name="主机游戏", parent_area_name="单机游戏"))
    db.commit()
    db.close()

    async def fake_summary(live_id: str):
        return {"total": 39316, "danmakus_count": 17931,
                "word_cloud": [("好耶", 3195), ("MELODY", 210)],
                "watch_count": 16216, "like_count": 163579, "pay_count": 542,
                "interaction_count": 1127, "online_rank": 250, "comment_count": 0,
                "is_full": True, "is_merged": True,
                "peaks": [{"ts": 1788609992428, "count": 366}],
                "versions": [{"user_name": "本站", "is_official": True}],
                "channel": {"fans_count": 133596}}
    async def fake_events(live_id: str):
        return [{"type": 7, "send_date_ms": 1788628090562}]
    monkeypatch.setattr("app.routers.vtuber.fetch_live_summary", fake_summary)
    monkeypatch.setattr("app.routers.vtuber.fetch_live_events", fake_events)

    resp = client.get(f"/account/{aid}/live-sessions/uuid-a")
    assert resp.status_code == 200
    d = resp.json()
    assert d["live_id"] == "uuid-a"
    assert d["live_title"] == "深夜杂谈"
    assert d["duration_minutes"] == 55
    assert d["category"] == "chat"
    assert d["category_from"] == "title"
    assert d["segment_count"] == 1
    # 弹幕摘要已接入（词云 top 词按次数降序；A 组指标 + B 组事件）
    assert d["danmaku"] == {"total": 39316,
                            "top_keywords": ["好耶", "MELODY"],
                            "hot_segments": []}
    m = d["metrics"]
    assert m["watch_count"] == 16216 and m["like_count"] == 163579
    assert m["pay_count"] == 542 and m["interaction_count"] == 1127
    assert m["peaks"] == [{"ts": 1788609992428, "count": 366}]
    assert [e["type"] for e in d["events"]] == [7]
    assert d["events"][0]["send_date"].startswith("2026-09-05T17:08:10")  # naive UTC
    # analysis 仍为预留（内容分析服务未接入）
    assert d["analysis"] is None

    # feed 场次：无 danmakus 源 → danmaku/metrics None、events 空（不请求网络）
    d2 = client.get(f"/account/{aid}/live-sessions/feed-1").json()
    assert d2["danmaku"] is None and d2["metrics"] is None and d2["events"] == []
    assert d2["source"] == "feed"

    # 未收录 live_id → 404；账号不存在 → 404
    assert client.get(f"/account/{aid}/live-sessions/nope").status_code == 404
    assert client.get("/account/99999/live-sessions/uuid-a").status_code == 404
