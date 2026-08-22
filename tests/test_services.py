# -*- coding: utf-8 -*-
"""修复项单元测试（devlog/013 + 015）：
- P2 风控状态 ContextVar 任务隔离
- P3 版本号同步
- P4 动态类型映射（含 MUSIC）
- P5a 头像扩展名推导
- P5c CORS 凭据规范
- importer 可注入会话 + 去重
- WBI 混钥/签名确定性
- v0.4.x 帖子数据修复：发布时间（pub_ts/中文格式）、repost origin、
  直播预约提取、Delta 富文本、图片代理端点
"""
import asyncio
import hashlib
import urllib.parse
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base
from app.models.vtuber import VTuber, Account, Post as PostModel
from app.repositories.vtuber_repo import PostRepo
from app.services.fetcher import (
    _detect_rate_limit, _map_dynamic_type,
    _parse_pub_time, _parse_dynamic_pub_time,
    _extract_origin, _extract_reservation,
    _is_delta_content, _delta_to_plain_text, _is_live_rcmd,
    _normalize_stats, _archive_stats, _archive_dynamic_title,
    was_rate_limited, rate_limit_info, clear_rate_limit,
)
from app.routers import img_proxy
from app.services.importer import import_from_file
from app.services.scheduler import _avatar_ext
from app.services.wbi import get_mixin_key, encrypt_wbi, MIXIN_KEY_ENC_TAB


# ── P2：风控状态任务隔离 ──────────────────────────────────────────────

def test_rate_limit_visible_in_same_task():
    async def run():
        clear_rate_limit()
        assert was_rate_limited() is False
        _detect_rate_limit(412, None)
        return was_rate_limited(), rate_limit_info()

    flag, info = asyncio.run(run())
    assert flag is True
    assert "412" in info


def test_rate_limit_isolated_between_tasks():
    """并行任务互不污染：触发风控的任务不影响同时运行的观察任务。"""
    async def trigger():
        clear_rate_limit()
        _detect_rate_limit(200, {"code": -412, "message": "请求过于频繁"})
        return was_rate_limited(), rate_limit_info()

    async def observer():
        return was_rate_limited()

    async def main():
        t_trigger = asyncio.create_task(trigger())
        t_observer = asyncio.create_task(observer())
        triggered = await t_trigger
        observed = await t_observer
        return triggered, observed

    (flag, info), observed = asyncio.run(main())
    assert flag is True
    assert "-412" in info
    assert observed is False


def test_rate_limit_clear_resets_context():
    async def run():
        _detect_rate_limit(200, {"code": -509, "message": "风控"})
        clear_rate_limit()
        return was_rate_limited(), rate_limit_info()

    flag, info = asyncio.run(run())
    assert flag is False
    assert info == ""


# ── P3：版本号 ────────────────────────────────────────────────────────

def test_version_synced_with_devlog():
    assert settings.VERSION == "0.3.1"


# ── P4：动态类型映射 ──────────────────────────────────────────────────

def test_map_dynamic_type_music():
    assert _map_dynamic_type("DYNAMIC_TYPE_MUSIC") == "music"
    # major.type 反推兜底
    assert _map_dynamic_type("", "MAJOR_TYPE_MUSIC") == "music"


def test_map_dynamic_type_basics():
    assert _map_dynamic_type("DYNAMIC_TYPE_WORD") == "text"
    assert _map_dynamic_type("DYNAMIC_TYPE_DRAW") == "image"
    assert _map_dynamic_type("DYNAMIC_TYPE_ARTICLE") == "article"
    assert _map_dynamic_type("DYNAMIC_TYPE_FORWARD") == "repost"
    assert _map_dynamic_type("DYNAMIC_TYPE_LIVE_RCMD") == "live"
    # 拆分：投稿动态 → video_dynamic；视频投稿（arc/search 直设 "video"）不受影响
    assert _map_dynamic_type("DYNAMIC_TYPE_AV") == "video_dynamic"
    assert _map_dynamic_type("", "MAJOR_TYPE_ARCHIVE") == "video_dynamic"
    assert _map_dynamic_type("", "MAJOR_TYPE_COMMON") == "repost"
    # 未知类型 fallback：不再把大写枚举名原样入库
    assert _map_dynamic_type("SOME_FUTURE_TYPE") == "some_future_type"
    assert _map_dynamic_type("") == "unknown"


def test_archive_dynamic_title():
    from app.services.fetcher import _archive_dynamic_title
    major = {"type": "MAJOR_TYPE_ARCHIVE",
             "archive": {"title": "我的超长视频标题", "bvid": "BV1"}}
    # 有附言 → 附言前 20 字
    assert _archive_dynamic_title("今晚八点开播，记得来看呀！", major) == "今晚八点开播，记得来看呀！"
    long_comment = "一二三四五六七八九十一二三四五六七八九十多了就截断"
    assert _archive_dynamic_title(long_comment, major) == long_comment[:20]
    # 无附言 → 视频标题
    assert _archive_dynamic_title("", major) == "我的超长视频标题"
    assert _archive_dynamic_title("   ", major) == "我的超长视频标题"


# ── P5a：头像扩展名 ───────────────────────────────────────────────────

def test_avatar_ext():
    assert _avatar_ext("https://i0.hdslb.com/bfs/face/a1c2.jpg") == ".jpg"
    assert _avatar_ext("https://i0.hdslb.com/bfs/face/x.PNG?x=1") == ".png"
    assert _avatar_ext("https://i0.hdslb.com/bfs/face/y.webp") == ".webp"
    assert _avatar_ext("https://i0.hdslb.com/bfs/face/z.gif") == ".gif"
    assert _avatar_ext("https://i0.hdslb.com/bfs/face/noext") == ".jpg"


# ── P5c：CORS 凭据规范 ────────────────────────────────────────────────

def test_cors_credentials_spec_compliant():
    from fastapi.middleware.cors import CORSMiddleware
    from app.main import app
    cors = next(m for m in app.user_middleware if m.cls is CORSMiddleware)
    opts = cors.kwargs
    if opts["allow_origins"] == ["*"]:
        assert opts["allow_credentials"] is False
    else:
        assert opts["allow_credentials"] is True


# ── importer：可注入会话 + 去重 ────────────────────────────────────────

@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def test_importer_flag_filtering_and_dedup(db):
    import os
    import tempfile
    from pathlib import Path as P

    # 沙箱限制：不用 pytest tmp_path（%TEMP% 下可能无权限），改用工作区内临时文件
    fd, name = tempfile.mkstemp(suffix=".csv", prefix="import_test_",
                                dir=str(P(__file__).parent))
    os.close(fd)
    csv_file = P(name)
    try:
        csv_file.write_text(
            "flag,vtuber_name,platform,platform_uid,follower\n"
            "1,星瞳official,bilibili,401315430,100\n"
            "0,Hanser,bilibili,11073,200\n"
            "1,星瞳official,bilibili,401315430,100\n"
            "1,七海Nana7mi,bilibili,434334701,300\n",
            encoding="utf-8",
        )
        r1 = import_from_file(str(csv_file), db=db)
        assert r1["created"] == 2        # 两个 flag=1 的唯一账号
        assert r1["skipped"] == 2        # flag=0 行 + 重复行
        assert db.query(VTuber).count() == 2
        assert db.query(Account).count() == 2

        # 二次导入：全部去重跳过
        r2 = import_from_file(str(csv_file), db=db)
        assert r2["created"] == 0
        assert r2["skipped"] == 4
    finally:
        csv_file.unlink(missing_ok=True)


def test_importer_missing_file_no_session_leak():
    r = import_from_file("__definitely_not_exists__.csv")
    assert r["created"] == 0
    assert r["errors"]


# ── WBI：混钥与签名确定性 ─────────────────────────────────────────────

def test_get_mixin_key_deterministic():
    img_key = "7cd084941338484aae1ad9425b84077c"
    sub_key = "4932caff0ff746eab6f01bf08b70ac45"
    expected = "".join((img_key + sub_key)[i] for i in MIXIN_KEY_ENC_TAB)[:32]
    assert get_mixin_key(img_key, sub_key) == expected
    assert len(expected) == 32


def test_encrypt_wbi_deterministic(monkeypatch):
    monkeypatch.setattr("time.time", lambda: 1700000000)
    mixin = "abcdefghijklmnopqrstuvwxyz012345"
    digest = encrypt_wbi({"mid": "123"}, mixin)
    sorted_params = sorted({"mid": "123", "wts": 1700000000}.items())
    query = urllib.parse.urlencode(sorted_params)
    assert digest == hashlib.md5((query + mixin).encode("utf-8")).hexdigest()


# ── v0.4.x：发布时间解析 ───────────────────────────────────────────────

def test_parse_pub_time_chinese_formats():
    # 修复：此前 '2025年04月21日' 无法解析 → published_at 大量为空
    assert _parse_pub_time("2025年04月21日") == datetime(2025, 4, 21, tzinfo=timezone.utc)
    assert _parse_pub_time("2025年04月21日 08:30") == datetime(2025, 4, 21, 8, 30, tzinfo=timezone.utc)
    assert _parse_pub_time("2024-01-01 12:00:00") == datetime(2024, 1, 1, 12, 0, tzinfo=timezone.utc)
    # 无年份格式无法可靠解析（应走 pub_ts 路径）
    assert _parse_pub_time("08月09日") is None


def test_parse_dynamic_pub_time_prefers_pub_ts():
    # 修复：优先 pub_ts（unix 秒级），pub_time 仅兜底
    author = {"pub_ts": "1785655807", "pub_time": "08月02日"}
    assert _parse_dynamic_pub_time(author) == datetime.fromtimestamp(1785655807, tz=timezone.utc)
    author2 = {"pub_ts": "", "pub_time": "2025年04月21日"}
    assert _parse_dynamic_pub_time(author2) == datetime(2025, 4, 21, tzinfo=timezone.utc)
    assert _parse_dynamic_pub_time({}) is None


# ── v0.4.x：转发动态原文提取 ───────────────────────────────────────────

FORWARD_ITEM = {
    "id_str": "FWD1",
    "type": "DYNAMIC_TYPE_FORWARD",
    "modules": {
        "module_dynamic": {
            "desc": {"text": "晚上8点哦"},
            "major": None,
        }
    },
    "orig": {
        "id_str": "ORIG1",
        "type": "DYNAMIC_TYPE_DRAW",
        "modules": {
            "module_dynamic": {
                "major": {
                    "type": "MAJOR_TYPE_DRAW",
                    "draw": {"items": [{"src": "http://i0.hdslb.com/bfs/new_dyn/a.png", "width": "100", "height": "200"}]},
                }
            }
        },
    },
}


def test_extract_origin_from_forward():
    origin = _extract_origin(FORWARD_ITEM)
    assert origin is not None
    assert origin["type"] == "image"
    assert len(origin["images"]) == 1
    assert origin["images"][0]["url"] == "http://i0.hdslb.com/bfs/new_dyn/a.png"
    assert origin["permalink"].startswith("https://t.bilibili.com/")


def test_extract_origin_returns_none_without_orig():
    assert _extract_origin({"id_str": "X", "modules": {"module_dynamic": {"major": None}}}) is None


# ── v0.4.x：直播预约提取 ───────────────────────────────────────────────

RESERVE_MD = {
    "additional": {
        "reserve": {
            "status": 2,
            "reserve_total": 49001,
            "desc1": {"style": 0, "text": "08-23 19:00 直播"},
            "desc2": {"style": 0, "text": "明前奶绿 的直播"},
            "button": {
                "status": 1,
                "type": 2,
                "check": {"icon_url": "", "text": "已预约"},
                "uncheck": {"icon_url": "", "text": "预约"},
            },
        }
    }
}


def test_extract_reservation():
    res = _extract_reservation(RESERVE_MD)
    assert res is not None
    assert res["status"] == 2
    assert res["button_text"] == "已预约"      # status==2 → check.text
    assert res["desc1"] == "08-23 19:00 直播"
    assert res["reserve_total"] == 49001
    assert _extract_reservation({}) is None


# ── v0.4.x：Quill Delta 富文本 ─────────────────────────────────────────

DELTA = '{"ops":[{"insert":"大家好\\n"},{"attributes":{"header":2,"align":"center"},"insert":"\\n"},{"insert":"第一段正文\\t带缩进\\n"}]}'


def test_is_delta_content():
    assert _is_delta_content('{"ops":[]}') is True
    assert _is_delta_content("   {\"ops\":[{\"insert\":\"x\"}]}") is True
    assert _is_delta_content("<p>html</p>") is False


def test_delta_to_plain_text():
    assert _delta_to_plain_text(DELTA) == "大家好\n\n第一段正文\t带缩进\n"


# ── v0.4.x：直播开播动态忽略 ───────────────────────────────────────────

def test_is_live_rcmd():
    # raw type 命中
    assert _is_live_rcmd({"type": "DYNAMIC_TYPE_LIVE_RCMD"}) is True
    # major type 命中
    assert _is_live_rcmd({
        "type": "DYNAMIC_TYPE_FORWARD",
        "modules": {"module_dynamic": {"major": {"type": "MAJOR_TYPE_LIVE_RCMD"}}},
    }) is True
    # 正常动态不误杀
    assert _is_live_rcmd({
        "type": "DYNAMIC_TYPE_WORD",
        "modules": {"module_dynamic": {"major": {"type": "MAJOR_TYPE_OPUS"}}},
    }) is False


# ── v0.4.x：图片代理端点 ───────────────────────────────────────────────

def test_img_proxy_validate_url():
    assert img_proxy._validate_url("https://i0.hdslb.com/bfs/new_dyn/x.png") == "https://i0.hdslb.com/bfs/new_dyn/x.png"
    with pytest.raises(Exception):
        img_proxy._validate_url("file:///etc/passwd")
    with pytest.raises(Exception):
        img_proxy._validate_url("https://evil.com/x.png")


def test_img_proxy_endpoint_with_cache(monkeypatch):
    import pathlib
    import shutil

    # 沙箱限制：不用 pytest tmp_path（%TEMP% 下可能无权限），改用工作区内临时目录
    cache_dir = pathlib.Path(__file__).parent / "_img_cache_test"
    shutil.rmtree(cache_dir, ignore_errors=True)
    monkeypatch.setattr(img_proxy, "CACHE_DIR", cache_dir)
    calls = {"n": 0}

    async def fake_fetch(url):
        calls["n"] += 1
        return b"FAKE-IMAGE-BYTES", "image/jpeg"

    monkeypatch.setattr(img_proxy, "fetch_remote", fake_fetch)
    from app.main import app
    client = TestClient(app)
    try:
        url = "https://i0.hdslb.com/bfs/new_dyn/fake.jpg"
        r1 = client.get("/img-proxy", params={"url": url})
        assert r1.status_code == 200
        assert r1.content == b"FAKE-IMAGE-BYTES"
        r2 = client.get("/img-proxy", params={"url": url})
        assert r2.status_code == 200
        assert calls["n"] == 1  # 第二次命中缓存，未回源
        # 非法主机被拒
        assert client.get("/img-proxy", params={"url": "https://evil.com/x.png"}).status_code == 403
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)


# ── v0.4.x：归档规则 + 归档边界停止（devlog/016） ──────────────────────

def test_archive_before_rule(db):
    now = datetime(2026, 8, 17, tzinfo=timezone.utc)
    db.add_all([
        PostModel(platform="bilibili", platform_uid="U", platform_post_id="OLD",
                  type="text", published_at=now - timedelta(days=60)),
        PostModel(platform="bilibili", platform_uid="U", platform_post_id="RECENT",
                  type="text", published_at=now - timedelta(days=5)),
        PostModel(platform="bilibili", platform_uid="U", platform_post_id="NULLT",
                  type="text", published_at=None),
        PostModel(platform="bilibili", platform_uid="U", platform_post_id="ALREADY",
                  type="text", published_at=now - timedelta(days=90), is_archived=True),
    ])
    db.commit()

    cutoff = now - timedelta(days=30)
    assert PostRepo(db).archive_before(cutoff) == 1  # 仅 OLD 从未归档 → 归档
    assert db.query(PostModel).filter(PostModel.platform_post_id == "OLD").one().is_archived is True
    assert db.query(PostModel).filter(PostModel.platform_post_id == "RECENT").one().is_archived is False
    assert db.query(PostModel).filter(PostModel.platform_post_id == "NULLT").one().is_archived is False
    assert db.query(PostModel).filter(PostModel.platform_post_id == "ALREADY").one().is_archived is True
    # 幂等
    assert PostRepo(db).archive_before(cutoff) == 0


def _post_item(pid: str) -> dict:
    return {
        "platform": "bilibili", "platform_uid": "123", "platform_post_id": pid,
        "type": "text", "title": "", "summary": "", "cover_url": None,
        "permalink": "", "body_json": "{}", "stats_json": "{}",
        "published_at": None, "raw_json": "{}",
    }


def test_fetch_posts_core_stops_at_archived_boundary(monkeypatch, db):
    """第二页整页已归档 → 停止翻页，不再请求第三页（归档帖不再遍历）"""
    from app.services import scheduler as sch

    now = datetime(2026, 8, 17, tzinfo=timezone.utc)
    db.add_all([
        PostModel(platform="bilibili", platform_uid="123", platform_post_id="ARCH1",
                  type="text", published_at=now - timedelta(days=60), is_archived=True),
        PostModel(platform="bilibili", platform_uid="123", platform_post_id="NEW0",
                  type="text", published_at=now, is_archived=False),
    ])
    db.commit()

    pages = [
        {"items": [_post_item("NEW1")], "has_more": True, "next_offset": "p2"},
        {"items": [_post_item("ARCH1")], "has_more": True, "next_offset": "p3"},
    ]
    calls = {"n": 0}

    async def fake_dynamics(mid, offset="", client=None):
        calls["n"] += 1
        return pages[calls["n"] - 1] if calls["n"] <= 2 else None

    async def fake_sleep(_seconds):
        return None  # 打桩翻页 sleep，加速测试

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        r = await sch._fetch_posts_core(123, 0, 5, db, include_videos=False)
        return r, calls["n"]

    r, n = asyncio.run(run())
    assert n == 2                      # 未请求第 3 页
    assert r.archived_stop is True
    assert r.stored == 1               # 仅新帖 NEW1 入库
    assert db.query(PostModel).filter(PostModel.platform_post_id == "NEW1").count() == 1
    # 归档帖未重复入库
    assert db.query(PostModel).filter(PostModel.platform_post_id == "ARCH1").count() == 1


# ── v0.4.x：统计键名归一化与投稿动态统计（devlog/018） ──────────────────

def test_normalize_stats():
    # play → view（视频投稿列表）、reply → comment（视频详情）
    assert _normalize_stats({"play": 100, "comment": 5}) == {"view": 100, "comment": 5}
    assert _normalize_stats({"view": 1, "reply": 2}) == {"view": 1, "comment": 2}
    # 已有正确键名则不动
    assert _normalize_stats({"view": 3, "comment": 4}) == {"view": 3, "comment": 4}


def test_archive_stats():
    major = {
        "type": "MAJOR_TYPE_ARCHIVE",
        "archive": {"stat": {"view": 100, "like": 10, "coin": 5, "favorite": 3,
                             "reply": 7, "share": 2, "danmaku": 9}},
    }
    dyn_stat = {"forward": {"count": 8}, "like": {"count": 11}, "comment": {"count": 6}}
    stats = _archive_stats(major, dyn_stat)
    assert stats["view"] == 100
    assert stats["comment"] == 7          # reply → comment
    assert stats["forward"] == 8
    assert stats["dyn_like"] == 11
    assert stats["dyn_comment"] == 6
    # 无 archive.stat 时全为 0 兜底
    empty = _archive_stats({"type": "MAJOR_TYPE_ARCHIVE", "archive": {}}, {})
    assert empty["view"] == 0


# ── v0.4.x：头像缺失补下（devlog/019） ─────────────────────────────────

def test_needs_avatar_download():
    from app.services.scheduler import _needs_avatar_download
    acc = Account(platform="bilibili", platform_uid="123", avatar_url="https://a.jpg")
    # URL 变化 → 下载
    assert _needs_avatar_download(acc, "https://b.jpg", True) is True
    # URL 未变 + 文件存在 → 不下载
    assert _needs_avatar_download(acc, "https://a.jpg", True) is False
    # URL 未变 + 文件缺失 → 补下（核心修复）
    assert _needs_avatar_download(acc, "https://a.jpg", False) is True
    # 无新头像 → 不下载
    assert _needs_avatar_download(acc, None, False) is False


def test_avatar_missing():
    from pathlib import Path as P
    from app.services.scheduler import _avatar_missing

    # 无 avatar_path → 缺失
    acc1 = Account(platform="bilibili", platform_uid="1", avatar_path=None)
    assert _avatar_missing(acc1) is True

    # avatar_path 指向不存在的文件 → 缺失
    acc2 = Account(platform="bilibili", platform_uid="2",
                   avatar_path="static/avatars/__never_exists__.jpg")
    assert _avatar_missing(acc2) is True

    # avatar_path 指向真实存在的文件 → 不缺失
    acc3 = Account(platform="bilibili", platform_uid="3",
                   avatar_path="static/avatars/__exists_test__.png")
    real = P(__file__).parent.parent / "static" / "avatars" / "__exists_test__.png"
    real.parent.mkdir(parents=True, exist_ok=True)
    real.write_bytes(b"x")
    try:
        assert _avatar_missing(acc3) is False
    finally:
        real.unlink(missing_ok=True)


def test_safe_json_parse_fallback():
    """回归（用户实测 2026-08-22）：更新动态合并视频统计时
    _safe_json_parse 被以双参调用但签名只有单参 → TypeError 中断整个任务。
    修复：签名支持可选 fallback；并保证非 dict 的合法 JSON 也回退。"""
    from app.services.scheduler import _safe_json_parse

    # 双参调用形态（视频统计合并 / 专栏 delta 补全）
    assert _safe_json_parse('{"view":5}', {}) == {"view": 5}
    assert _safe_json_parse(None, {"a": 1}) == {"a": 1}
    assert _safe_json_parse("not-json", {}) == {}

    # 单参调用形态（历史代码路径）兼容
    assert _safe_json_parse('{"like":2}') == {"like": 2}
    assert _safe_json_parse("") == {}
    assert _safe_json_parse(None) == {}
    assert _safe_json_parse("bad") == {}

    # 非 dict 的合法 JSON（如 "[]" / "3"）必须回退，避免 ** 展开崩溃
    assert _safe_json_parse("[1,2]", {}) == {}
    assert _safe_json_parse('"text"', {}) == {}


def test_fetch_posts_core_stops_on_existing(monkeypatch, db):
    """v0.4.7 增量模式：动态流遇到库中已有帖子即停（首页首条豁免防置顶误停）。
    场景：库中已有 OLD1；feed 第一页 = [OLD1(置顶位,豁免), NEW1(新), OLD1?不重复]
    → NEW1 入库；第二页首条 OLD2 已存在 → 立即停止，不再请求第三页。"""
    from app.services import scheduler as sch

    db.add_all([
        PostModel(platform="bilibili", platform_uid="123", platform_post_id="OLD1",
                  type="text", published_at=None, is_archived=False),
        PostModel(platform="bilibili", platform_uid="123", platform_post_id="OLD2",
                  type="text", published_at=None, is_archived=False),
    ])
    db.commit()

    pages = [
        {"items": [_post_item("OLD1"), _post_item("NEW1")], "has_more": True,
         "next_offset": "p2"},
        {"items": [_post_item("OLD2"), _post_item("NEW2")], "has_more": True,
         "next_offset": "p3"},
        {"items": [_post_item("NEVER")], "has_more": False},
    ]
    calls = {"n": 0}

    async def fake_dynamics(mid, offset="", client=None):
        calls["n"] += 1
        return pages[calls["n"] - 1] if calls["n"] <= 3 else None

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        r = await sch._fetch_posts_core(123, 0, 10, db,
                                        include_videos=False, stop_on_existing=True)
        return r, calls["n"]

    r, n = asyncio.run(run())
    assert r.stopped_early is True       # 第二页首条 OLD2 命中即停
    assert n == 2                        # 第三页零请求
    assert r.stored == 1                 # 仅第一页的 NEW1 入库（NEW2 未到达即停）
    assert db.query(PostModel).filter(
        PostModel.platform_post_id == "NEW2").count() == 0


def test_fetch_posts_core_stop_exempt_first_item(monkeypatch, db):
    """首页首条豁免：置顶旧帖在流首不触发停止，其后的新帖正常入库。"""
    from app.services import scheduler as sch

    db.add(PostModel(platform="bilibili", platform_uid="123",
                     platform_post_id="PIN", type="text"))
    db.commit()

    pages = [
        {"items": [_post_item("PIN"), _post_item("FRESH")], "has_more": False},
    ]
    calls = {"n": 0}

    async def fake_dynamics(mid, offset="", client=None):
        calls["n"] += 1
        return pages[0]

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        return await sch._fetch_posts_core(123, 0, 10, db,
                                           include_videos=False, stop_on_existing=True)

    r = asyncio.run(run())
    assert r.stopped_early is False      # FRESH 是新帖，未误停
    assert r.stored == 1
    assert calls["n"] == 1               # has_more=False 自然结束
