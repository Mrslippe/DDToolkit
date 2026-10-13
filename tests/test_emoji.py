"""表情解析（用户第 5 条，`devlog/482`）。

两层各钉一件事：
- **纯逻辑**（归一化 / 建索引 / 解析）：真机数据的形状都来自 2026-10-13 的实测统计，
  用假表就能钉住 —— 而且**不需要网络**，所以能进门禁。
- **端点**：批量语义 / 查不到就不出现 / 上限 400 / 上游失败不 500（表情不该让正文渲染失败）。
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.services import bili_emote


@pytest.fixture
def client():
    """HTTP 层：把 `get_db` 指到**内存库**（这条路由其实不碰库，但 app 的依赖要能解析）。

    ⚠️ 必须 `StaticPool`：内存 SQLite 每连接一份库，而 TestClient 把同步端点丢到工作线程
    （`test_runtime_settings.py` 里记着同一条坑）。
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    prev = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: session
    yield TestClient(app)
    if prev is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev
    session.close()


# ── ① 纯逻辑：归一化候选 ────────────────────────────────────────────────

@pytest.mark.parametrize("token,expect_head", [
    # `UPOWER_<uid>_<名>`：表里只有裸名 `贴贴` ⇒ 去前缀那条必须**排在最前**
    ("UPOWER_1203217682_贴贴", "贴贴"),
    ("UP_1217754423_carry", "carry"),
    # 包名里真的带下划线的（实测 `doge_金箍`）：原样那条必须留着
    ("doge_金箍", "doge_金箍"),
    # 收藏集：原样（`明前奶绿收藏集表情包_石化`）在表里就是要查的名
    ("明前奶绿收藏集表情包_石化", "明前奶绿收藏集表情包_石化"),
    # 不是表情的那些（分P 标记 / 被屏蔽词）也要能原样返回候选，交给索引去否掉
    ("1P", "1P"),
])
def test_normalize_candidates_order(token, expect_head):
    assert bili_emote.normalize_candidates(token)[0] == expect_head


def test_normalize_candidates_keeps_every_useful_form():
    cands = bili_emote.normalize_candidates("UPOWER_1_明前奶绿_石化")
    assert cands[0] == "明前奶绿_石化"          # 去 uid 前缀
    assert "UPOWER_1_明前奶绿_石化" in cands     # 原样（万一表里真有带前缀的名）
    assert "明前奶绿_石化" in cands and cands.count("明前奶绿_石化") == 1  # 去重


# ── ② 纯逻辑：建索引 + 解析 ─────────────────────────────────────────────

FAKE_PACKAGES = [
    {"emote": [
        {"text": "[贴贴]", "url": "https://cdn/tietie.png"},
        {"text": "[doge_金箍]", "url": "https://cdn/doge.png"},
        {"text": "[明前奶绿收藏集表情包_石化]", "url": "https://cdn/shihua.png"},
        {"text": "[]", "url": "https://cdn/noname.png"},          # 空名：不进索引
        {"text": "[无地址]", "url": ""},                            # 没地址：不进索引
    ]},
    {"emote": None},                                              # 畸形包：不该炸
]


def test_build_index_strips_brackets_and_skips_junk():
    idx = bili_emote.build_index(FAKE_PACKAGES)
    assert idx["贴贴"] == "https://cdn/tietie.png"          # 表里带方括号，我们不带
    assert idx["doge_金箍"] == "https://cdn/doge.png"
    assert "" not in idx and "无地址" not in idx


def test_resolve_maps_tokens_and_drops_unknown():
    idx = bili_emote.build_index(FAKE_PACKAGES)
    got = bili_emote.resolve(
        ["UPOWER_1203217682_贴贴", "doge_金箍", "明前奶绿收藏集表情包_石化", "1P", "▓▓"], idx)
    assert got == {
        "UPOWER_1203217682_贴贴": "https://cdn/tietie.png",
        "doge_金箍": "https://cdn/doge.png",
        "明前奶绿收藏集表情包_石化": "https://cdn/shihua.png",
    }
    # ⚠️ 查不到的**不出现在结果里**（前端据此走名字 chip）——
    #    返回空串会让前端把"没有这个表情"当成"取失败"，两种兜底长得不一样
    assert "1P" not in got and "▓▓" not in got


# ── ③ 端点 ─────────────────────────────────────────────────────────────

def test_resolve_endpoint_returns_only_hits(monkeypatch, client):
    async def _idx(force: bool = False):
        return bili_emote.build_index(FAKE_PACKAGES), None

    monkeypatch.setattr(bili_emote, "emote_index", _idx)
    r = client.get("/emoji/resolve", params={"names": "UPOWER_1_贴贴,1P"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items"] == {"UPOWER_1_贴贴": "https://cdn/tietie.png"}
    assert body["count"] == 1 and body["why"] is None


def test_resolve_endpoint_survives_upstream_failure(monkeypatch, client):
    """上游怎么坏都**不许 500**：正文渲染不该因为表情挂了而失败（前端全走 chip 兜底）。"""
    async def _broken(force: bool = False):
        return {}, "用户面板: 上游 412"

    monkeypatch.setattr(bili_emote, "emote_index", _broken)
    r = client.get("/emoji/resolve", params={"names": "贴贴"})
    assert r.status_code == 200
    assert r.json() == {"items": {}, "count": 0, "why": "用户面板: 上游 412"}


def test_resolve_endpoint_caps_the_batch(monkeypatch, client):
    """超过上限**明确 400**（不是悄悄截断 —— 截断会让前端以为"剩下那些没表情"）。"""
    too_many = ",".join(f"名{i}" for i in range(bili_emote.MAX_TOKENS + 1))
    r = client.get("/emoji/resolve", params={"names": too_many})
    assert r.status_code == 400
    assert "最多" in r.json()["detail"]


def test_resolve_endpoint_empty_names_is_not_an_error(client):
    r = client.get("/emoji/resolve", params={"names": " , "})
    assert r.status_code == 200 and r.json()["count"] == 0
