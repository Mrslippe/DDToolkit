"""表情解析（用户第 5 条，`devlog/482` + `devlog/483` 两级解析）。

三层各钉一件事：
- **纯逻辑**（归一化 / 建索引 / 解析）：真机数据的形状都来自 2026-10-13 的实测统计，
  用假表就能钉住 —— 而且**不需要网络**，所以能进门禁。
- **第一源**（我们自己载荷里的 `rich_text_nodes[*].emoji`）：纯函数 `scan_payloads` 用假载荷钉，
  `warm_raw_index` 用**内存库**钉"增量 + 幂等"（这是它唯一的复杂点：marker 决定扫多少行）。
- **端点**：批量语义 / 查不到就不出现 / 上限 400 / **两级优先级** / 第二源失败不 500。
"""
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.services import bili_emote


@pytest.fixture(autouse=True)
def _clean_caches():
    """两级索引都是**模块级**缓存：每个用例前后都清干净。

    ⚠️ 不写这个 fixture 的症状很隐蔽：前一条用例留下的载荷索引让后一条用例"明明该问上游却一次没问"
    （载荷先命中就直接返回了），断言随机地过/不过。
    """
    bili_emote.reset_caches()
    yield
    bili_emote.reset_caches()


@pytest.fixture
def db():
    """内存库（`StaticPool` ⇒ 一个连接一份库，别改成默认池）。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture
def client(db):
    """HTTP 层：把 `get_db` 指到内存库（这两条路由其实不碰库，但 app 的依赖要能解析）。

    ⚠️ 必须 `StaticPool`：内存 SQLite 每连接一份库，而 TestClient 把同步端点丢到工作线程
    （`test_runtime_settings.py` 里记着同一条坑）。
    """
    prev = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    if prev is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev


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
    """只有命中的出现在 `items` 里；`origin` 说清是谁给的。"""
    async def _resolved(tokens):
        return {"贴贴": "https://cdn/tietie.png"}, {"贴贴": "panel"}

    monkeypatch.setattr(bili_emote, "resolve_all_async", _resolved)
    r = client.get("/emoji/resolve", params={"names": "UPOWER_1_贴贴,1P"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items"] == {"贴贴": "https://cdn/tietie.png"}
    assert body["count"] == 1
    assert body["origin"] == {"贴贴": "panel"}
    assert body["why"] is None


def test_resolve_endpoint_survives_upstream_failure(monkeypatch, client):
    """上游怎么坏都**不许 500**：正文渲染不该因为表情挂了而失败（前端全走 chip 兜底）。"""
    async def _broken(force: bool = False):
        bili_emote._cache["why"] = "用户面板: 上游 412"
        return {}, bili_emote._cache["why"]

    monkeypatch.setattr(bili_emote, "emote_index", _broken)
    monkeypatch.setitem(bili_emote._raw_cache, "index", {})
    r = client.get("/emoji/resolve", params={"names": "贴贴"})
    assert r.status_code == 200
    assert r.json() == {"items": {}, "count": 0, "origin": {}, "why": "用户面板: 上游 412"}


def test_resolve_endpoint_prefers_payload_and_falls_back(monkeypatch, client):
    """**两级并集 + 优先级**（`devlog/483` 的核心口径，端点级钉一遍）。

    第一源命中的 ⇒ `origin=payload`（离线、99%）；剩下的才问第二源 ⇒ `origin=panel`；
    两级都没有的 ⇒ 干脆不出现（前端走名字 chip）。
    """
    calls = []

    async def _resolved(tokens):
        calls.append(list(tokens))
        # 真实语义：`resolve_all_async` 内部就是"先载荷、剩下的给面板"，这里照抄一份形状
        assert tokens == ["UPOWER_1_贴贴", "1P"], tokens
        return ({"UPOWER_1_贴贴": "https://cdn/tietie.png"},
                {"UPOWER_1_贴贴": "payload"})

    monkeypatch.setattr(bili_emote, "resolve_all_async", _resolved)
    r = client.get("/emoji/resolve", params={"names": "UPOWER_1_贴贴,1P"})
    assert r.status_code == 200
    body = r.json()
    assert body["items"] == {"UPOWER_1_贴贴": "https://cdn/tietie.png"}
    assert body["origin"] == {"UPOWER_1_贴贴": "payload"}
    assert "1P" not in body["items"]          # 不是表情 ⇒ 不出现在结果里
    assert calls == [["UPOWER_1_贴贴", "1P"]]  # 一次批量调用，不是逐个查


def test_resolve_all_takes_payload_first_and_panel_only_for_the_rest(monkeypatch):
    """`resolve_all` 本身：第一源命中就不问第二源；未命中的才落到第二源（纯函数级）。"""
    monkeypatch.setitem(bili_emote._raw_cache, "index",
                        {"贴贴": ("https://cdn/from-payload.png", "18626")})
    monkeypatch.setattr(bili_emote, "_sync_panel_index",
                        lambda: {"石化": "https://cdn/from-panel.png"})
    hit, origin = bili_emote.resolve_all(["UPOWER_1_贴贴", "up_石化", "1P"])
    assert hit == {"UPOWER_1_贴贴": "https://cdn/from-payload.png",
                   "up_石化": "https://cdn/from-panel.png"}
    assert origin == {"UPOWER_1_贴贴": "payload", "up_石化": "panel"}
    assert "1P" not in hit and "1P" not in origin


def test_resolve_all_skips_panel_when_payload_covers_everything(monkeypatch):
    """第一源全中时**一次上游都不碰**（离线路径不该被网络拖慢）。"""
    monkeypatch.setitem(bili_emote._raw_cache, "index",
                        {"贴贴": ("https://cdn/tietie.png", None)})

    def _boom():
        raise AssertionError("载荷全中时不该读第二源")

    monkeypatch.setattr(bili_emote, "_sync_panel_index", _boom)
    hit, origin = bili_emote.resolve_all(["UPOWER_1_贴贴"])
    assert hit == {"UPOWER_1_贴贴": "https://cdn/tietie.png"}
    assert origin == {"UPOWER_1_贴贴": "payload"}


def test_resolve_endpoint_fetches_the_panel_only_when_the_payload_misses(monkeypatch, client):
    """**第二源是"按需"拉的**（`resolve_all_async`）：载荷全中时一次上游都不碰。

    ⚠️ 这条盯的是一个**真发生过**的坑：曾经把填充第二源的活写进 `prefetch_panel_index()`
    并"打算放启动期"，但没人调它 ⇒ 文档里写着有兜底、运行期其实永远命中不了，**且不报错**。
    所以判据要同时对两侧断言：漏了 ⇒ 真的去拉；没漏 ⇒ 一次都不拉。
    """
    fetched = []

    async def _fake_emote_index(force: bool = False):
        fetched.append(force)
        bili_emote._cache["index"] = {"石化": "https://cdn/from-panel.png"}
        bili_emote._cache["at"] = 1e12          # 新鲜：同一次请求里不会拉第二遍
        return bili_emote._cache["index"], None

    monkeypatch.setattr(bili_emote, "emote_index", _fake_emote_index)
    monkeypatch.setitem(bili_emote._raw_cache, "index",
                        {"贴贴": ("https://cdn/from-payload.png", None)})

    # ① 载荷命中了 ⇒ 不出网
    r = client.get("/emoji/resolve", params={"names": "UPOWER_1_贴贴"})
    assert r.json()["items"] == {"UPOWER_1_贴贴": "https://cdn/from-payload.png"}
    assert r.json()["origin"] == {"UPOWER_1_贴贴": "payload"}
    assert fetched == [], "载荷全中却去拉了上游"

    # ② 载荷漏了一个 ⇒ 拉一次第二源，把它补上（`origin` 说得清是谁给的）
    r = client.get("/emoji/resolve", params={"names": "UPOWER_1_贴贴,up_石化"})
    body = r.json()
    assert fetched == [False]
    assert body["items"] == {"UPOWER_1_贴贴": "https://cdn/from-payload.png",
                             "up_石化": "https://cdn/from-panel.png"}
    assert body["origin"] == {"UPOWER_1_贴贴": "payload", "up_石化": "panel"}


def test_panel_fetch_is_throttled_after_a_failure(monkeypatch, client):
    """第二源拉失败之后**不许每个请求都再打一次上游**（失败不写 `at`，得靠 `last_try` 拦）。

    ⚠️ 只看 `at` 的写法在这里会红：失败时 `at` 停在 0 ⇒ 每个带漏项的请求都出网一次。
    """
    calls = []

    async def _broken(force: bool = False):
        calls.append(1)
        bili_emote._cache["why"] = "用户面板: 上游 412"
        return {}, bili_emote._cache["why"]      # 失败：索引与 `at` 都不更新

    monkeypatch.setattr(bili_emote, "emote_index", _broken)
    monkeypatch.setitem(bili_emote._raw_cache, "index", {})

    r = client.get("/emoji/resolve", params={"names": "贴贴"})
    assert r.status_code == 200                    # 不许 500：正文照常渲染
    assert r.json() == {"items": {}, "count": 0, "origin": {}, "why": "用户面板: 上游 412"}
    assert len(calls) == 1

    # 紧接着再来一发 ⇒ 被 `RETRY_AFTER` 拦住（这一发只是"没有表情可画"，不是又挂了）
    r2 = client.get("/emoji/resolve", params={"names": "贴贴"})
    assert r2.status_code == 200 and len(calls) == 1, "失败后每个请求都在重试上游"

    # 过了退避窗口 ⇒ 允许再试一次
    monkeypatch.setitem(bili_emote._cache, "last_try", 0.0)
    client.get("/emoji/resolve", params={"names": "贴贴"})
    assert len(calls) == 2


def test_panel_needs_fetch_respects_freshness_and_backoff(monkeypatch):
    """`_panel_needs_fetch` 的三态（纯函数级，不用打 HTTP）。"""
    import time as _t

    monkeypatch.setitem(bili_emote._cache, "index", {"贴贴": "https://cdn/a.png"})
    monkeypatch.setitem(bili_emote._cache, "at", _t.time())
    monkeypatch.setitem(bili_emote._cache, "last_try", 0.0)
    assert bili_emote._panel_needs_fetch() is False          # 新鲜：不拉

    monkeypatch.setitem(bili_emote._cache, "at", 0.0)        # 过期
    monkeypatch.setitem(bili_emote._cache, "last_try", _t.time())
    assert bili_emote._panel_needs_fetch() is False          # 但刚试过：退避

    monkeypatch.setitem(bili_emote._cache, "last_try", 0.0)
    assert bili_emote._panel_needs_fetch() is True           # 窗口过了：该拉了


def test_resolve_endpoint_caps_the_batch(monkeypatch, client):
    """超过上限**明确 400**（不是悄悄截断 —— 截断会让前端以为"剩下那些没表情"）。"""
    too_many = ",".join(f"名{i}" for i in range(bili_emote.MAX_TOKENS + 1))
    r = client.get("/emoji/resolve", params={"names": too_many})
    assert r.status_code == 400
    assert "最多" in r.json()["detail"]


def test_resolve_endpoint_empty_names_is_not_an_error(client):
    r = client.get("/emoji/resolve", params={"names": " , "})
    assert r.status_code == 200 and r.json()["count"] == 0


def test_packages_endpoint_reports_both_sources(monkeypatch, client):
    """`/emoji/packages`：诊断两级索引 + 载荷里见过的包 id（将来"整包"的种子）。"""
    monkeypatch.setitem(bili_emote._raw_cache, "index", {
        "贴贴": ("https://cdn/a.png", "18626"),
        "石化": ("https://cdn/b.png", "18626"),
        "闪亮": ("https://cdn/c.png", None),          # 载荷没给包 id 的也要能算
    })
    monkeypatch.setitem(bili_emote._cache, "index", {"石化": "https://cdn/x.png"})
    body = client.get("/emoji/packages").json()
    assert body["payload_names"] == 3
    assert body["payload_packages"] == 1                   # 去重
    assert body["payload_package_ids"] == ["18626"]
    assert body["panel_names"] == 1


# ── ④ 第一源：载荷扫描与增量热索引 ───────────────────────────────────────

def _payload(emoji: dict) -> str:
    """一份最小可用载荷（形状照抄真机：`rich_text_nodes[*].emoji`）。"""
    return json.dumps({"modules": {"module_dynamic": {"desc": {
        "rich_text_nodes": [{"type": "TEXT", "text": "看这个"}, {"type": "EMOJI", "emoji": emoji}]}}}})


def _add_post(db, pid: int, emoji: dict):
    """塞一条带载荷的帖子（`platform*` 三列是 NOT NULL，不填会被 SQLite 拒掉）。"""
    from app.models.vtuber import Post

    db.add(Post(id=pid, platform="bilibili", platform_uid="1", platform_post_id=str(pid),
                type="text", raw_json=_payload(emoji)))
    db.commit()


def test_scan_payloads_reads_emoji_nodes_and_skips_junk():
    index = bili_emote.scan_payloads([
        _payload({"text": "[UPOWER_1_贴贴]", "icon_url": "https://cdn/tietie.png",
                  "package_id": "18626"}),
        "{不是 JSON",                     # 历史遗留的坏行 ⇒ 跳过，不毁掉整个索引
        None,
        _payload({"text": "[石化]"}),      # 没有地址 ⇒ 不进索引
    ])
    assert index == {"UPOWER_1_贴贴": ("https://cdn/tietie.png", "18626")}


def test_scan_payloads_keeps_the_uid_prefix():
    """索引键保留 `UPOWER_<uid>_` 前缀，**不做跨 UP 猜测**（2026-10-13 实测定的口径）。

    归一化（去掉 `UPOWER_<uid>_`）看着更"通用"，但真机数据说它**一点没多救**
    （5,058 行 / 498 个正文 token：两种口径都是 493 个 = 99.0%，缺的 5 个全是
    `1P`/`▓▓` 那类根本不是表情的），却换来 **14 组同名不同图**
    （`打call`/`爱你`/`干杯`… 各有 2 张图 —— 那是不同 UP 各自的自定义表情）。
    ⇒ 保留前缀：覆盖一样高，且绝不会把 A 的表情画成 B 的。
    """
    index = bili_emote.scan_payloads([_payload(
        {"text": "[UPOWER_1_贴贴]", "icon_url": "https://cdn/tietie.png"})])
    assert "UPOWER_1_贴贴" in index

    # 同一个名字、**另一个 UP** 发的：不猜（前端走 chip），而不是拿 A 的图顶上
    index2 = bili_emote.scan_payloads([_payload(
        {"text": "[UPOWER_1_打call]", "icon_url": "https://cdn/a.png"})])
    got = bili_emote.resolve(["UPOWER_2_打call"], {k: v[0] for k, v in index2.items()})
    assert got == {}


def test_scan_payloads_later_row_wins():
    """同一枚表情被 UP 换过图：**后扫到的**（id 更大）才是当下有效的地址。"""
    index = bili_emote.scan_payloads([
        _payload({"text": "[贴贴]", "icon_url": "https://cdn/old.png"}),
        _payload({"text": "[贴贴]", "icon_url": "https://cdn/new.png"}),
    ])
    assert index["贴贴"][0] == "https://cdn/new.png"


def test_warm_raw_index_scans_once_then_only_new_rows(db):
    """启动期热索引：第一遍扫全表，第二遍**零扫描**（幂等 —— 靠 `app_meta` 里的 marker）。"""
    _add_post(db, 1, {"text": "[贴贴]", "icon_url": "https://cdn/tietie.png",
                      "package_id": "18626"})

    first = bili_emote.warm_raw_index(db)
    assert first == {"scanned": 1, "names": 1, "packages": 1, "last_id": 1}
    assert bili_emote.raw_index() == {"贴贴": ("https://cdn/tietie.png", "18626")}

    # 没有新行 ⇒ 一行都不扫（marker 生效），但索引仍在（从 `app_meta` 里读回来的）
    bili_emote.reset_caches()
    second = bili_emote.warm_raw_index(db)
    assert second["scanned"] == 0 and second["last_id"] == 1
    assert bili_emote.raw_index() == {"贴贴": ("https://cdn/tietie.png", "18626")}

    # 来了新行 ⇒ 只扫新的那行，且是**并集**（老的没丢）
    _add_post(db, 2, {"text": "[石化]", "icon_url": "https://cdn/shihua.png"})
    third = bili_emote.warm_raw_index(db)
    assert third["scanned"] == 1 and third["last_id"] == 2
    assert set(bili_emote.raw_index()) == {"贴贴", "石化"}


def test_warm_raw_index_force_rescans_everything(db):
    """`force=True`：无视 marker 全扫（改过解析规则后重建用）。"""
    _add_post(db, 1, {"text": "[贴贴]", "icon_url": "https://cdn/a.png"})
    bili_emote.warm_raw_index(db)
    assert bili_emote.warm_raw_index(db)["scanned"] == 0
    assert bili_emote.warm_raw_index(db, force=True)["scanned"] == 1


def test_warm_raw_index_survives_a_corrupt_marker(db):
    """`app_meta` 里的索引被写坏了 ⇒ 当作没存，重建（**不许抛错**：这是启动路径）。"""
    _add_post(db, 1, {"text": "[贴贴]", "icon_url": "https://cdn/a.png"})
    db.execute(text("INSERT INTO app_meta (key, value) VALUES ('emoji.raw_index', '{{{坏')"))
    db.commit()
    got = bili_emote.warm_raw_index(db)
    assert got["scanned"] == 1 and got["names"] == 1
    assert bili_emote.raw_index()["贴贴"][0] == "https://cdn/a.png"

