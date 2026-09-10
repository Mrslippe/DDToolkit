# -*- coding: utf-8 -*-
"""多平台爬虫框架测试（微博 m 站适配 + 平台分发）：
- 用户信息 / 微博列表映射 / 时间解析 / 长文补全
- 通用单流抓取循环（增量遇已入库即停）
- 账号信息抓取与帖子抓取的平台分发
"""
import asyncio
import json

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, Post as PostModel
from app.services.platforms import weibo, registry


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


async def fake_sleep(_seconds):
    return None


# ── 时间解析 ─────────────────────────────────────────────────────────

def test_parse_weibo_time_full_format():
    from datetime import timezone as tz
    dt = weibo._parse_weibo_time("Mon Aug 25 12:34:56 +0800 2025")
    assert dt is not None
    assert dt.tzinfo is None                # naive UTC，与库内约定一致
    assert dt.hour == 4                     # +0800 → UTC 折 8 小时
    assert weibo._parse_weibo_time("") is None
    assert weibo._parse_weibo_time(None) is None


def test_parse_weibo_time_relative():
    assert weibo._parse_weibo_time("5分钟前") is not None
    assert weibo._parse_weibo_time("2小时前") is not None


# ── 微博列表映射 ──────────────────────────────────────────────────────

def _mblog(**kw):
    base = {
        "id": "5099666961200194",
        "text": "今晚八点开播 <span class=\"url-icon\"><a href=\"x\">O</a></span>",
        "created_at": "Mon Aug 25 20:00:00 +0800 2025",
        "pics": [],
        "reposts_count": 10,
        "comments_count": 20,
        "attitudes_count": 30,
        "user": {"id": 3669102477, "screen_name": "鞠婧祎"},
    }
    base.update(kw)
    return base


def test_map_mblog_text():
    m = weibo._map_mblog(_mblog(), "3669102477")
    assert m["platform"] == "weibo"
    assert m["platform_post_id"] == "5099666961200194"
    assert m["type"] == "text"
    assert "今晚八点开播" in m["summary"]
    assert "<span" not in m["summary"]      # HTML 标签已剥离
    assert m["permalink"] == "https://m.weibo.cn/detail/5099666961200194"
    assert m["published_at"] is not None
    assert json.loads(m["stats_json"])["like"] == 30


def test_map_mblog_pic_ids_pc():
    """PC 列表用 pic_ids + pic_infos → 取 pic_infos[largest] 真实大图 URL。"""
    pid = "a1b2c3d4e5f6g7"
    m = weibo._map_mblog(_mblog(
        pic_ids=[pid], pics=None,
        pic_infos={pid: {"largest": {"url": f"https://wx1.sinaimg.cn/large/{pid}.jpg"}}},
    ), "1")
    assert m["type"] == "image"
    assert json.loads(m["body_json"])["images"][0]["url"] == f"https://wx1.sinaimg.cn/large/{pid}.jpg"


def test_map_mblog_pic_ids_fallback_concat():
    """无 pic_infos 时回退拼 wx1.sinaimg.cn/large/{pid}.jpg。"""
    m = weibo._map_mblog(_mblog(pic_ids=["abc123"], pics=None), "1")
    assert json.loads(m["body_json"])["images"][0]["url"] == "https://wx1.sinaimg.cn/large/abc123.jpg"


def test_map_mblog_image_repost_video():
    img = weibo._map_mblog(_mblog(pics=[{"large": "https://wx1.sinaimg.cn/a.jpg"}]), "1")
    assert img["type"] == "image"
    body = json.loads(img["body_json"])
    assert body["images"][0]["url"] == "https://wx1.sinaimg.cn/a.jpg"

    rp = weibo._map_mblog(_mblog(retweeted_status=_mblog(id="111", text="原文")), "1")
    assert rp["type"] == "repost"
    origin = json.loads(rp["body_json"])["origin"]
    assert origin["text"] == "原文"
    # 转发原文带 pic_infos → 图片取 largest 真实 URL
    rp2 = weibo._map_mblog(_mblog(retweeted_status=_mblog(
        id="112", pic_ids=["p1"],
        pic_infos={"p1": {"largest": {"url": "https://wx1.sinaimg.cn/large/p1.jpg"}}})), "1")
    o2 = json.loads(rp2["body_json"])["origin"]
    assert o2["images"][0]["url"] == "https://wx1.sinaimg.cn/large/p1.jpg"
    assert o2["cover_url"].endswith("p1.jpg")

    vd = weibo._map_mblog(_mblog(page_info={
        "type": "video", "title": "视频标题",
        "page_pic": "https://wx1.sinaimg.cn/cover.jpg",
        "media_info": {"mp4_720p_mp4": "https://f.video.weibocdn.com/a.mp4"},
    }), "1")
    assert vd["type"] == "video"
    vbody = json.loads(vd["body_json"])
    assert vbody["video"]["mp4"].startswith("https://")

    # video 仅 page_pic（无 mp4 字段）也归 video，cover 保留
    vc = weibo._map_mblog(_mblog(page_info={
        "type": "video", "page_pic": "https://wx1.sinaimg.cn/c.jpg",
        "media_info": {},
    }), "1")
    assert vc["type"] == "video"


def test_map_mblog_vip_card_is_not_video():
    """回归：实测 page_info.type=23 是 SVIP 会员推广卡（webpage 卡、无 media），
    不得误判为视频——有图归 image、无图归 text，卡片 title 不入 title。"""
    card = {
        "type": "23", "object_type": "webpage",
        "page_title": "……成为SVIP7", "title": "",
        "page_url": "https://new.vip.weibo.cn/growthtask/home", "cleaned": True,
    }
    # 无图 → text
    m = weibo._map_mblog(_mblog(page_info=card, pics=None), "1")
    assert m["type"] == "text"
    assert m["title"] in (None, "")     # 推广卡 title 不入库
    # 有图 → image
    m2 = weibo._map_mblog(_mblog(page_info=card, pic_ids=["px"], pics=None), "1")
    assert m2["type"] == "image"


def test_map_mblog_article_page_type():
    """微博头条文章形态（page_info.type=article，实测出现时自动归位）。"""
    art = weibo._map_mblog(_mblog(page_info={"type": "article", "title": "头条文章"}), "1")
    assert art["type"] == "article"


# ── HTTP 接口（PC ajax，httpx mock） ─────────────────────────────────

def _user_json():
    return {"ok": 1, "data": {"user": {
        "id": 3669102477, "screen_name": "鞠婧祎",
        "profile_image_url": "https://tvax1.sinaimg.cn/face.jpg",
        "avatar_hd": "https://tvax1.sinaimg.cn/hd.jpg",
        "description": "演员、歌手",
        "followers_count": 12345678, "statuses_count": 999,
    }}}


def _list_json():
    return {"ok": 1, "data": {
        "list": [_mblog(), {"type": "foo"}],   # 第二条无 id → 跳过
        "since_id": "123456",
    }}


def test_weibo_fetch_user_info():
    def handler(request):
        assert "ajax/profile/info" in str(request.url)
        assert "uid=3669102477" in str(request.url)
        assert request.headers.get("referer", "").startswith("https://weibo.com/u/3669102477")
        return httpx.Response(200, json=_user_json())

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await weibo.fetcher.fetch_user_info("3669102477", client=c)

    info = asyncio.run(run())
    assert info is not None
    assert info["name"] == "鞠婧祎"
    assert info["followers_count"] == 12345678
    assert info["sign"] == "演员、歌手"
    assert info["avatar"].endswith("hd.jpg")        # 高清优先


def test_weibo_fetch_post_page():
    def handler(request):
        assert "ajax/statuses/mymblog" in str(request.url)
        assert "uid=3669102477" in str(request.url)
        return httpx.Response(200, json=_list_json())

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await weibo.fetcher.fetch_post_page("3669102477", 1, client=c)

    page = asyncio.run(run())
    assert page is not None
    assert page["has_more"] is True
    assert len(page["items"]) == 1
    assert page["items"][0]["platform_post_id"] == "5099666961200194"


def test_weibo_fetch_user_info_rate_limited():
    from app.services.fetcher import clear_rate_limit, was_rate_limited

    def handler(request):
        return httpx.Response(418, text="rate limited")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            res = await weibo.fetcher.fetch_user_info("1", client=c)
            return res, was_rate_limited()

    clear_rate_limit()
    res, rl = asyncio.run(run())
    assert res is None
    assert rl is True
    clear_rate_limit()


def test_weibo_enrich_long_text_via_extend(monkeypatch):
    """长文补全走 m 站 statuses/extend（PC show 截断无全文，实测 extend 可用）。"""
    monkeypatch.setattr(
        weibo.weibo_auth_manager, "cookie",
        getattr(weibo.weibo_auth_manager, "cookie", "") or "", raising=False)

    def handler(request):
        assert "m.weibo.cn/statuses/extend" in str(request.url)
        return httpx.Response(200, json={
            "ok": 1, "data": {"longTextContent": "这是<b>全文</b>内容，比截断版长得多。"},
        })

    item = {
        "body_json": '{"text": "截断的..."}', "summary": "截断的...",
        "raw_json": json.dumps({"isLongText": True, "id": "5150690590857162"}),
    }

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            requested = await weibo.fetcher.enrich(item, client=c)
            return requested

    assert asyncio.run(run()) is True
    body = json.loads(item["body_json"])
    assert body["text"] == "这是全文内容，比截断版长得多。"
    assert item["summary"].startswith("这是全文内容")


def test_weibo_enrich_skips_non_long_text():
    """非长文不发请求（enrich 返回 False）。"""
    item = {"body_json": "{}", "summary": "", "raw_json": json.dumps({"isLongText": False, "id": "1"})}

    async def run():
        class _NoReq:
            def __enter__(self):
                raise AssertionError("非长文不应发起请求")

            def __exit__(self, *a):
                return False
        # 传一个伪 client，只要 enrich 发起请求就会失败
        return await weibo.fetcher.enrich(item, client=object())

    assert asyncio.run(run()) is False


def test_weibo_fetch_post_page_msg_rate_limited():
    from app.services.fetcher import clear_rate_limit, was_rate_limited

    def handler(request):
        return httpx.Response(200, json={"ok": 0, "msg": "请求过于频繁，请稍后再试"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            res = await weibo.fetcher.fetch_post_page("1", 1, client=c)
            return res, was_rate_limited()

    clear_rate_limit()
    res, rl = asyncio.run(run())
    assert res is None
    assert rl is True
    clear_rate_limit()


# ── P9-2（v0.9.6）：平台自动发帖单列 type='system' ────────────────────

def _sys_mblog(text: str, **extra) -> dict:
    m = {"id": "1", "idstr": "1", "text": text,
         "created_at": "Wed Sep 09 09:32:24 +0800 2026",
         "user": {"screen_name": "V"},
         "attitudes_count": 0, "comments_count": 0, "reposts_count": 0}
    m.update(extra)
    return m


def test_weibo_system_autopost_type():
    """微博有、B 站没有的一类内容（会员升级/签到/平台推广）单列 system；
    规则保守——真人发言里出现「会员/签到」等词不能误判。"""
    assert weibo._map_mblog(_sys_mblog("恭喜你升级为微博会员VIP7"), "1")["type"] == "system"
    assert weibo._map_mblog(_sys_mblog("今天已连续签到 30 天"), "1")["type"] == "system"
    assert weibo._map_mblog(_sys_mblog("我的2025年度报告出炉啦"), "1")["type"] == "system"
    assert weibo._map_mblog(_sys_mblog("获得会员购好物，哔哩哔哩"), "1")["type"] == "system"
    assert weibo._map_mblog(_sys_mblog("广告文案", isAd=True), "1")["type"] == "system"

    assert weibo._map_mblog(_sys_mblog("今天直播签到送周边！"), "1")["type"] == "text"
    assert weibo._map_mblog(_sys_mblog("谢谢大家的会员！"), "1")["type"] == "text"
    assert weibo._map_mblog(_sys_mblog("晚点开播，先吃个饭"), "1")["type"] == "text"


def test_weibo_system_wins_over_media():
    """system 判定优先于媒体分类：平台自动帖即使带图也还是自动帖（不可混进「图文」）。"""
    m = _sys_mblog("恭喜你升级为微博会员", pic_ids=["pid1"],
                   pic_infos={"pid1": {"large": {"url": "https://wx1.sinaimg.cn/large/pid1.jpg"}}})
    assert weibo._map_mblog(m, "1")["type"] == "system"


# ── 通用单流循环（增量遇已入库即停） ─────────────────────────────────────

def _post_item(pid: str) -> dict:
    return {
        "platform": "weibo", "platform_uid": "123", "platform_post_id": pid,
        "type": "text", "title": None, "summary": "", "cover_url": None,
        "permalink": "", "body_json": "{}", "stats_json": "{}",
        "published_at": None, "raw_json": "{}",
    }


class _FakePF:
    platform = "weibo"

    def __init__(self, pages):
        self.pages = pages

    async def fetch_post_page(self, uid, page, client=None):
        return self.pages[page - 1] if page <= len(self.pages) else {"items": [], "has_more": False}

    async def enrich(self, item, client=None):
        return False


def test_platform_posts_incremental_stops_on_existing(monkeypatch, db):
    """增量模式（v0.9.4 调整为「整页扫完再停」）：
    第一页 = [OLD(已入库), NEW1(新)] → NEW1 入库，整页扫完命中已入库即收工，
    不再请求第二页。"""
    from app.services import scheduler as sch

    db.add(PostModel(platform="weibo", platform_uid="123",
                     platform_post_id="OLD", type="text"))
    db.add(PostModel(platform="weibo", platform_uid="123",
                     platform_post_id="OLD2", type="text"))
    db.commit()

    pages = [
        {"items": [_post_item("OLD"), _post_item("NEW1")], "has_more": True},
        {"items": [_post_item("OLD2"), _post_item("NEW2")], "has_more": True},
        {"items": [_post_item("NEVER")], "has_more": False},
    ]
    calls = {"n": 0}
    pf = _FakePF(pages)
    orig = pf.fetch_post_page

    async def counting(uid, page, client=None):
        calls["n"] += 1
        return await orig(uid, page, client)

    pf.fetch_post_page = counting
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        return await sch._fetch_platform_posts(pf, "123", 10, db, stop_on_existing=True)

    r = asyncio.run(run())
    assert calls["n"] == 1                  # 第一页扫完即停，第二页零请求
    assert r.stopped_early is True
    assert r.stop_reason == "stopped_early"
    assert r.stop_existing_pid == "OLD"
    assert r.stored == 1                    # 仅 NEW1 入库
    assert db.query(PostModel).filter(
        PostModel.platform_post_id == "NEW2").count() == 0


def test_platform_posts_pinned_head_does_not_stop(monkeypatch, db):
    """回归（2026-09-09 用户反馈「更新动态后微博抓不到新帖」）：

    微博 mymblog 把**多条置顶帖**排到流首且时间顺序打乱（实测七海两条 isTop=1，
    其后才是当天的新帖）。旧实现「遇到第二条已入库帖就 break」→ 整页新帖全漏。
    现在置顶帖不参与停止判定、且整页扫完再停：新帖全部入库。"""
    from app.services import scheduler as sch

    db.add_all([
        PostModel(platform="weibo", platform_uid="123",
                  platform_post_id="PIN1", type="text"),
        PostModel(platform="weibo", platform_uid="123",
                  platform_post_id="PIN2", type="text"),
        PostModel(platform="weibo", platform_uid="123",
                  platform_post_id="OLD", type="text"),
    ])
    db.commit()

    pages = [
        {"items": [_post_item("PIN1"), _post_item("PIN2"),
                   _post_item("FRESH1"), _post_item("FRESH2")],
         "has_more": True, "pinned_ids": ["PIN1", "PIN2"]},
        {"items": [_post_item("OLD")], "has_more": True, "pinned_ids": []},
        {"items": [_post_item("NEVER")], "has_more": False},
    ]
    calls = {"n": 0}
    pf = _FakePF(pages)
    orig = pf.fetch_post_page

    async def counting(uid, page, client=None):
        calls["n"] += 1
        return await orig(uid, page, client)

    pf.fetch_post_page = counting
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        return await sch._fetch_platform_posts(pf, "123", 10, db, stop_on_existing=True)

    r = asyncio.run(run())
    assert r.stored == 2                    # 两条新帖都入库（旧实现 0 条）
    assert calls["n"] == 2                  # 第一页只有置顶帖 → 翻到第二页才停
    assert r.stopped_early is True
    assert r.stop_existing_pid == "OLD"


def test_platform_posts_archived_boundary(monkeypatch, db):
    """整页已归档 → archived_boundary 停止（与 B 站归档边界语义一致）。"""
    from app.services import scheduler as sch
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    db.add_all([
        PostModel(platform="weibo", platform_uid="123", platform_post_id="ARCH1",
                  type="text", published_at=now - timedelta(days=60), is_archived=True),
        PostModel(platform="weibo", platform_uid="123", platform_post_id="NEW0",
                  type="text", published_at=now, is_archived=False),
    ])
    db.commit()

    pages = [
        {"items": [_post_item("NEW1")], "has_more": True},
        {"items": [_post_item("ARCH1")], "has_more": True},
    ]
    pf = _FakePF(pages)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    r = asyncio.run(sch._fetch_platform_posts(pf, "123", 10, db))
    assert r.archived_stop is True
    assert r.stop_reason == "archived_boundary"
    assert r.stored == 1


# ── 平台分发 ─────────────────────────────────────────────────────────

def test_fetch_posts_for_account_dispatches_weibo(monkeypatch, db):
    from app.services import scheduler as sch

    captured = {}

    class PF:
        platform = "weibo"

        async def fetch_post_page(self, uid, page, client=None):
            captured["uid"] = uid
            return {"items": [], "has_more": False}

        async def enrich(self, item, client=None):
            return False

    monkeypatch.setitem(registry._REGISTRY, "weibo", PF())
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    acc = Account(vtuber_id=1, platform="weibo", platform_uid="3669102477")
    db.add(acc)
    db.commit()

    r = asyncio.run(sch._fetch_posts_for_account(acc, -1, -1, db))
    assert captured["uid"] == "3669102477"
    assert r.stop_reason == "done"


def test_fetch_posts_for_account_unknown_platform(db):
    from app.services import scheduler as sch

    acc = Account(vtuber_id=1, platform="xiaohongshu", platform_uid="123")
    db.add(acc)
    db.commit()
    r = asyncio.run(sch._fetch_posts_for_account(acc, -1, -1, db))
    assert r.stop_reason == "error"
    assert "不支持的平台" in (r.error or "")
