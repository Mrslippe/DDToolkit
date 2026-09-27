"""`_fetch_posts_core` **不再假设自己是 B 站**（第 4 阶段的 ①，devlog/229 + 第二刀 236）。

判据分两层，缺一不可：

1. **行为层**：给核心循环注入一个 `platform="weibo"` 的假适配器，**归档边界必须按微博的
   帖子判定**。旧实现把 `"bilibili"` 写进了去重/归档查询 ⇒ 此时归档集合恒为空，
   边界静默失效（"换个平台就悄悄停止剪枝"）。
2. **结构层**：核心函数的源码里**不许再出现平台字面量、也不许直接调 `fetch_bilibili_*`**
   —— 这条正是这一刀的目标（协议细节归适配器），也是将来别人改坏时的第一道红灯。

第二刀（devlog/236）**加判据**：B 站专属**实现**必须住在 `platforms/bilibili_posts.py`、
`scheduler.py` 里不许再有它们的定义；`uid` 是字符串且**非数字 uid 能一路走通**。
"""
import ast
import asyncio
import inspect
import pathlib

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, Post, VTuber
from app.services import scheduler as sch
from app.services.platforms import bilibili_posts as bp
from app.services.platforms.streams import PostStreams

SCHEDULER_SRC = pathlib.Path(sch.__file__).read_text(encoding="utf-8")
BILIBILI_POSTS_SRC = pathlib.Path(bp.__file__).read_text(encoding="utf-8")

# 第二刀搬走的五个 B 站专属实现（名字与 `BILIBILI_STREAMS` 的五个可选台阶一一对应）
MOVED_IMPL = ("video_bvid_index", "absorb_video_dynamic", "enrich_dynamic_item",
              "refresh_pinned_post", "route_live_item")


def _module_functions(src: str) -> set[str]:
    """模块**顶层**函数名（只看定义，注释里提到旧名字不算）。"""
    return {n.name for n in ast.parse(src).body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


def _fresh_db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _weibo_streams(calls: list[str], dynamics_items: list[dict]) -> PostStreams:
    """一个最小的"单流平台"适配器：视频流空、动态流给 `dynamics_items`。"""

    async def fetch_video_page(uid, page, client):
        calls.append(f"video:{uid}:{page}")
        return {"total": 0, "items": []}

    async def fetch_dynamics_page(uid, offset, client):
        calls.append(f"dynamics:{uid}:{offset!r}")
        return {"items": dynamics_items, "pinned_ids": [], "has_more": False,
                "next_offset": ""}

    return PostStreams(
        platform="weibo",
        fetch_video_page=fetch_video_page,
        fetch_dynamics_page=fetch_dynamics_page,
    )


def test_archive_boundary_follows_the_adapter_platform():
    """归档边界必须查**适配器那个平台**的帖子。

    反向验证：把 `streams.platform` 改回 `"bilibili"` ⇒ 归档集合为空 ⇒ 本用例红
    （`archived_stop` 是 False，且会把这条已归档的帖子当新帖再入库一次）。
    """
    db = _fresh_db()
    v = VTuber(name="微博V")
    db.add(v)
    db.commit()
    acc = Account(vtuber_id=v.id, platform="weibo", platform_uid="7001")
    db.add(acc)
    db.commit()
    db.add(Post(platform="weibo", platform_uid="7001", platform_post_id="W1",
                type="dynamic", is_archived=True, title="旧帖"))
    db.commit()

    calls: list[str] = []
    streams = _weibo_streams(calls, dynamics_items=[
        {"platform": "weibo", "platform_uid": "7001", "platform_post_id": "W1",
         "type": "dynamic", "title": "旧帖"},
    ])

    result = asyncio.run(sch._fetch_posts_core(
        "7001", 1, 1, db, streams=streams, stop_on_existing=False))

    assert result.archived_stop is True, (
        "整页都是已归档帖子却没触发归档边界 —— 说明归档集合查的不是 streams.platform"
    )
    assert result.stop_reason == "archived_boundary"
    assert result.stored == 0, "已归档的帖子不该被重新入库"
    assert db.query(Post).count() == 1
    db.close()


def test_core_actually_uses_the_injected_streams():
    """注入的两条流回调必须真的被调用（否则上面那条判据可能只是"恰好"成立）。"""
    db = _fresh_db()
    calls: list[str] = []
    result = asyncio.run(sch._fetch_posts_core(
        "7001", 1, 1, db, streams=_weibo_streams(calls, dynamics_items=[])))
    assert calls[0].startswith("video:7001:") or calls[0].startswith("dynamics:7001:"), calls
    assert any(c.startswith("video:7001:") for c in calls), "视频流回调没被调用"
    assert any(c.startswith("dynamics:7001:") for c in calls), "动态流回调没被调用"
    assert result.natural_end is True, "两条流都到底 ⇒ natural_end 必须为 True"
    db.close()


def test_core_source_has_no_platform_literals_or_direct_bilibili_calls():
    """结构判据：核心函数里不许出现平台字面量 / `fetch_bilibili_*` 直调。

    反向验证：随便挑一处改回 `"bilibili"` 或 `fetch_bilibili_dynamics(...)` ⇒ 本用例红。
    """
    tree = ast.parse(SCHEDULER_SRC)
    core = next(n for n in ast.walk(tree)
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                and n.name == "_fetch_posts_core")
    literals = sorted({n.value for n in ast.walk(core)
                       if isinstance(n, ast.Constant) and isinstance(n.value, str)
                       and n.value in {"bilibili", "weibo"}})
    direct = sorted({n.func.id for n in ast.walk(core)
                     if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                     and n.func.id.startswith("fetch_bilibili")})
    assert literals == [], f"核心循环里还有平台字面量 {literals} —— 平台名该来自 streams.platform"
    assert direct == [], f"核心循环还在直调 {direct} —— 协议细节该走 streams 回调"


def test_bilibili_binding_is_complete():
    """B 站绑定仍在（这一刀不改行为）：平台名 + 两条流 + 该平台专属的五步台阶。"""
    s = sch.BILIBILI_STREAMS
    assert s.platform == "bilibili"
    assert s.fetch_video_page is not None and s.fetch_dynamics_page is not None
    for name in ("bvid_index", "absorb_video_dynamic", "route_non_post",
                 "enrich_item", "refresh_pinned"):
        assert getattr(s, name) is not None, f"B 站绑定缺了 {name}（会在运行时静默少做一步）"


def test_default_streams_is_bilibili():
    """不传 `streams` 时仍是 B 站（调用方零改动 ⇒ 这条改动的风险面被压到最小）。"""
    import inspect
    sig = inspect.signature(sch._fetch_posts_core)
    assert sig.parameters["streams"].default is sch.BILIBILI_STREAMS


# ── 第二刀（devlog/236）：B 站专属**实现**搬进 platforms/ ────────────────────

def test_bilibili_impl_lives_in_the_platforms_module():
    """结构判据：五个 B 站专属实现住在新模块，`scheduler.py` 里不许再有它们的定义。

    ⚠️ 用 AST 看**顶层函数定义**（不是字符串搜索）：`scheduler.py` 的注释里还会提到旧名字
    （"见 `_absorb_video_dynamic`"这种指引），字符串判据会误报。

    反向验证：把这五个函数任意一个的定义搬回 `scheduler.py` ⇒ 本用例红。
    """
    in_new = _module_functions(BILIBILI_POSTS_SRC)
    missing = sorted(set(MOVED_IMPL) - in_new)
    assert missing == [], f"platforms/bilibili_posts.py 少了 {missing}"

    back_in_scheduler = sorted(set(MOVED_IMPL) & _module_functions(SCHEDULER_SRC))
    assert back_in_scheduler == [], (
        f"{back_in_scheduler} 又回到了 scheduler.py —— 编排（锁/会话/批量）"
        f"与平台实现该分家，判据见 devlog/236"
    )


def test_bilibili_binding_points_at_the_new_module():
    """五个台阶必须真的指向新模块（不是别处的同名替身 / 不是重新实现的副本）。"""
    s = sch.BILIBILI_STREAMS
    assert s.bvid_index is bp.video_bvid_index
    assert s.absorb_video_dynamic is bp.absorb_video_dynamic
    assert s.route_non_post is not None
    # 这两个在绑定里是薄 lambda（要带 platform="bilibili" 与 detail_refresher）⇒
    # 查它们**引用了哪些全局名字**，那正是"指向哪个实现"
    assert "enrich_dynamic_item" in s.enrich_item.__code__.co_names
    assert "refresh_pinned_post" in s.refresh_pinned.__code__.co_names


def test_uid_is_a_string_and_not_assumed_numeric():
    """uid 泛化成**字符串**：注解是 `str`，且**非数字 uid 能一路走通**。

    这是第二刀的行为判据。旧实现 `_fetch_posts_core(mid: int, …)` +
    `_fetch_posts_for_account` 里的 `int(acc.platform_uid)` ⇒ 非数字 uid 直接报"非数字 UID"，
    单流平台（微博 uid 是数字，但小红书是 24 位十六进制串）根本进不来。

    反向验证：把 `platform_uid = uid` 改回 `str(int(uid))` ⇒ 本用例当场 ValueError。
    """
    first = list(inspect.signature(sch._fetch_posts_core).parameters.values())[0]
    assert first.name == "uid", f"第一个参数该叫 uid（核心不该认识 mid 这个词），现在是 {first.name}"
    assert first.annotation is str, f"uid 的注解该是 str，现在是 {first.annotation!r}"

    db = _fresh_db()
    calls: list[str] = []
    streams = _weibo_streams(calls, dynamics_items=[
        {"platform": "weibo", "platform_uid": "xhs_7f3a91c2", "platform_post_id": "N1",
         "type": "dynamic", "title": "非数字 uid 的帖子"},
    ])
    result = asyncio.run(sch._fetch_posts_core("xhs_7f3a91c2", 1, 1, db, streams=streams))

    assert any(c.startswith("video:xhs_7f3a91c2:") for c in calls), (
        f"非数字 uid 没原样传给平台回调：{calls}"
    )
    row = db.query(Post).one()
    assert row.platform_uid == "xhs_7f3a91c2", "落库的 platform_uid 被改写了"
    assert result.stored == 1
    db.close()
