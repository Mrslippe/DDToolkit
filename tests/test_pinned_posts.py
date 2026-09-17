# -*- coding: utf-8 -*-
"""R35 置顶动态护栏（devlog/139）。

用户口径（2026-09-17）：「有些 v 会将动态置顶来展示周表或舰礼相关的内容，所以将
抓取到的置顶动态同样置顶，并且每日的动态轮询都覆盖它，保证修改及时被捕捉到」。

三组护栏，每组对应一个**会静默出错**的失败模式：

A. 置顶集合同步 —— 新置顶要标上、作者**取消**置顶要撤销（否则列表里永远挂着置顶，
   而且帖子再也回不到时间线原位）
B. 列表排序       —— 置顶帖排最前，且跨页只出现一次（否则翻页会看到重复行）
C. 每轮刷新       —— feed 级每轮免费刷 + 详情级按窗口节流 + 详情失败**不盖时间戳**
   （失败若盖了戳，要等一整个窗口才重试 = 看起来像"作者没改过"）
"""
import asyncio
import json as _json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Post as PostModel
from app.repositories.vtuber_repo import PostRepo
from app.services import pinned_posts
from app.services import scheduler as sch


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


T0 = datetime(2026, 9, 1, 12, 0, 0)      # 计时基线（naive UTC，与库内约定一致）
# 节流窗口是拿**真实当前时间**比的（scheduler 读 datetime.now），所以"刚刷过"这类
# 用例必须用 NOW 而不是 T0 作基准，否则基线一过 6 小时用例就自己变红
NOW = datetime.now(timezone.utc).replace(tzinfo=None)


def _mk_post(db, pid: str, *, published_at: datetime | None = None,
             platform: str = "bilibili", uid: str = "10086",
             type_: str = "text", pinned: bool = False,
             refreshed_at: datetime | None = None,
             summary: str | None = None) -> PostModel:
    p = PostModel(platform=platform, platform_uid=uid, platform_post_id=pid,
                  type=type_, title=f"post-{pid}", summary=summary,
                  published_at=published_at or T0,
                  is_pinned=pinned, pinned_refreshed_at=refreshed_at)
    db.add(p)
    db.commit()
    return p


def _post_item(pid: str, *, ptype: str = "text", platform: str = "bilibili",
               **kw) -> dict:
    item = {
        "platform": platform, "platform_uid": "123", "platform_post_id": pid,
        "type": ptype, "title": "", "summary": "", "cover_url": None,
        "permalink": "", "body_json": "{}", "stats_json": "{}",
        "published_at": None, "raw_json": "{}",
    }
    item.update(kw)
    return item


async def _fake_sleep(_seconds):
    return None


# ── A. 置顶集合同步 ─────────────────────────────────────────────────

def test_sync_pinned_marks_then_revokes(db):
    """标记 + 撤销：作者取消置顶后 is_pinned 必须回落，帖子回时间线原位。"""
    repo = PostRepo(db)
    _mk_post(db, "P1")
    _mk_post(db, "P2")
    _mk_post(db, "N1")

    assert repo.sync_pinned("bilibili", "10086", {"P1", "P2"}) == {
        "marked": 2, "cleared": 0}
    # 同一 published_at 的排序无意义（by_uid 只按时间倒序），比集合
    assert {p.platform_post_id for p in repo.by_uid("bilibili", "10086")
            if p.is_pinned} == {"P1", "P2"}

    # 二次同步：已是置顶的不重复计数
    assert repo.sync_pinned("bilibili", "10086", {"P1", "P2"}) == {
        "marked": 0, "cleared": 0}

    # 作者取消 P2 的置顶（只留 P1）
    assert repo.sync_pinned("bilibili", "10086", {"P1"}) == {
        "marked": 0, "cleared": 1}
    assert repo.by_pid("bilibili", "10086", "P2").is_pinned is False
    assert repo.by_pid("bilibili", "10086", "P1").is_pinned is True


def test_sync_pinned_empty_set_clears_only_that_account(db):
    """空集合 = 当前没有置顶：只清本账号，不碰同平台其它账号。"""
    repo = PostRepo(db)
    _mk_post(db, "A1", pinned=True)
    _mk_post(db, "B1", uid="20000", pinned=True)

    assert repo.sync_pinned("bilibili", "10086", set()) == {"marked": 0, "cleared": 1}
    assert repo.by_pid("bilibili", "10086", "A1").is_pinned is False
    assert repo.by_pid("bilibili", "20000", "B1").is_pinned is True


# ── B. 列表排序 ─────────────────────────────────────────────────────

def test_paginated_pins_first_then_time_desc(db):
    """置顶帖排最前（哪怕它更旧）；`by_uid` 保持纯时间序（时间线图不吃这个改动）。"""
    repo = PostRepo(db)
    _mk_post(db, "OLD-PIN", published_at=T0, pinned=True)
    _mk_post(db, "NEW1", published_at=T0 + timedelta(hours=2))
    _mk_post(db, "NEW2", published_at=T0 + timedelta(hours=1))

    _, items = repo.paginated("bilibili", "10086")
    assert [p.platform_post_id for p in items] == ["OLD-PIN", "NEW1", "NEW2"]
    assert [p.platform_post_id for p in repo.by_uid("bilibili", "10086")] == [
        "NEW1", "NEW2", "OLD-PIN"]


def test_pinned_appears_once_across_pages(db):
    """跨页不重复：置顶帖只落在第 1 页头部，total 也不因置顶而变。"""
    repo = PostRepo(db)
    _mk_post(db, "PIN", published_at=T0, pinned=True)
    for i in range(4):
        _mk_post(db, f"P{i}", published_at=T0 + timedelta(hours=i + 1))

    total, p1 = repo.paginated("bilibili", "10086", page=1, page_size=2)
    _, p2 = repo.paginated("bilibili", "10086", page=2, page_size=2)
    _, p3 = repo.paginated("bilibili", "10086", page=3, page_size=2)
    seen = [p.platform_post_id for p in p1 + p2 + p3]
    assert total == 5
    assert seen[0] == "PIN"
    assert seen.count("PIN") == 1
    assert sorted(seen) == ["P0", "P1", "P2", "P3", "PIN"]


# ── C1. 纯判定（节流窗口 / 字段组装） ────────────────────────────────

def test_detail_refresh_due_windows():
    now = T0
    assert pinned_posts.detail_refresh_due(None, now, 6.0) is True      # 从没刷过
    assert pinned_posts.detail_refresh_due(now - timedelta(hours=5), now, 6.0) is False
    assert pinned_posts.detail_refresh_due(now - timedelta(hours=6), now, 6.0) is True
    assert pinned_posts.detail_refresh_due(now, now, 0) is True         # 0 = 每轮都拉
    assert pinned_posts.detail_refresh_due(now - timedelta(days=30), now, -1) is False
    # 负窗口 = 永不主动拉详情（只刷 feed 级字段）
    assert pinned_posts.detail_refresh_due(None, now, -1) is False


def test_refresh_fields_skips_empty_values():
    """缺字段不能抹掉库里已有的内容（B 站 feed 的 title 多数为空）。"""
    item = {"title": "", "summary": None, "cover_url": "http://c/1.jpg",
            "stats_json": '{"like": 3}', "body_json": '{"text": "正文"}',
            "published_at": None}
    feed = pinned_posts.refresh_fields(item, with_detail=False)
    assert feed == {"cover_url": "http://c/1.jpg", "stats_json": '{"like": 3}'}

    full = pinned_posts.refresh_fields(item, with_detail=True)
    assert full["body_json"] == '{"text": "正文"}'
    assert full["body_text"] == "正文"           # 派生列随之重算（P2 全文搜索）
    assert "published_at" not in full            # None 不写入

    # 空统计 `{}` 同样不许覆盖（列表页偶发）——否则会把已有的播放/点赞抹成空
    assert pinned_posts.refresh_fields({"stats_json": "{}"}, with_detail=False) == {}
    assert pinned_posts.refresh_fields({"stats_json": ""}, with_detail=False) == {}


# ── C2. 刷新一条置顶帖（feed 档 / 详情档 / 失败重试） ─────────────────

def _refresher(item: dict, *, ok: bool = True, calls: list | None = None):
    """假的详情档：模拟 _enrich_dynamic_item（就地改 item，返回是否拿到详情）。"""
    async def run() -> bool:
        if calls is not None:
            calls.append(item["platform_post_id"])
        if not ok:
            return False
        item["summary"] = "详情摘要"
        item["body_json"] = _json.dumps({"text": "改过的周表"}, ensure_ascii=False)
        return True
    return run


def test_pinned_refresh_feed_only_when_detail_not_due(db):
    """窗口内只刷 feed 档：零额外请求，也不动 pinned_refreshed_at。"""
    fresh = NOW - timedelta(hours=1)
    _mk_post(db, "PIN", pinned=True, refreshed_at=fresh, summary="旧摘要")
    item = _post_item("PIN", summary="新摘要", stats_json='{"like": 9}')
    calls: list[str] = []

    async def run():
        return await sch._refresh_pinned_post(
            PostRepo(db), "bilibili", "10086", item,
            detail_refresher=_refresher(item, calls=calls))

    assert asyncio.run(run()) is True
    assert calls == []                                  # 没到期 → 不拉详情
    row = PostRepo(db).by_pid("bilibili", "10086", "PIN")
    assert row.summary == "新摘要"
    assert row.stats_json == '{"like": 9}'
    assert row.pinned_refreshed_at == fresh             # 未盖新戳


def test_pinned_refresh_detail_when_due_stamps_and_recomputes_body_text(db):
    """到期 → 拉详情、写正文 + 重算 body_text、盖时间戳。"""
    row = _mk_post(db, "PIN", pinned=True, refreshed_at=None, summary="旧摘要")
    item = _post_item("PIN", summary="feed 摘要")
    calls: list[str] = []

    async def run():
        return await sch._refresh_pinned_post(
            PostRepo(db), "bilibili", "10086", item,
            detail_refresher=_refresher(item, calls=calls))

    assert asyncio.run(run()) is True
    assert calls == ["PIN"]
    row = PostRepo(db).by_pid("bilibili", "10086", "PIN")
    assert row.summary == "详情摘要"                     # 详情档覆盖 feed 档
    assert "改过的周表" in (row.body_json or "")
    assert row.body_text == "改过的周表"
    assert row.pinned_refreshed_at is not None           # 盖章 → 窗口开始计时


def test_pinned_refresh_detail_failure_keeps_timestamp_for_retry(db, caplog):
    """详情失败：feed 档照常落地，但**不盖时间戳**（下轮重试）+ warn 留痕。"""
    _mk_post(db, "PIN", pinned=True, refreshed_at=None, summary="旧摘要")
    item = _post_item("PIN", summary="新摘要")
    calls: list[str] = []

    async def run():
        return await sch._refresh_pinned_post(
            PostRepo(db), "bilibili", "10086", item,
            detail_refresher=_refresher(item, ok=False, calls=calls))

    with caplog.at_level("WARNING"):
        assert asyncio.run(run()) is True
    assert calls == ["PIN"]
    row = PostRepo(db).by_pid("bilibili", "10086", "PIN")
    assert row.summary == "新摘要"                       # feed 档仍然生效
    assert row.pinned_refreshed_at is None               # 没盖戳 → 下轮还会试
    assert "置顶动态详情刷新失败" in caplog.text


def test_pinned_refresh_ignores_missing_row(db):
    """没入库的 pid（例如被并入投稿的投稿动态）→ 不报错、不写库。"""
    item = _post_item("NOPE")

    async def run():
        return await sch._refresh_pinned_post(PostRepo(db), "bilibili", "10086", item)

    assert asyncio.run(run()) is False


# ── D. 抓取循环接线（B 站 / 微博两条分支） ───────────────────────────

def test_fetch_posts_core_refreshes_pinned_instead_of_skipping(monkeypatch, db):
    """循环接线：已入库的置顶帖走刷新（不计 skipped），新抓到的置顶帖同轮标上。"""
    # mid=123 → 帖子 platform_uid 必须是 "123"（循环按 platform+uid 取 existing_ids）
    _mk_post(db, "PIN", uid="123")                       # 已入库、还不是置顶
    _mk_post(db, "OLD", uid="123")

    pages = [
        {"items": [_post_item("PIN"), _post_item("NEWPIN"), _post_item("OLD")],
         "has_more": False, "pinned_ids": ["PIN", "NEWPIN"]},
    ]
    calls = {"n": 0}
    detail_ids: list[str] = []

    async def fake_dynamics(mid, offset="", client=None):
        calls["n"] += 1
        return pages[calls["n"] - 1]

    async def fake_detail(pid, client=None):
        detail_ids.append(pid)
        return {"summary": f"详情-{pid}"}

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr(sch, "fetch_dynamic_detail", fake_detail)
    monkeypatch.setattr("asyncio.sleep", _fake_sleep)

    async def run():
        return await sch._fetch_posts_core(123, 0, 10, db,
                                           include_videos=False, stop_on_existing=True)

    r = asyncio.run(run())
    assert r.pinned_refreshed == 1        # PIN 走刷新而不是 skipped
    assert r.pinned_marked == 2           # PIN + NEWPIN 同轮标上
    assert r.pinned_cleared == 0
    assert r.skipped == 1                 # 只有 OLD 计入跳过
    assert r.stored == 1                  # NEWPIN 入库
    assert detail_ids == ["PIN", "NEWPIN"]    # 置顶刷新与新帖各拉一次详情
    repo = PostRepo(db)
    assert repo.by_pid("bilibili", "123", "PIN").is_pinned is True
    assert repo.by_pid("bilibili", "123", "PIN").pinned_refreshed_at is not None
    assert repo.by_pid("bilibili", "123", "NEWPIN").is_pinned is True
    assert repo.by_pid("bilibili", "123", "OLD").is_pinned is False


def test_fetch_platform_posts_refreshes_pinned_weibo(monkeypatch, db):
    """微博分支同一套口径：置顶帖刷新 + 首页集合同步（isTop 只出现在首页）。"""
    _mk_post(db, "PIN", platform="weibo", uid="123", summary="旧摘要")

    enrich_calls: list[str] = []

    class _PF:
        platform = "weibo"

        async def fetch_post_page(self, uid, page, client=None):
            if page == 1:
                return {"items": [_post_item("PIN", platform="weibo", summary="新摘要"),
                                  _post_item("FRESH", platform="weibo")],
                        "has_more": False, "pinned_ids": ["PIN"]}
            return {"items": [], "has_more": False}

        async def enrich(self, item, client=None):
            enrich_calls.append(item["platform_post_id"])
            return False        # 非长文：没活干（真实语义，不代表失败）

    monkeypatch.setattr("asyncio.sleep", _fake_sleep)

    async def run():
        return await sch._fetch_platform_posts(_PF(), "123", 10, db,
                                               stop_on_existing=True)

    r = asyncio.run(run())
    assert r.pinned_refreshed == 1
    assert r.pinned_marked == 1
    assert r.stored == 1
    assert enrich_calls[0] == "PIN"       # 详情档先给置顶帖用（FRESH 走的是新帖详情补全）
    repo = PostRepo(db)
    row = repo.by_pid("weibo", "123", "PIN")
    assert row.is_pinned is True
    assert row.summary == "新摘要"         # feed 档每轮都刷
    assert row.pinned_refreshed_at is not None
