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
import json as _json
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base
from app.models.vtuber import VTuber, Account, Post as PostModel, AccountStatSnapshot
from app.repositories.vtuber_repo import PostRepo, AccountStatSnapshotRepo
from app.services import scheduler
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
    """版本号跨文件一致（docs/RELEASE.md §2 的同步点）。

    历史教训：这里曾写死 "0.8.0"，0.9.1 发布时忘了改 → 测试长期红着没人跑。
    改为比对真实文件，任何一处漏改都会在这里立刻炸。
    """
    import json
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    tauri = json.loads((root / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    pkg = json.loads((root / "frontend/package.json").read_text(encoding="utf-8"))
    cargo = (root / "frontend/src-tauri/Cargo.toml").read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.M)
    assert m, "Cargo.toml 未找到 version"
    assert settings.VERSION == tauri["version"] == pkg["version"] == m.group(1), (
        f"版本号不一致：config={settings.VERSION} tauri={tauri['version']} "
        f"package={pkg['version']} cargo={m.group(1)}"
    )


def test_healthz_first_run_flag(monkeypatch):
    """首启标记：/healthz 第一次返回 first_run=true 并落盘，之后恒为 false。

    前端据此自动弹出登录浮窗（用户 2026-09-08 需求）。
    注：不用 pytest 的 tmp_path —— 受限沙箱下系统临时目录不可写，改用工作区内目录。
    """
    import shutil
    from pathlib import Path

    from app import main as app_main

    tmp = Path(__file__).resolve().parent.parent / "_test_tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    try:
        marker = tmp / ".first-run-done"
        monkeypatch.setattr(app_main, "FIRST_RUN_MARKER", marker)
        client = TestClient(app_main.app)

        first = client.get("/healthz").json()
        assert first["ok"] is True
        assert first["first_run"] is True
        assert marker.exists(), "首次探活应写入标记文件"

        second = client.get("/healthz").json()
        assert second["first_run"] is False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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


def _post_item(pid: str, *, ptype: str = "text", body: dict | None = None) -> dict:
    return {
        "platform": "bilibili", "platform_uid": "123", "platform_post_id": pid,
        "type": ptype, "title": "", "summary": "", "cover_url": None,
        "permalink": "", "body_json": _json.dumps(body or {}, ensure_ascii=False),
        "stats_json": "{}", "published_at": None, "raw_json": "{}",
    }


def test_fetch_posts_core_absorbs_video_dynamic(db, monkeypatch):
    """P9-3（v0.9.6）：同 bvid 的「投稿动态」并入投稿帖——不重复入库，
    动态附言写进 video.note（用户口径：只保留一条 + 附注字段）。"""
    from app.services import scheduler as sch

    db.add(PostModel(platform="bilibili", platform_uid="123", platform_post_id="BV1xx",
                     type="video", title="投稿标题",
                     body_json=_json.dumps({"bvid": "BV1xx"})))
    db.commit()

    pages = [{"items": [
        _post_item("dyn-1", ptype="video_dynamic",
                   body={"bvid": "BV1xx", "text": "1P是切片，2P是合唱"}),
        _post_item("dyn-2", ptype="video_dynamic", body={"bvid": "BV1yy"}),  # 无同名投稿 → 正常入库
    ], "has_more": False, "pinned_ids": []}]

    async def fake_dynamics(mid, offset="", client=None):
        return pages[0]

    async def fake_videos(mid, page=1, page_size=30, client=None):
        return {"items": [], "total": 0}

    async def fake_sleep(_seconds):
        return None

    async def fake_video_detail(bvid, client=None):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr(sch, "fetch_bilibili_videos", fake_videos)
    monkeypatch.setattr(sch, "fetch_video_detail", fake_video_detail)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        return await sch._fetch_posts_core(123, 0, 10, db, include_videos=True)

    r = asyncio.run(run())
    assert r.note_merged == 1                     # dyn-1 被吸收
    assert db.query(PostModel).filter(
        PostModel.platform_post_id == "dyn-1").count() == 0
    assert db.query(PostModel).filter(
        PostModel.platform_post_id == "dyn-2").count() == 1
    video = db.query(PostModel).filter(PostModel.platform_post_id == "BV1xx").one()
    assert video.note == "1P是切片，2P是合唱"


def test_fetch_posts_core_keeps_note_when_video_has_one(db, monkeypatch):
    """已有附言不被后来的动态覆盖（作者改过附言时先到先得，避免反复改写）。"""
    from app.services import scheduler as sch

    db.add(PostModel(platform="bilibili", platform_uid="123", platform_post_id="BV1zz",
                     type="video", body_json=_json.dumps({"bvid": "BV1zz"}),
                     note="原附言"))
    db.commit()

    async def fake_dynamics(mid, offset="", client=None):
        return {"items": [_post_item("dyn-9", ptype="video_dynamic",
                                     body={"bvid": "BV1zz", "text": "新附言"})],
                "has_more": False, "pinned_ids": []}

    async def fake_videos(mid, page=1, page_size=30, client=None):
        return {"items": [], "total": 0}

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr(sch, "fetch_bilibili_videos", fake_videos)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    asyncio.run(sch._fetch_posts_core(123, 0, 10, db, include_videos=True))
    assert db.query(PostModel).filter(PostModel.platform_post_id == "BV1zz").one().note == "原附言"


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
    """v0.4.7 增量模式（v0.9.4 调整为「整页扫完再停」）：
    库中已有 OLD1/OLD2；第一页 = [OLD1(已入库), NEW1(新)] → NEW1 入库，
    整页扫完命中已入库 → 收工；NEW2 在下一页，不再请求。"""
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
    assert r.stopped_early is True       # 第一页含已入库帖 → 整页扫完即停
    assert r.stop_existing_pid == "OLD1"
    assert n == 1                        # 第二页零请求
    assert r.stored == 1                 # NEW1 入库
    assert db.query(PostModel).filter(
        PostModel.platform_post_id == "NEW2").count() == 0


def test_fetch_posts_core_pinned_does_not_stop_and_scans_whole_page(monkeypatch, db):
    """回归（2026-09-09 用户反馈「更新动态后抓不到新帖」）：置顶动态排在流首且
    可多条、时间顺序被打乱 —— 已入库的置顶帖**不能**触发增量停止，同页靠后的
    新帖必须照常入库；整页扫完仍无「已入库且非置顶」的帖子 → 继续下一页。"""
    from app.services import scheduler as sch

    db.add_all([
        PostModel(platform="bilibili", platform_uid="123", platform_post_id="PIN1",
                  type="text"),
        PostModel(platform="bilibili", platform_uid="123", platform_post_id="PIN2",
                  type="text"),
        PostModel(platform="bilibili", platform_uid="123", platform_post_id="OLD",
                  type="text"),
    ])
    db.commit()

    pages = [
        {"items": [_post_item("PIN1"), _post_item("PIN2"), _post_item("FRESH")],
         "has_more": True, "next_offset": "p2", "pinned_ids": ["PIN1", "PIN2"]},
        {"items": [_post_item("OLD"), _post_item("NEW2")], "has_more": True,
         "next_offset": "p3", "pinned_ids": []},
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
    assert r.stored == 2                     # FRESH + NEW2 都入库（旧实现只存到 NEW1 为止）
    assert n == 2                            # 第一页无「已入库非置顶」→ 翻到第二页才停
    assert r.stopped_early is True
    assert r.stop_existing_pid == "OLD"
    assert db.query(PostModel).filter(
        PostModel.platform_post_id == "FRESH").count() == 1
    assert db.query(PostModel).filter(
        PostModel.platform_post_id == "NEW2").count() == 1


def test_fetch_posts_core_stop_after_full_page(monkeypatch, db):
    """整页扫完再停：已入库帖之后的**同页**新帖也要入库（旧实现当场 break 会漏）。"""
    from app.services import scheduler as sch

    db.add(PostModel(platform="bilibili", platform_uid="123",
                     platform_post_id="OLD", type="text"))
    db.commit()

    pages = [
        {"items": [_post_item("OLD"), _post_item("FRESH_AFTER")],
         "has_more": False, "pinned_ids": []},
    ]

    async def fake_dynamics(mid, offset="", client=None):
        return pages[0]

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        return await sch._fetch_posts_core(123, 0, 10, db,
                                           include_videos=False, stop_on_existing=True)

    r = asyncio.run(run())
    assert r.stored == 1
    assert db.query(PostModel).filter(
        PostModel.platform_post_id == "FRESH_AFTER").count() == 1


def test_fetch_posts_core_pinned_only_page_continues(monkeypatch, db):
    """整页只有「已入库的置顶帖」→ 不停止，继续下一页（新帖可能都在后面）。"""
    from app.services import scheduler as sch

    db.add(PostModel(platform="bilibili", platform_uid="123",
                     platform_post_id="PIN", type="text"))
    db.commit()

    pages = [
        {"items": [_post_item("PIN")], "has_more": True, "next_offset": "p2",
         "pinned_ids": ["PIN"]},
        {"items": [_post_item("FRESH")], "has_more": False, "pinned_ids": []},
    ]
    calls = {"n": 0}

    async def fake_dynamics(mid, offset="", client=None):
        calls["n"] += 1
        return pages[calls["n"] - 1]

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        return await sch._fetch_posts_core(123, 0, 10, db,
                                           include_videos=False, stop_on_existing=True)

    r = asyncio.run(run())
    assert calls["n"] == 2               # 置顶帖不触发停止 → 翻到第二页
    assert r.stored == 1
    assert r.natural_end is True         # 第二页 has_more=False 自然结束


# ── 优化项：img_proxy SSRF 重定向加固 / 批量入库 / 跨平台删帖 ────────────

def test_img_proxy_reject_redirect_to_internal():
    """回归（SSRF）：302 跳到内网地址必须被拒（原实现 follow_redirects 直接跟随）。"""
    import httpx as httpx_mod
    from fastapi import HTTPException

    def handler(request):
        return httpx_mod.Response(302, headers={"location": "http://169.254.169.254/meta"})

    async def run():
        async with httpx_mod.AsyncClient(transport=httpx_mod.MockTransport(handler)) as c:
            with pytest.raises(HTTPException) as ei:
                await img_proxy.fetch_remote("https://i0.hdslb.com/bfs/x.png", client=c)
            assert ei.value.status_code == 403

    asyncio.run(run())


def test_img_proxy_follows_allowed_redirect():
    """同域（白名单内）重定向仍可用，且命中最终资源。"""
    import httpx as httpx_mod

    def handler(request):
        if request.url.path == "/a":
            return httpx_mod.Response(302, headers={"location": "/b.jpg"})
        return httpx_mod.Response(200, content=b"IMG", headers={"content-type": "image/jpeg"})

    async def run():
        async with httpx_mod.AsyncClient(transport=httpx_mod.MockTransport(handler)) as c:
            body, ctype = await img_proxy.fetch_remote("https://i0.hdslb.com/a", client=c)
            assert body == b"IMG"
            assert ctype == "image/jpeg"

    asyncio.run(run())


def test_img_proxy_referer_sinaimg():
    """防盗链：微博图床（sinaimg）请求必须带 weibo.com Referer，否则 403。"""
    import httpx as httpx_mod

    seen = {}

    def handler(request):
        seen["referer"] = request.headers.get("referer")
        return httpx_mod.Response(200, content=b"IMG", headers={"content-type": "image/jpeg"})

    async def run():
        async with httpx_mod.AsyncClient(transport=httpx_mod.MockTransport(handler)) as c:
            body, _ = await img_proxy.fetch_remote("https://wx1.sinaimg.cn/large/abc.jpg", client=c)
            return body

    assert asyncio.run(run()) == b"IMG"
    assert seen["referer"] == "https://weibo.com/"


def test_img_proxy_referer_hdslb():
    import httpx as httpx_mod

    seen = {}

    def handler(request):
        seen["referer"] = request.headers.get("referer")
        return httpx_mod.Response(200, content=b"IMG", headers={"content-type": "image/jpeg"})

    async def run():
        async with httpx_mod.AsyncClient(transport=httpx_mod.MockTransport(handler)) as c:
            await img_proxy.fetch_remote("https://i0.hdslb.com/bfs/a.jpg", client=c)

    asyncio.run(run())
    assert seen["referer"] == "https://www.bilibili.com/"


def test_img_proxy_referer_redirect_keeps_host():
    """防盗链在重定向后按新主机动态携带（微博图床 → weibo.com Referer）。"""
    import httpx as httpx_mod

    headers_seen = []

    def handler(request):
        headers_seen.append(request.headers.get("referer"))
        if request.url.path == "/a":
            return httpx_mod.Response(302, headers={"location": "/b.jpg"})
        return httpx_mod.Response(200, content=b"IMG", headers={"content-type": "image/jpeg"})

    async def run():
        async with httpx_mod.AsyncClient(transport=httpx_mod.MockTransport(handler)) as c:
            await img_proxy.fetch_remote("https://wx1.sinaimg.cn/a", client=c)

    asyncio.run(run())
    assert headers_seen == ["https://weibo.com/", "https://weibo.com/"]


def test_img_proxy_rejects_non_image_content_type():
    """text/html 不得作为图片代理结果回吐（防存储型 XSS）。"""
    import httpx as httpx_mod

    def handler(request):
        return httpx_mod.Response(200, content=b"<html>", headers={"content-type": "text/html"})

    async def run():
        async with httpx_mod.AsyncClient(transport=httpx_mod.MockTransport(handler)) as c:
            assert await img_proxy.fetch_remote("https://i0.hdslb.com/x.png", client=c) is None

    asyncio.run(run())


def test_img_proxy_rejects_oversized_body(monkeypatch):
    import httpx as httpx_mod

    monkeypatch.setattr(img_proxy, "_MAX_BODY", 100)

    def handler(request):
        return httpx_mod.Response(200, content=b"x" * 200, headers={"content-type": "image/jpeg"})

    async def run():
        async with httpx_mod.AsyncClient(transport=httpx_mod.MockTransport(handler)) as c:
            assert await img_proxy.fetch_remote("https://i0.hdslb.com/x.png", client=c) is None

    asyncio.run(run())


def test_fetch_posts_core_batch_commit(monkeypatch, db):
    """批量入库：120 条帖子分 3 批 commit，全部落库（跨会话可见）。"""
    from app.services import scheduler as sch

    n_items = 120
    videos = [_post_item(f"V{i:04d}") for i in range(n_items)]
    calls = {"n": 0}

    async def fake_videos(mid, page=1, client=None):
        calls["n"] += 1
        return {"items": videos, "total": len(videos)} if calls["n"] == 1 else {"items": [], "total": len(videos)}

    async def fake_sleep(_seconds):
        return None

    async def fake_dynamics(mid, offset="", client=None):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_videos", fake_videos)
    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        return await sch._fetch_posts_core(123, 1, 0, db, include_videos=True)

    r = asyncio.run(run())
    assert r.videos == n_items
    assert r.stored == n_items
    assert r.skipped == 0
    assert db.query(PostModel).filter(
        PostModel.platform == "bilibili", PostModel.platform_uid == "123"
    ).count() == n_items


def test_fetch_posts_core_batch_dedup_after_restart(monkeypatch, db):
    """批量入库幂等：第二次全量抓同一批帖子全部跳过（内存 existing_ids 去重）。"""
    from app.services import scheduler as sch

    videos = [_post_item("V0001"), _post_item("V0002")]
    calls = {"n": 0}

    async def fake_videos(mid, page=1, client=None):
        calls["n"] += 1
        return {"items": videos, "total": len(videos)}  # 每次都返回同一批：第二次应全部命中 existing_ids 去重

    async def fake_sleep(_seconds):
        return None

    async def fake_dynamics(mid, offset="", client=None):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_videos", fake_videos)
    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        await sch._fetch_posts_core(123, 1, 0, db, include_videos=True)
        return await sch._fetch_posts_core(123, 1, 0, db, include_videos=True)

    r = asyncio.run(run())
    assert r.stored == 0
    assert r.skipped == 2


def test_delete_by_platform_uids_platform_scoped(db):
    """解订阅删帖按 (platform, platform_uid) 过滤：跨平台同 UID 不误删。"""
    db.add_all([
        PostModel(platform="bilibili", platform_uid="123", platform_post_id="B1", type="text"),
        PostModel(platform="youtube", platform_uid="123", platform_post_id="Y1", type="text"),
    ])
    db.commit()
    n = PostRepo(db).delete_by_platform_uids([("bilibili", "123")])
    assert n == 1
    assert db.query(PostModel).filter(PostModel.platform == "youtube").count() == 1


def test_async_fetch_vtuber_relinks_session_after_cooldown(monkeypatch):
    """回归（高）：风控冷却后必须重查 accounts——旧会话已关闭，沿用旧列表里的
    detached 对象会导致恢复后的更新静默丢失（async_fetch_and_update 有重查，
    原 async_fetch_vtuber 遗漏）。"""
    from app.services import scheduler as sch
    from app.services.fetcher import _rate_limit_ctx

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)

    session_a = Maker()
    v = VTuber(name="单V")
    session_a.add(v)
    session_a.commit()
    session_a.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="999",
                          display_name="旧名"))
    session_a.commit()
    vid = v.id  # 会话关闭前取出 id（commit 后属性会 expire，关闭后读取即报 detached）
    session_a.close()

    # 每次调用返回全新会话（模拟函数内部 reopen）
    monkeypatch.setattr(sch, "SessionLocal", Maker)

    state = {"calls": 0}

    async def fake_fetch(acc, _db, client=None, *, pending_avatar=None):
        state["calls"] += 1
        if state["calls"] == 1:
            _rate_limit_ctx.set((True, "code=-412"))
            return False
        acc.display_name = "新名"   # 若 acc 来自已关闭会话，此赋值不会落库
        return True

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(sch, "_fetch_one_account", fake_fetch)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    r = asyncio.run(sch.async_fetch_vtuber(vid))
    assert state["calls"] == 2           # 冷却后继续抓取
    assert r.success == 1

    check = Maker()
    try:
        acc = check.query(Account).filter(Account.platform_uid == "999").one()
        assert acc.display_name == "新名"  # 冷却后重查的账号更新已落库
    finally:
        check.close()


# ── 收录提速（v0.9.4）：按 id 精确抓取 + 无末尾空转 + 头像延后 ─────────────

def _mk_vtuber_with_accounts(Maker, uids: list[str]) -> tuple[int, list[int]]:
    """建 1 个 V + N 个账号，返回 (vtuber_id, account_ids)。"""
    s = Maker()
    try:
        v = VTuber(name="提速V")
        s.add(v)
        s.commit()
        ids = []
        for uid in uids:
            a = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid)
            s.add(a)
            s.commit()
            ids.append(a.id)
        return v.id, ids
    finally:
        s.close()


def test_async_fetch_accounts_only_touches_given_ids(monkeypatch):
    """按 id 精确抓取：加账号时不再把该 V 的其它账号重抓一遍。"""
    from app.services import scheduler as sch

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    _, ids = _mk_vtuber_with_accounts(Maker, ["111", "222"])
    monkeypatch.setattr(sch, "SessionLocal", Maker)

    seen: list[str] = []

    async def fake_fetch(acc, _db, client=None, *, pending_avatar=None):
        seen.append(acc.platform_uid)
        return True

    monkeypatch.setattr(sch, "_fetch_one_account", fake_fetch)
    r = asyncio.run(sch.async_fetch_accounts([ids[1]], label="加账号", fast=True))
    assert seen == ["222"]          # 只抓指定账号
    assert r.success == 1


def test_async_fetch_accounts_fast_no_trailing_sleep(monkeypatch):
    """fast 路径：单账号抓完立即落库推送，末尾不再空转 3~5s（旧实现必睡）。"""
    from app.services import scheduler as sch

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    _, ids = _mk_vtuber_with_accounts(Maker, ["111"])
    monkeypatch.setattr(sch, "SessionLocal", Maker)

    sleeps: list[float] = []
    pending_seen: list[list[str] | None] = []

    async def fake_fetch(acc, _db, client=None, *, pending_avatar=None):
        pending_seen.append(pending_avatar)
        return True

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(sch, "_fetch_one_account", fake_fetch)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    pushed: list[str] = []
    monkeypatch.setattr(sch, "_push_account_snapshot", lambda acc: pushed.append(acc.platform_uid))

    r = asyncio.run(sch.async_fetch_accounts(ids, label="收录", fast=True))
    assert r.success == 1
    assert sleeps == []                 # 唯一账号：一次节流 sleep 都不该有
    assert pushed == ["111"]            # 抓完立即推送快照
    assert pending_seen == [[]]         # fast 模式传入待下载头像列表（延后下载）
    assert sch._status["account"]["last_result"]["label"] == "收录"


def test_async_fetch_accounts_paces_between_accounts(monkeypatch):
    """多账号：节流只发生在账号之间（最后一个不再睡），且 fast 间隔更短。"""
    from app.services import scheduler as sch

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    _, ids = _mk_vtuber_with_accounts(Maker, ["111", "222", "333"])
    monkeypatch.setattr(sch, "SessionLocal", Maker)

    sleeps: list[float] = []

    async def fake_fetch(acc, _db, client=None, *, pending_avatar=None):
        return True

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(sch, "_fetch_one_account", fake_fetch)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    r = asyncio.run(sch.async_fetch_accounts(ids, label="收录", fast=True))
    assert r.success == 3
    assert len(sleeps) == 2                                     # 3 个账号 → 2 次间隔
    assert all(settings.MANUAL_FAST_INTERVAL_MIN <= s <= settings.MANUAL_FAST_INTERVAL_MAX
               for s in sleeps)


def test_fetch_one_account_defers_avatar(monkeypatch):
    """传 pending_avatar 时只写 avatar_url，不下载；URL 交给调用方延后处理。"""
    from app.services import scheduler as sch

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    s = Maker()
    v = VTuber(name="V")
    s.add(v)
    s.commit()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="777")
    s.add(acc)
    s.commit()

    class _Pf:
        async def fetch_user_info(self, uid, client=None):
            return {"name": "新名", "sign": "签名", "avatar": "https://i0.hdslb.com/a.jpg",
                    "followers_count": 42, "live_status": 1, "live_title": "直播中"}

    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: _Pf())
    downloads: list[str] = []

    async def fake_download(url, uid, client=None):
        downloads.append(uid)
        return "static/avatars/x.jpg"

    monkeypatch.setattr(sch, "_download_avatar", fake_download)

    pending: list[str] = []
    ok = asyncio.run(sch._fetch_one_account(acc, s, pending_avatar=pending))
    assert ok is True
    assert downloads == []                                       # 没有同步下载
    assert pending == ["https://i0.hdslb.com/a.jpg"]
    assert acc.avatar_url == "https://i0.hdslb.com/a.jpg"
    assert acc.avatar_path is None                               # 本地路径留待延后任务
    assert acc.display_name == "新名" and acc.followers_count == 42
    s.close()


def test_fetch_one_account_records_former_name_and_sign(monkeypatch):
    """2026-09-13（devlog/074）：字段锁定退役 → 平台值**照常覆盖**，
    但覆盖前把旧值记进 `vtuber_field_history`（曾用名 / 曾用签名）。

    ⚠️ 这条是"退役锁定"能成立的前提：`account_stat_snapshots` **不含昵称与签名**，
    不记账就等于旧值永久丢失。
    """
    from app.models.vtuber import VtuberFieldHistory
    from app.services import scheduler as sch

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    s = Maker()
    v = VTuber(name="V")
    s.add(v)
    s.commit()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="777",
                  display_name="曾用名甲", sign="曾用签名甲")
    s.add(acc)
    s.commit()

    class _Pf:
        async def fetch_user_info(self, uid, client=None):
            return {"name": "新名", "sign": "新签名",
                    "followers_count": 99, "live_status": 0}

    monkeypatch.setattr(sch.registry, "get_fetcher", lambda p: _Pf())
    ok = asyncio.run(sch._fetch_one_account(acc, s))
    assert ok is True
    assert acc.display_name == "新名" and acc.sign == "新签名"      # 未锁定 → 照常覆盖
    assert acc.followers_count == 99

    rows = (s.query(VtuberFieldHistory)
            .filter(VtuberFieldHistory.account_id == acc.id)
            .order_by(VtuberFieldHistory.id).all())
    assert [(r.field, r.value) for r in rows] == [
        ("display_name", "曾用名甲"), ("sign", "曾用签名甲")]

    # 再抓一轮同名同签名 → **不重复记**（否则历史会被每轮抓取刷成噪声）
    ok = asyncio.run(sch._fetch_one_account(acc, s))
    assert ok is True
    assert s.query(VtuberFieldHistory).count() == 2


def test_record_field_change_dedupes_repeat_values():
    """A→B→A：只留 A、B 两条（同一值重复出现不重复记账）。"""
    from app.models.vtuber import VtuberFieldHistory
    from app.services.vtuber_history import record_field_change

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    v = VTuber(name="V")
    s.add(v)
    s.commit()

    assert record_field_change(s, vtuber_id=v.id, account_id=None,
                               field="sign", old_value="A") is True
    s.commit()
    assert record_field_change(s, vtuber_id=v.id, account_id=None,
                               field="sign", old_value="A") is False   # 与最近一条相同
    assert record_field_change(s, vtuber_id=v.id, account_id=None,
                               field="sign", old_value="  ") is False  # 空白不记
    assert record_field_change(s, vtuber_id=v.id, account_id=None,
                               field="other", old_value="x") is False  # 未登记的字段不记
    assert s.query(VtuberFieldHistory).count() == 1
    s.close()
    s.close()


def test_field_locked_shim_is_retired():
    """锁定已退役（2026-09-13，devlog/074）：垫片恒 False，且**不再读**任何列。

    保留垫片只为旧脚本不炸；这里顺带把"它不再依赖 locked_fields 列"钉住 ——
    列已在 f004 里删除，如果哪天有人恢复成读列，这里会立刻炸。
    """
    from app.services import scheduler as sch

    class _A:
        pass          # 连 locked_fields 属性都没有 → 仍须安全返回 False

    assert sch._field_locked(_A(), "sign") is False
    assert sch._field_locked(_A(), "display_name") is False


def test_platform_pacer_survives_new_event_loops(monkeypatch):
    """起跑闸门必须能跨事件循环复用（2026-09-13 事故，devlog/076）。

    综合档每轮 `asyncio.run(_run_combined_tier(...))` = 一个新事件循环，而
    `asyncio.Lock` 在第一次 await 时会**绑死当时那个循环**：模块级 pacer 里的锁
    到第二轮就抛 "is bound to a different event loop"，把 `_run_platform_rounds`
    的第一发打成异常 → **整个动态流每轮直接放弃**（线上日志每 60s 一条 ERROR）。

    ⚠️ 为什么上一版没测出来：`test_platform_pacer_spaces_same_platform_but_not_across`
    只在一个 `asyncio.run` 里跑 —— **对"跨循环"这件事完全没有感知**（同 §四探针
    只看几何、看不见 pointer-events 的教训）。这里显式用两个循环调**真实的模块级实例**。
    """
    import time as _time

    from app.services import scheduler as sch

    monkeypatch.setattr(sch._dynamics_pacer, "gap_min", 0.12)
    monkeypatch.setattr(sch._dynamics_pacer, "gap_max", 0.12)
    sch._dynamics_pacer._last.clear()

    asyncio.run(sch._dynamics_pacer.wait("bilibili"))     # 第一个循环：占下时隙
    t0 = _time.monotonic()
    asyncio.run(sch._dynamics_pacer.wait("bilibili"))     # 第二个循环：旧实现必抛
    assert _time.monotonic() - t0 >= 0.10                 # 且仍被间隔开
    t1 = _time.monotonic()
    asyncio.run(sch._dynamics_pacer.wait("weibo"))        # 跨平台互不影响
    assert _time.monotonic() - t1 < 0.05


def test_module_level_pacers_hold_no_event_loop_primitives():
    """防复发（结构性判据）：pacer 里不允许挂着 loop-bound 原语。

    ⚠️ 边界：只看**实例属性现值**，所以只能挡住"在 `__init__` 里急切建锁"这种写法；
    惰性塞进字典的（上一版就是）要靠上面那条行为断言 —— 两条一起才是护栏。
    """
    import asyncio as _aio

    from app.services import scheduler as sch

    loop_bound = (_aio.Lock, _aio.Semaphore, _aio.Event, _aio.Queue, _aio.Condition)
    for pacer in (sch._dynamics_pacer,):
        for name, value in vars(pacer).items():
            if isinstance(value, loop_bound):
                raise AssertionError(f"{type(pacer).__name__}.{name} 持有 {type(value).__name__}，"
                                     f"跨事件循环必炸（见 devlog/076）")
            if isinstance(value, dict):
                for k, v in value.items():
                    assert not isinstance(v, loop_bound), f"{name}[{k}] 持有 loop-bound 原语"


def test_log_file_handler_rotates_daily_and_prunes(tmp_path):
    """日志按天轮转 + 保留 N 份（2026-09-13 用户定，devlog/077）。

    背景：原先 `logging.FileHandler` 不轮转，实测长到 5.2MB / 33963 行、跨数月，
    排查前得先"按天切一刀"（devlog/076 里两条八月旧记录差点被当成现行 bug）。

    这里**真的写盘、真的翻三次页**，断言备份文件产生 / 超龄备份被删 / 内容真的搬过去了。

    ⚠️ 踩坑记录（写在这里免得下次又"造数据造出假绿"）：stdlib 的 `doRollover()` 第一件事是
    算目标文件名，然后 **`if os.path.exists(dfn): return`（"Already rolled over"）** ——
    手工创建备份文件时如果**正好撞上本次的目标名**，整次轮转会被静默跳过（不改名、不裁剪）。
    所以这里不预造备份，而是用"连着翻三次页"来制造多余备份。
    """
    import logging as _logging
    from logging.handlers import TimedRotatingFileHandler

    from app.core.logging_setup import build_file_handler

    log_dir = tmp_path / "logs"
    log_file = log_dir / "app.log"
    handler = build_file_handler(log_file, backup_days=2)

    # ① 类型与关键参数（缺 encoding 在 Windows 上按 GBK 写 → 中文乱码）
    assert isinstance(handler, TimedRotatingFileHandler)
    # `when="midnight"` 会被规范成"86400 秒 + suffix 用日期"（不是 1）
    assert handler.when.upper() == "MIDNIGHT"
    assert handler.interval == 24 * 60 * 60
    assert handler.backupCount == 2
    assert (handler.encoding or "").lower().replace("-", "") == "utf8"
    assert log_dir.is_dir()                     # 目录不存在时会创建

    logger = _logging.getLogger("ddtk.test.logrotate")
    logger.setLevel(_logging.INFO)
    logger.propagate = False
    logger.addHandler(handler)
    try:
        def force_rollover(days_ago: int) -> None:
            """把 rolloverAt 拨回过去并真的写一行 → 触发一次轮转（不依赖真实日期）。"""
            handler.rolloverAt = handler.computeRollover(int(time.time()) - 86400 * days_ago)
            logger.info(f"第 {days_ago} 次翻页前的收尾行")
            handler.flush()

        logger.info("第一天 中文行")
        handler.flush()
        assert log_file.exists()
        assert "第一天 中文行" in log_file.read_text(encoding="utf-8")

        backups = []
        # ⚠️ 顺序必须**由远及近**（3→2→1 天前）：裁剪是按**文件名（=日期）排序**取最旧的，
        #    若倒着翻页，刚生成的那份备份会立刻变成"最旧"并被自己这轮的裁剪删掉
        #    （现象：连续两次翻页只在文件系统里留下 2 个文件、第三次"没有新备份"）。
        for days_ago in (3, 2, 1):               # 连翻三次 → 正常应只剩最近 2 份
            before = {p.name for p in log_dir.glob("app.log.*")}
            force_rollover(days_ago)
            after = {p.name for p in log_dir.glob("app.log.*")}
            new = sorted(after - before)
            assert new, f"第 {days_ago} 次翻页没有产生备份（existing={sorted(before)}）"
            backups.extend(new)

        remaining = sorted(p.name for p in log_dir.glob("app.log.*"))
        assert len(remaining) == 2, f"备份没有被裁剪到 backupCount: {remaining}"
        assert remaining[0] < remaining[1]                                 # 日期名有序
        base_text = log_file.read_text(encoding="utf-8")
        kept = "\n".join(p.read_text(encoding="utf-8") for p in log_dir.glob("app.log.*"))
        assert "第一天 中文行" not in base_text                              # 旧内容已搬进备份
        assert "第一天 中文行" not in kept, "最旧备份应被删除（backupCount=2）"
        assert "第 3 次翻页前的收尾行" in kept                              # 中间那份仍在
        assert "第 1 次翻页前的收尾行" in base_text                          # 当前文件是新起的
    finally:
        logger.removeHandler(handler)
        handler.close()


def test_live_upstream_single_flight_shares_one_fetch():
    """同 liveId 的**并发**取数只打一轮上游（单飞，2026-09-14，devlog/081）。

    没有单飞时：缓存只在成功后才写 ⇒ 两个同时到达的调用都 miss、都各发
    summary+events —— 用户点一次详情会看到 4 个上游请求（dev 下 StrictMode 双挂载调两次）。
    这里断言"上游各被调用 1 次"，旧实现必然各 2 次。
    """
    from app.services import live_upstream

    live_upstream.clear_cache()
    calls = {"summary": 0, "events": 0}

    async def fake_summary(live_id: str):
        calls["summary"] += 1
        await asyncio.sleep(0.05)                 # 模拟上游耗时，制造并发窗口
        return {"word_cloud": [{"text": "晚安", "count": 3}]}

    async def fake_events(live_id: str):
        calls["events"] += 1
        await asyncio.sleep(0.05)
        return [{"type": 7, "send_date_ms": 1}]

    live_upstream.fetch_live_summary = fake_summary
    live_upstream.fetch_live_events = fake_events
    try:
        async def run():
            return await asyncio.gather(
                live_upstream.load_live_upstream("L-1"),
                live_upstream.load_live_upstream("L-1"),
                live_upstream.load_live_upstream("L-1"),
            )

        results = asyncio.run(run())
        assert calls == {"summary": 1, "events": 1}, calls
        assert all(r[0] is not None and r[1] for r in results)
        # 三个调用者拿到的是同一份结果
        assert results[0][0] is results[1][0] is results[2][0]
        # 一轮结束后在途表清空（失败/成功都不留残留）
        assert live_upstream.inflight_count() == 0

        # 第二次调用走**缓存**（不再打上游）
        asyncio.run(live_upstream.load_live_upstream("L-1"))
        assert calls == {"summary": 1, "events": 1}, calls
    finally:
        live_upstream.clear_cache()


def test_live_upstream_failure_not_shared_and_retried():
    """失败**不**共享也不缓存：下一次调用会真的重试（用户点「重试」必须有效）。"""
    from app.services import live_upstream

    live_upstream.clear_cache()
    calls = {"n": 0}

    async def flaky_summary(live_id: str):
        calls["n"] += 1
        await asyncio.sleep(0.02)
        return None if calls["n"] == 1 else {"word_cloud": []}

    async def fake_events(live_id: str):
        return []

    live_upstream.fetch_live_summary = flaky_summary
    live_upstream.fetch_live_events = fake_events
    try:
        assert asyncio.run(live_upstream.load_live_upstream("L-2"))[0] is None
        assert live_upstream.inflight_count() == 0        # 失败不留残留在途表
        ok = asyncio.run(live_upstream.load_live_upstream("L-2"))
        assert ok[0] is not None and calls["n"] == 2
    finally:
        live_upstream.clear_cache()


def test_deferred_avatar_updates_only_avatar_path(monkeypatch):
    """延后下载：只 UPDATE avatar_path 一列并再推一次快照（不覆盖其它字段）。"""
    from app.services import scheduler as sch

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    s = Maker()
    v = VTuber(name="V")
    s.add(v)
    s.commit()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="888",
                  display_name="原名", sign="原签名")
    s.add(acc)
    s.commit()
    aid = acc.id
    s.close()

    monkeypatch.setattr(sch, "SessionLocal", Maker)

    async def fake_download(url, uid, client=None):
        assert uid == "bilibili_888"       # 平台前缀命名，避免跨平台撞名
        return "static/avatars/bilibili_888.jpg"

    monkeypatch.setattr(sch, "_download_avatar", fake_download)
    pushed: list[tuple[int, str | None]] = []
    monkeypatch.setattr(sch, "_push_account_snapshot",
                        lambda a: pushed.append((a.id, a.avatar_path)))

    asyncio.run(sch._deferred_avatar(aid, "https://i0.hdslb.com/a.jpg"))

    check = Maker()
    try:
        fresh = check.get(Account, aid)
        assert fresh.avatar_path == "static/avatars/bilibili_888.jpg"
        assert fresh.display_name == "原名" and fresh.sign == "原签名"   # 其它字段未被触碰
    finally:
        check.close()
    assert pushed == [(aid, "static/avatars/bilibili_888.jpg")]


def test_deferred_avatar_skips_deleted_account(monkeypatch):
    """账号在延后下载期间被删除：UPDATE 影响 0 行 → 不推送、不报错。"""
    from app.services import scheduler as sch

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    monkeypatch.setattr(sch, "SessionLocal", Maker)

    pushed: list[int] = []
    monkeypatch.setattr(sch, "_push_account_snapshot", lambda a: pushed.append(a.id))
    asyncio.run(sch._deferred_avatar(9999, "https://i0.hdslb.com/a.jpg"))
    assert pushed == []


def test_async_fetch_first_screen_bounded_params(monkeypatch):
    """收录首屏：投稿 1 页 + 动态 1 页限 3 条，走帖子锁并写 kind=adopt 的完成汇总。"""
    from app.services import scheduler as sch

    # 首屏要过登录闸门（未登录直接 `login_required` 返回、一次网络都不发，见 devlog/086）；
    # 本用例只管参数口径，所以显式声明放行 —— 别依赖开发机上恰好有凭据。
    monkeypatch.setattr(sch.capabilities, "content_fetch_allowed", lambda: (True, ""))

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Maker = sessionmaker(bind=engine)
    _, ids = _mk_vtuber_with_accounts(Maker, ["123"])
    monkeypatch.setattr(sch, "SessionLocal", Maker)

    calls: list[dict] = []

    async def fake_fetch_account(acc, video_pages, dynamics_pages, db, client=None, **kw):
        calls.append({"uid": acc.platform_uid, "video": video_pages, "dyn": dynamics_pages, **kw})
        return sch.PostFetchResult(videos=30, dynamics=2, stored=3)

    monkeypatch.setattr(sch, "_fetch_posts_for_account", fake_fetch_account)
    out = asyncio.run(sch.async_fetch_first_screen(ids[0]))
    assert out.stored == 3
    assert calls == [{
        "uid": "123",
        "video": settings.FIRST_SCREEN_VIDEO_PAGES,
        "dyn": settings.FIRST_SCREEN_DYNAMICS_PAGES,
        "include_videos": True,
        "stop_on_existing": True,
        "limit_latest": settings.FIRST_SCREEN_DYNAMICS_LIMIT,
    }]
    last = sch._status["post"]["last_result"]
    assert last["kind"] == "adopt" and last["stored"] == 3
    assert sch._post_fetch_lock.locked() is False


def test_fetch_accounts_queues_when_manual_holder(monkeypatch):
    """抢不到锁不再静默丢弃：入队等待心跳补抓（v0.9.4 排队兜底）。"""
    from app.services import scheduler as sch

    # 清掉可能残留的队列
    sch._take_pending()

    assert sch._fetch_lock.acquire(blocking=False)   # 模拟另一个**手动**任务持锁
    try:
        r = asyncio.run(sch.async_fetch_accounts([7], label="收录", fast=True))
        assert "排队" in r.details[0]
        assert sch.has_pending_fetches() is True
    finally:
        sch._fetch_lock.release()

    # 锁空闲后心跳消费队列
    fetched: list[list[int]] = []

    async def fake_fetch_accounts(ids, *, label="指定账号", fast=True):
        fetched.append(list(ids))
        return sch.FetchResult(success=len(ids))

    monkeypatch.setattr(sch, "async_fetch_accounts", fake_fetch_accounts)
    sch._drain_pending_fetches()
    assert fetched == [[7]]
    assert sch.has_pending_fetches() is False


def test_drain_pending_keeps_queue_while_busy(monkeypatch):
    """消费时若又有任务在跑：放回队列，下个心跳再试（不丢也不抢）。"""
    from app.services import scheduler as sch

    sch._take_pending()
    sch._enqueue_pending_account(11)
    sch._fetch_running = True
    try:
        sch._drain_pending_fetches()
        assert sch.has_pending_fetches() is True
    finally:
        sch._fetch_running = False
        sch._take_pending()


# ── 外部数据任务状态通道（v0.9.4）：顶栏胶囊 + 完成事件 ────────────────────

def test_external_task_status_and_done_seq():
    """外部任务状态：running/label 供顶栏展示；每次结束 seq 自增（前端据此刷新卡片）。

    并发时标签用「、」合并、全部结束才置 running=False——收录回填与每日批次
    可能同时跑（两者都不占两把锁）。
    """
    from app.services import scheduler as sch

    assert sch._status["external"]["running"] is False
    base_seq = sch._status["external"]["seq"]

    sch.external_task_started("adopt:22", "永雏塔菲 的历史数据")
    assert sch.get_fetch_status()["external"] == {
        "running": True, "label": "永雏塔菲 的历史数据",
        "last_label": None, "seq": base_seq,
    }

    sch.external_task_started("daily", "第三方数据日批次")
    assert sch._status["external"]["label"] == "永雏塔菲 的历史数据、第三方数据日批次"

    sch.external_task_finished("adopt:22")
    assert sch._status["external"]["running"] is True      # 还有一个在跑
    assert sch._status["external"]["label"] == "第三方数据日批次"
    assert sch._status["external"]["seq"] == base_seq + 1
    assert sch._status["external"]["last_label"] == "永雏塔菲 的历史数据"

    sch.external_task_finished("daily")
    assert sch._status["external"]["running"] is False
    assert sch._status["external"]["label"] is None
    assert sch._status["external"]["seq"] == base_seq + 2


def test_external_status_not_in_any_fetch_running():
    """外部任务不占两把锁：综合档/手动任务的忙判定不受它影响。"""
    from app.services import scheduler as sch

    sch.external_task_started("daily", "第三方数据日批次")
    try:
        assert sch.any_fetch_running() is False
        assert sch.manual_task_running() is False
        assert sch.is_fetch_running() is False
    finally:
        sch.external_task_finished("daily")


# ── 顶栏进度（P8-C）：任务名 + V名 + i/N ────────────────────────────────

def test_post_progress_exposes_task_vtuber_and_index():
    """帖子流状态带 task/vtuber_name/index/total（顶栏「动态更新中 - 明前奶绿 - 1/11」）。"""
    from app.services import scheduler as sch

    try:
        sch._set_post_progress("update", "明前奶绿", 1, 11)
        st = sch.get_fetch_status()["post"]
        assert st["task"] == "update"
        assert st["vtuber_name"] == "明前奶绿"
        assert (st["index"], st["total"]) == (1, 11)
        assert st["target"] == "明前奶绿"     # 旧字段兼容（旧前端仍读 target）

        sch._set_post_progress("dynamic", "七海Nana7mi", 3, 7)
        st = sch.get_fetch_status()["post"]
        assert (st["task"], st["vtuber_name"], st["index"], st["total"]) == \
            ("dynamic", "七海Nana7mi", 3, 7)
    finally:
        sch._reset_post_status()
    st = sch.get_fetch_status()["post"]
    assert st["task"] is None and st["vtuber_name"] is None
    assert (st["index"], st["total"]) == (0, 0)


def test_account_progress_exposes_task_and_vtuber():
    """账号流状态带 task 与 V 名；V 名缺省=None 表示「不改动」（轮次汇报不覆盖 worker 值）。"""
    from app.services import scheduler as sch

    try:
        sch._status["account"]["task"] = "account"
        sch._set_account_progress("bilibili", 3, 10, vtuber_name="泽音Melody")
        st = sch.get_fetch_status()["account"]
        assert st["task"] == "account" and st["vtuber_name"] == "泽音Melody"
        assert (st["current"], st["index"], st["total"]) == ("bilibili", 3, 10)

        sch._set_account_progress("bilibili、weibo", 4, 10)
        assert sch.get_fetch_status()["account"]["vtuber_name"] == "泽音Melody"
        sch._set_account_vtuber("七海Nana7mi")
        assert sch.get_fetch_status()["account"]["vtuber_name"] == "七海Nana7mi"
    finally:
        sch._reset_account_status()
    st = sch.get_fetch_status()["account"]
    assert st["task"] is None and st["vtuber_name"] is None and st["running"] is False


def test_fetch_status_marks_auto_runs_and_manual_busy():
    """顶栏展示判据（2026-09-10 用户：频繁的动态轮询不必占顶栏）。

    - 每类任务的 `auto` 标出「本次由定时档发起」→ 前端据此静默自动节拍；
    - 顶层 `manual_running` 与手动端点 409 同源（`manual_task_running()`）：
      自动档持锁时**为 False**，前端按钮不该被自动节拍禁用（后端会受理，手动优先会抢占）。
    """
    from app.services import scheduler as sch

    keep = (sch._post_fetch_running, sch._auto_post_active.is_set(),
            sch._preempt_post.is_set(), dict(sch._status["post"]))
    try:
        sch._status["post"]["running"] = True
        sch._post_fetch_running = True

        # ① 自动档持锁（动态流）：auto=True，且手动端点不会 409
        sch._auto_post_active.set()
        st = sch.get_fetch_status()
        assert st["post"]["auto"] is True
        assert st["manual_running"] is False

        # ② 同一把锁转为手动任务 → auto 撤下、manual_running 立起
        sch._auto_post_active.clear()
        st = sch.get_fetch_status()
        assert st["post"]["auto"] is False
        assert st["manual_running"] is True

        # ③ 手动任务请求让位（等自动档交还锁的窗口）也算忙——与 409 判据一致
        sch._post_fetch_running = False
        sch._preempt_post.set()
        assert sch.get_fetch_status()["manual_running"] is True

        # ④ 账号流同理（同一套判据，两个通道各自独立）
        sch._auto_account_active.set()
        try:
            assert sch.get_fetch_status()["account"]["auto"] is True
        finally:
            sch._auto_account_active.clear()
        assert sch.get_fetch_status()["account"]["auto"] is False
    finally:
        (sch._post_fetch_running, auto_on, preempt_on, post_status) = keep
        if auto_on:
            sch._auto_post_active.set()
        else:
            sch._auto_post_active.clear()
        if preempt_on:
            sch._preempt_post.set()
        else:
            sch._preempt_post.clear()
        sch._status["post"].clear()
        sch._status["post"].update(post_status)
        sch._auto_account_active.clear()

    st = sch.get_fetch_status()
    assert st["post"]["auto"] is False and st["manual_running"] is False


def test_vtuber_name_of_tolerates_detached_account():
    """V 名取自 ORM 关系；关系不可用时返回 None——进度显示绝不影响抓取。"""
    from app.services import scheduler as sch

    class _Boom:
        @property
        def vtuber(self):
            raise RuntimeError("detached")

    class _Inner:
        name = "弥月Mizuki"

    class _Ok:
        vtuber = _Inner()

    assert sch._vtuber_name_of(_Boom()) is None
    assert sch._vtuber_name_of(_Ok()) == "弥月Mizuki"


# ── v0.9.8（P9-B）：动态流速率预算 + 启动外部补抓 ──────────────────────

def test_platform_budget_window_and_wait():
    """按平台的滑动窗口预算：预算内继续跑，超预算才等窗口腾名额。"""
    from app.services import scheduler as sch

    b = sch._PlatformBudget(12, window_seconds=60.0)
    t0 = 1000.0
    assert b.wait_seconds({"bilibili": 8}, t0) == 0.0
    b.charge({"bilibili": 8}, t0)
    # 已用 8/12：再要 8 个 → 需等最早那批滑出窗口（满 60s）
    assert b.wait_seconds({"bilibili": 8}, t0) == 60.0
    # 只要 4 个 → 还有 4 个名额，立刻可跑
    assert b.wait_seconds({"bilibili": 4}, t0) == 0.0
    # 跨过窗口后全部释放
    assert b.wait_seconds({"bilibili": 12}, t0 + 61) == 0.0
    # 平台之间独立：weibo 未记账不受影响
    assert b.wait_seconds({"weibo": 12}, t0) == 0.0
    # 部分腾挪：用满 12 后 30s，要 6 个 → 等 30s（最早的 2 个在 t0+60 释放，仍不够，
    # 第 6 个要等 t0+60 那批…这里只验证「等待时间 ≤ 窗口且 > 0」）
    b2 = sch._PlatformBudget(12, window_seconds=60.0)
    b2.charge({"weibo": 12}, t0)
    w = b2.wait_seconds({"weibo": 6}, t0 + 30)
    assert 0 < w <= 60


def test_platform_budget_cost_exceeding_rpm_never_raises():
    """回归（2026-09-11 静态审计实跑复现）：单平台一轮成本 > rpm 时不得越界。

    根因：`idx = min(need - 1, len(dq) - 1)` 在窗口为空时得 -1 → `dq[-1]` 抛
    IndexError。触发条件是「单平台主账号数 > rpm」（13 个 B 站主账号 / rpm=12），
    而首轮 `_dynamics_next_due()` 正落在 `_tier_loop` 的 try 之外 —— 抛出去就是
    整条综合档线程死亡（动态流 + 账号流永久停摆），所以这里把边界钉死。
    """
    from app.services import scheduler as sch

    # ① 空窗口 + 成本 > rpm（原来是 IndexError），等待恰为一个窗口
    b = sch._PlatformBudget(12, window_seconds=60.0)
    assert b.wait_seconds({"bilibili": 13}, 1000.0) == 60.0
    assert b.wait_seconds({"bilibili": 99}, 1000.0) == 60.0

    # ② 窗口被填满后，need 超过窗口内全部记录（夹取后取最早一条 → 一个窗口）
    b.charge({"bilibili": 12}, 1000.0)
    assert b.wait_seconds({"bilibili": 30}, 1000.0 + 10) == 50.0

    # ③ 夹取同时修正了原来的**过度等待**：need 落在窗口内部时取第 need 早的那条，
    #    而不是无脑取最早一条（旧的 min() 在第 ②③ 情形都会高估等待）
    assert b.wait_seconds({"bilibili": 30}, 1000.0 + 30) == 30.0

    # ④ 平台独立：**未记账**的平台照旧立刻可跑
    assert b.wait_seconds({"weibo": 12}, 1000.0) == 0.0
    #    而「成本 > rpm」在任何窗口下都凑不出名额（退化输入）→ 返回一个窗口而不是抛错
    assert b.wait_seconds({"weibo": 99}, 1000.0) == 60.0


def test_legacy_bridge_rejects_unique_key_mismatch():
    """回归（2026-09-11 静态审计）：旧库桥接必须拒绝唯一键不一致的库。

    桥接路径（`_sync_legacy_schema`）只补列和索引 —— SQLite 不支持 ADD CONSTRAINT，
    唯一约束补不了。而迁移 `c002` 之前 `posts` 是全局
    `UNIQUE(platform, platform_post_id)`（缺 platform_uid）。若照样 `stamp head`，
    库会被永久标成最新、后续迁移全部跳过，而联合投稿（同一 pid 出现在多个 UP 名下）
    会被唯一约束拒掉、被 `_safe_store_post` 当作「帖子已存在」静默丢弃 ——
    正是 c002 要修的那个数据丢失场景。
    """
    from sqlalchemy import create_engine, inspect, text as _sql_text

    from app import main as app_main

    # ① 与模型一致的库（= alembic / create_all 建出来的）→ 全部唯一键都在，不报缺。
    #    先钉住「反射确实看得见这些唯一键」，否则断言 ① 会因为两边都空而假通过
    #    （本守卫的第一版就是这样：`UniqueConstraint.unique` 是 None，判据恒假）。
    e_ok = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(e_ok)
    live_ok = app_main._live_unique_keys(inspect(e_ok))
    assert ("platform", "platform_uid") in live_ok["accounts"]
    assert ("platform", "platform_uid", "platform_post_id") in live_ok["posts"]
    assert app_main._missing_unique_keys(inspect(e_ok)) == []

    # ② 复刻 c002 之前的状态：其余表与模型一致，只有 posts 用旧的全局唯一键
    #    （真实旧库就是这个形态 —— 缺的是「c002 那次加宽」，不是整库缺失）。
    e_old = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(e_old)
    with e_old.begin() as conn:
        conn.execute(_sql_text("DROP TABLE posts"))
        conn.execute(_sql_text(
            "CREATE TABLE posts ("
            "  id INTEGER PRIMARY KEY,"
            "  platform VARCHAR NOT NULL,"
            "  platform_uid VARCHAR NOT NULL,"
            "  platform_post_id VARCHAR NOT NULL,"
            "  type VARCHAR NOT NULL,"
            "  UNIQUE (platform, platform_post_id)"      # ← c002 之前的旧约束
            ")"
        ))
    missing = app_main._missing_unique_keys(inspect(e_old))
    assert missing == ["posts(platform, platform_uid, platform_post_id)"]

    # ③ 真跑一次桥接：必须抛错，而不是补完列就 stamp
    orig_engine = app_main.engine
    app_main.engine = e_old
    try:
        with pytest.raises(RuntimeError) as ei:
            app_main._sync_legacy_schema()
        assert "platform_uid" in str(ei.value)
        assert "拒绝 stamp head" in str(ei.value)
    finally:
        app_main.engine = orig_engine


def test_platform_budget_disabled():
    """预算 <=0 → 不限速（退回固定周期由调用方处理）。"""
    from app.services import scheduler as sch

    b = sch._PlatformBudget(0)
    b.charge({"bilibili": 100}, 0.0)
    assert b.wait_seconds({"bilibili": 100}, 0.0) == 0.0


def test_dynamics_next_due_adaptive(db, monkeypatch):
    """自适应到期时刻：预算 >0 时约等于「最小间隔」，预算 <=0 时退回固定周期。"""
    from app.services import scheduler as sch

    v = VTuber(name="V")
    db.add(v)
    db.commit()
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="1"))
    db.commit()
    monkeypatch.setattr(sch, "SessionLocal", lambda: db)

    monkeypatch.setattr(sch.settings, "DYNAMICS_BUDGET_RPM", 12)
    monkeypatch.setattr(sch.settings, "DYNAMICS_MIN_GAP_SECONDS", 30.0)
    monkeypatch.setattr(sch.settings, "DYNAMICS_JITTER_SECONDS", 0.0)
    monkeypatch.setattr(sch, "_dynamics_budget", sch._PlatformBudget(12))
    due = sch._dynamics_next_due(db)
    delta = due - time.monotonic()
    assert 29 <= delta <= 31          # 空预算 → 取最小间隔

    monkeypatch.setattr(sch.settings, "DYNAMICS_BUDGET_RPM", 0)
    monkeypatch.setattr(sch.settings, "DYNAMICS_LATEST_INTERVAL_MINUTES", 15)
    monkeypatch.setattr(sch.settings, "DYNAMICS_LATEST_JITTER_SECONDS", 0.0)
    delta = sch._dynamics_next_due(db) - time.monotonic()
    assert 899 <= delta <= 901        # 退回固定 15 分钟


def test_dynamics_due_or_retry_never_raises_and_always_schedules_ahead(db, monkeypatch):
    """回归（devlog/053 §六-1 未闭环项）：综合档心跳的到期计算**不可抛错**。

    `_dynamics_next_due()` 的调用点有两个，都在调度线程里：心跳首轮（旧代码位于
    任何 try 之外）与每轮排期。任一处抛错且无人接管 → 整条综合档线程死亡 →
    动态流与账号流永久停摆，而 T0 直播轮询是独立线程仍活着，**界面看起来「部分
   正常」**（安装版无控制台，只能翻 logs/sidecar.log）。053 只修掉了已知的那条
    越界，兜底本身没加。

    这里钉住两件事：
    ① 底层抛错时 `_dynamics_due_or_retry` 返回**将来**的时刻（不是过去）——
       否则心跳会退化成每 tick 重试一次的忙循环；
    ② 底层正常时行为与直接调用 `_dynamics_next_due` 一致（包装不改变语义）。
    """
    from app.services import scheduler as sch

    def _boom(_db):
        raise IndexError("模拟 _dynamics_next_due 内部越界")

    monkeypatch.setattr(sch, "_dynamics_next_due", _boom)
    monkeypatch.setattr(sch.settings, "DYNAMICS_MIN_GAP_SECONDS", 30.0)
    before = time.monotonic()
    due = sch._dynamics_due_or_retry(db, why="测试")   # 不得抛错
    assert due > before, "失败时必须排在将来，否则心跳忙循环"
    assert 29 <= due - before <= 31, "失败时退化到各一个「最小间隔」"

    # 正常路径：包装必须等价于直接调用（本用例只验证「不吞掉正常返回值」）
    monkeypatch.setattr(sch, "_dynamics_next_due", lambda _db, since=None: 12345.0)
    assert sch._dynamics_due_or_retry(db, why="测试") == 12345.0
    assert sch._dynamics_due_or_retry(db, why="测试", since=time.monotonic()) == 12345.0


def test_platform_budget_adapts_to_per_platform_demand():
    """回归（devlog/053 遗留项）：账号数超过 rpm 时**不该被自己饿死**。

    旧行为：单平台需求 > rpm 且窗口为空 → 等一个整窗口（13 个 B 站主账号、rpm=12
    → 每轮空等 60s，动态流速率被压到实际需求的一半以下），而这并非风控所需。
    新行为：本平台生效预算抬到「至少装得下一轮」，等 0s；平台之间互不影响。
    """
    from app.services import scheduler as sch

    b = sch._PlatformBudget(12, window_seconds=60.0)
    # 13 > 12：自适应后不再空等
    assert b.wait_seconds({"bilibili": 13}, 0.0, by_platform={"bilibili": 13}) == 0.0
    # 需求远超 rpm 同样不退化
    assert b.wait_seconds({"bilibili": 40}, 0.0, by_platform={"bilibili": 40}) == 0.0

    # 平台独立：bilibili 抬到 40，weibo 仍按 12 记账 → weibo 满窗后仍要等
    b2 = sch._PlatformBudget(12, window_seconds=60.0)
    b2.charge({"weibo": 12}, 0.0)
    assert b2.wait_seconds({"weibo": 1}, 0.0, by_platform={"bilibili": 40, "weibo": 1}) > 59

    # 不传 by_platform（旧调用口径）时行为完全不变
    b3 = sch._PlatformBudget(12, window_seconds=60.0)
    assert b3.wait_seconds({"bilibili": 13}, 0.0) == 60.0

    # 需求未超预算时不得抬高（稳态速率不受影响）
    b4 = sch._PlatformBudget(12, window_seconds=60.0)
    b4.charge({"bilibili": 11}, 0.0)
    # 生效 rpm 仍是 12：窗口里已有 11 条，再来 1 条刚好占满 → 不用等
    assert b4.wait_seconds({"bilibili": 1}, 0.0, by_platform={"bilibili": 1}) == 0.0
    # 再来 2 条就超了 → 必须等最早那条滑出
    assert b4.wait_seconds({"bilibili": 2}, 0.0, by_platform={"bilibili": 2}) > 59


def test_dynamics_lanes_group_all_accounts_by_platform(db, monkeypatch):
    """R7（2026-09-13 用户口径）：动态名单 = **库里所有 V 的所有平台账号**按平台分组。

    与 `_primary_accounts`（每 V 只取主账号，第三方历史回填仍用它）的区别就在这里：
    一个 V 有几个平台就在几条名单里各占一格；同一平台的多个账号也各占一格。
    """
    from app.services import scheduler as sch

    # 测试环境默认没有微博 cookie（`needs_login=True` → weibo 名单会被跳过），
    # 这里先给个假登录态，让断言只聚焦"名单怎么分"
    monkeypatch.setattr(sch.weibo_auth_manager, "cookie", "SUB=dummy")
    monkeypatch.setattr(sch.weibo_auth_manager, "_valid", True)
    # 本用例只关心"名单怎么分"，显式声明 B 站内容闸门放行 —— 否则会依赖开发机上恰好有凭据
    # （2026-09-16 实测踩到：开发机 .env 被清空后 `_next_dynamics_cost` 少了 bilibili）
    monkeypatch.setattr(sch.capabilities, "content_fetch_allowed", lambda: (True, ""))

    v1, v2, v3 = VTuber(name="七海"), VTuber(name="明前奶绿"), VTuber(name="泽音")
    db.add_all([v1, v2, v3])
    db.commit()
    db.add_all([
        Account(vtuber_id=v1.id, platform="bilibili", platform_uid="11"),
        Account(vtuber_id=v1.id, platform="weibo", platform_uid="12"),
        Account(vtuber_id=v2.id, platform="bilibili", platform_uid="21"),
        Account(vtuber_id=v2.id, platform="weibo", platform_uid="22"),
        Account(vtuber_id=v3.id, platform="bilibili", platform_uid="31"),
        # 同一平台的第二个账号（如分号）也要进名单
        Account(vtuber_id=v3.id, platform="bilibili", platform_uid="32"),
        # 两种该被跳过的账号
        Account(vtuber_id=v3.id, platform="bilibili", platform_uid=""),
        Account(vtuber_id=v3.id, platform="mastodon", platform_uid="99"),   # 无 fetcher
    ])
    db.commit()

    lanes = sch._dynamics_lanes(db)
    assert {pf: len(q) for pf, q in lanes.items()} == {"bilibili": 4, "weibo": 2}
    # ⚠️ 下面 `_next_dynamics_cost` 走的是 `_active_dynamics_lanes`，会过**内容闸门**
    # （未登录 B 站时整条 bilibili 名单被跳过，见 devlog/086）。本用例只关心"名单怎么分"，
    # 所以显式声明"已登录"—— 2026-09-16 实测踩到：不声明就会**依赖开发机上恰好有凭据**，
    # 一旦开发机的 .env 被清空，这条断言就红了（那次是被另一个用例写坏 .env 才暴露的）。
    # 名单内顺序稳定：按 (V.id, Account.id)
    assert [acc.platform_uid for _v, acc in lanes["bilibili"]] == ["11", "21", "31", "32"]
    assert [acc.platform_uid for _v, acc in lanes["weibo"]] == ["12", "22"]
    # 另一个 V 出现在两条名单里（这就是 R6 做不到的覆盖面）
    names = {pf: [v.name for v, _a in q] for pf, q in lanes.items()}
    assert names["bilibili"] == ["七海", "明前奶绿", "泽音", "泽音"]
    assert names["weibo"] == ["七海", "明前奶绿"]

    # 预算估算必须与抓取名单同口径（每账号 1 次 feed 页）
    assert sch._next_dynamics_cost(db) == {"bilibili": 4, "weibo": 2}

    # 主账号口径仍然是"每 V 一个"（第三方历史回填用），两者不是一回事
    assert len(sch._primary_accounts(db)) == 3


def test_dynamics_lane_skipped_when_weibo_not_logged_in(db, monkeypatch):
    """微博登录态不可用 → **整条 weibo 名单不跑**（同步判据 + 预算估算一起生效）。

    动机（2026-09-13 实测）：Cookie 过期时每个账号都会 ok=-100 失败 ——
    放进 60s 轮就是"每分钟 N 条警告 + 白打请求"。
    """
    from app.services import scheduler as sch

    v = VTuber(name="七海")
    db.add(v)
    db.commit()
    db.add_all([
        Account(vtuber_id=v.id, platform="bilibili", platform_uid="11"),
        Account(vtuber_id=v.id, platform="weibo", platform_uid="12"),
    ])
    db.commit()

    monkeypatch.setattr(sch.weibo_auth_manager, "cookie", "")      # 无 cookie = 未登录
    # B 站这侧要**显式放行**，否则（开发机没登录时）bilibili 也会被内容闸门跳过，
    # 这条断言就变成在考"开发机有没有凭据"了 —— 2026-09-16 实测踩到
    monkeypatch.setattr(sch.capabilities, "content_fetch_allowed", lambda: (True, ""))
    lanes, skipped = sch._active_dynamics_lanes(db)
    assert list(lanes) == ["bilibili"]
    assert "weibo" in skipped and "登录" in skipped["weibo"]
    assert sch._next_dynamics_cost(db) == {"bilibili": 1}      # 跳过的名单不计预算

    monkeypatch.setattr(sch.weibo_auth_manager, "cookie", "SUB=dummy")   # 重新扫码后
    monkeypatch.setattr(sch.weibo_auth_manager, "_valid", True)
    lanes2, skipped2 = sch._active_dynamics_lanes(db)
    assert sorted(lanes2) == ["bilibili", "weibo"] and not skipped2
    assert sch._next_dynamics_cost(db) == {"bilibili": 1, "weibo": 1}


def test_dynamics_lane_gap_adapts_to_list_length():
    """名单内间隔自适应摊平（R7）：短名单最保守、长名单才压紧、压到底也不低于下限。

    这张表就是"一分钟周期"的边界说明书：约 17 个账号/平台是 60s 还能容纳的上限，
    再多就该让周期自然变长（而不是把间隔压到 2s 以下硬凑）。
    """
    from app.services import scheduler as sch

    s = settings
    assert sch._lane_gap(1) == s.DYNAMICS_LANE_GAP_MAX          # 单账号：无间隔可言 → 上限
    assert sch._lane_gap(2) == s.DYNAMICS_LANE_GAP_MAX
    assert sch._lane_gap(4) == s.DYNAMICS_LANE_GAP_MAX
    # N=8（当前 B 站名单长度）→ 摊到目标时长，且不超上限
    assert 4.5 < sch._lane_gap(8) < s.DYNAMICS_LANE_GAP_MAX
    # 单调不增 + 不低于下限
    gaps = [sch._lane_gap(n) for n in range(1, 41)]
    assert all(b <= a + 1e-9 for a, b in zip(gaps, gaps[1:]))
    assert min(gaps) >= s.DYNAMICS_LANE_GAP_MIN
    # 轮长 ≈ 目标时长（未触底时）；触底后自然超出 60s 周期 → 由周期下限让位
    for n in (8, 12):
        assert abs((n * s.DYNAMICS_LANE_FETCH_ESTIMATE + n * sch._lane_gap(n))
                   - s.DYNAMICS_LANE_TARGET_SECONDS) < 0.01
    over = 20 * s.DYNAMICS_LANE_FETCH_ESTIMATE + 20 * sch._lane_gap(20)
    assert over > s.DYNAMICS_MIN_CYCLE_SECONDS


def test_startup_catchup_due_by_timestamp(db):
    """启动外部补抓的到期判据：无记录 → 到期；24h 内 → 跳过；超过 → 到期。"""
    from app.repositories.vtuber_repo import AppMetaRepo
    from app.services import scheduler as sch

    now = datetime(2026, 9, 10, 12, 0)
    assert sch.startup_catchup_due(db, now=now) is True

    repo = AppMetaRepo(db)
    repo.set_dt(sch.EXTERNAL_STARTUP_KEY, now - timedelta(hours=2))
    assert sch.startup_catchup_due(db, now=now) is False
    assert repo.get_dt(sch.EXTERNAL_STARTUP_KEY) == now - timedelta(hours=2)

    repo.set_dt(sch.EXTERNAL_STARTUP_KEY, now - timedelta(hours=25))
    assert sch.startup_catchup_due(db, now=now) is True
    # 坏值容错：解析失败视为到期
    repo.set(sch.EXTERNAL_STARTUP_KEY, "not-a-date")
    assert sch.startup_catchup_due(db, now=now) is True


def test_run_startup_external_catchup_runs_then_skips(db, monkeypatch):
    """启动补抓：首次跑每 V 主账号并写时间戳 + 进 external 状态通道；再调用则跳过。"""
    from app.repositories.vtuber_repo import AppMetaRepo
    from app.services import scheduler as sch

    v = VTuber(name="V")
    db.add(v)
    db.commit()
    db.add_all([
        Account(vtuber_id=v.id, platform="weibo", platform_uid="9"),
        Account(vtuber_id=v.id, platform="bilibili", platform_uid="8"),
    ])
    db.commit()
    monkeypatch.setattr(sch, "SessionLocal", lambda: db)

    calls: list[list[int]] = []

    async def fake_interval(interval, account_ids=None):
        calls.append(list(account_ids or []))
        return [{"kind": "fan_history", "stored": 1, "skipped": 0, "error": None}]

    import app.services.externals.runner as runner_mod
    monkeypatch.setattr(runner_mod, "run_external_interval", fake_interval)

    out = asyncio.run(sch.run_startup_external_catchup())
    assert out["status"] == "done" and out["accounts"] == 1
    # 只带主账号（bilibili 优先，即使插入顺序是 weibo 在前）
    assert calls == [[db.query(Account).filter(Account.platform == "bilibili").one().id]]
    assert AppMetaRepo(db).get_dt(sch.EXTERNAL_STARTUP_KEY) is not None
    assert sch._status["external"]["running"] is False      # 状态通道已收尾
    assert sch._status["external"]["last_label"] == "1 个主账号的第三方数据"
    assert sch._external_running is False

    out2 = asyncio.run(sch.run_startup_external_catchup())
    assert out2["status"] == "skipped"
    assert len(calls) == 1                                   # 24h 内不再请求第三方


def test_run_startup_external_catchup_writes_timestamp_on_error(db, monkeypatch):
    """单源报错也写时间戳：第三方抖动不该导致每次启动都重跑。"""
    from app.repositories.vtuber_repo import AppMetaRepo
    from app.services import scheduler as sch

    v = VTuber(name="V")
    db.add(v)
    db.commit()
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="7"))
    db.commit()
    monkeypatch.setattr(sch, "SessionLocal", lambda: db)

    async def boom(interval, account_ids=None):
        raise RuntimeError("third party down")

    import app.services.externals.runner as runner_mod
    monkeypatch.setattr(runner_mod, "run_external_interval", boom)

    out = asyncio.run(sch.run_startup_external_catchup())
    assert out["status"] == "error"
    assert AppMetaRepo(db).get_dt(sch.EXTERNAL_STARTUP_KEY) is not None
    assert sch._status["external"]["running"] is False


    """env_store.save_env_keys：原子替换且不丢失其他配置行（含临时文件无残留）。"""
    import pathlib
    import shutil
    from app.services import env_store

    d = pathlib.Path(__file__).parent / "_env_test"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    env = d / ".env"
    env.write_text("FOO=bar\nBILI_SESSDATA=old\nBAZ=qux\n", encoding="utf-8")
    monkeypatch.setattr(env_store, "ENV_PATH", env)
    monkeypatch.setattr(env_store, "reload_env_keys", lambda keys: None)  # 隔离 os.environ 污染

    env_store.save_env_keys({
        "BILI_SESSDATA": "new-sess",
        "BILI_BIJI_JCT": "jct",
        "BILI_DEDE_USER_ID": "123",
        "BILI_BUVID_3": "b3",
        "BILI_REFRESH_TOKEN": "rt",
    })

    text = env.read_text(encoding="utf-8")
    assert "FOO=bar" in text and "BAZ=qux" in text
    assert "BILI_SESSDATA=new-sess" in text
    assert "BILI_SESSDATA=old" not in text
    assert not list(d.glob("*.tmp"))       # 临时文件已清理
    shutil.rmtree(d, ignore_errors=True)


# ── 冷启动优化：迁移快路径与 alembic head 一致性 ────────────────────────

def test_migration_head_matches_alembic():
    """_run_migrations 快路径依赖 MIGRATION_HEAD 跳过 alembic 加载；
    若新增迁移而忘记同步该常量，冷启动快路径会把旧库误判为已最新。"""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    from app.core.config import PROJECT_ROOT
    from app.main import MIGRATION_HEAD

    cfg = Config(str(PROJECT_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(PROJECT_ROOT / "alembic"))
    head = ScriptDirectory.from_config(cfg).get_current_head()
    assert MIGRATION_HEAD == head, f"MIGRATION_HEAD={MIGRATION_HEAD!r} != alembic head={head!r}"


# 已知且**有意保留**的两处 ORM ↔ 迁移不对称（2026-09-11 审计发现，本用例显式固化）。
# 两者都不影响运行时行为，但必须写下来，否则「新出现的漂移」与「早就知道的漂移」
# 混在一起，等于没有守卫。任何一条要动，都得连注释一起改。
_KNOWN_NULLABLE_DRIFT = {"accounts.sort_order"}
_KNOWN_ORM_ONLY_INDEXES = {
    f"{t}.ix_{t}_id"
    for t in ("account_stat_snapshots", "live_category_overrides", "live_gift_days",
              "live_sessions", "thirdparty_vtubers", "vtuber_events")
}


def test_orm_metadata_matches_migration_chain(tmp_path, monkeypatch):
    """ORM 建库（create_all / 旧库桥接）与迁移链建库必须结构等价。

    为什么需要：两条路径**都会**产出可用的库，但差异只会在很久以后以
    「某台机器上数据莫名丢失/写入失败」的形态暴露。最贵的一次已经发生过 ——
    `posts` 的唯一键若是 c002 之前的全局形态，联合投稿会被静默丢弃。

    比的是「结构」：列集合与可空性、索引名、唯一键列元组。不比类型字符串
    （SQLite 类型亲和性下 VARCHAR/TEXT 写法差异无意义）。
    """
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import inspect

    from app.core.config import PROJECT_ROOT

    # ① 迁移链建库（env.py 以 settings.DATABASE_URL 为准，故先把它指到临时库）
    mig_db = (tmp_path / "mig.db").as_posix()
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite:///{mig_db}")
    cfg = Config(str(PROJECT_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(PROJECT_ROOT / "alembic"))
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")

    e_mig = create_engine(f"sqlite:///{mig_db}")
    e_orm = create_engine("sqlite://")
    Base.metadata.create_all(e_orm)
    i_mig, i_orm = inspect(e_mig), inspect(e_orm)

    # ② 表集合一致
    assert set(i_orm.get_table_names()) == set(i_mig.get_table_names()) - {"alembic_version"}

    for table in sorted(Base.metadata.tables):
        cols_orm = {c["name"]: c for c in i_orm.get_columns(table)}
        cols_mig = {c["name"]: c for c in i_mig.get_columns(table)}
        assert set(cols_orm) == set(cols_mig), f"{table}: 列集合不一致"

        # ③ 可空性：以迁移链为准则（线上库都是迁移建的），只放行已知项
        for name in sorted(cols_orm):
            if cols_orm[name]["nullable"] != cols_mig[name]["nullable"]:
                key = f"{table}.{name}"
                assert key in _KNOWN_NULLABLE_DRIFT, (
                    f"{key}: 可空性漂移 ORM={cols_orm[name]['nullable']} "
                    f"迁移={cols_mig[name]['nullable']}（若是有意为之，加进 _KNOWN_NULLABLE_DRIFT）"
                )

        # ④ 索引名：ORM 多出来的只放行「主键上多余的 ix_*_id」
        #    （SQLite 的 INTEGER PRIMARY KEY 本身就是 rowid，查询计划走它，
        #      额外索引只是占空间；迁移链不建，create_all 会建）
        only_orm = {
            f"{table}.{i['name']}" for i in i_orm.get_indexes(table)
        } - {f"{table}.{i['name']}" for i in i_mig.get_indexes(table)}
        assert only_orm <= _KNOWN_ORM_ONLY_INDEXES, f"{table}: ORM 独有索引 {sorted(only_orm)}"
        only_mig = {
            f"{table}.{i['name']}" for i in i_mig.get_indexes(table)
        } - {f"{table}.{i['name']}" for i in i_orm.get_indexes(table)}
        assert not only_mig, f"{table}: 迁移独有索引 {sorted(only_mig)}（迁移建了 ORM 不知道的索引）"

        # ⑤ 唯一键（按列元组，不看名字——名字不是不变量的载体）
        def _uniques(insp):
            found = set()
            for uc in insp.get_unique_constraints(table):
                if uc.get("column_names"):
                    found.add(tuple(uc["column_names"]))
            for ix in insp.get_indexes(table):
                if ix.get("unique") and ix.get("column_names"):
                    found.add(tuple(ix["column_names"]))
            return found

        assert _uniques(i_orm) == _uniques(i_mig), (
            f"{table}: 唯一键不一致 ORM={sorted(_uniques(i_orm))} 迁移={sorted(_uniques(i_mig))}"
        )


# ── P0：账号统计快照（v0.5.0） ───────────────────────────────────────

def _snapshot_test_db():
    """内存 SQLite（StaticPool：所有连接共享同一库）+ 建全量表。"""
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    return engine, sessionmaker(bind=engine, autoflush=False, autocommit=False)


def test_account_fetch_writes_stat_snapshot(monkeypatch):
    """P0 验收：全量账号抓取成功后，每个账号落一条统计快照。

    端到端走 async_fetch_and_update 真路径（mock 掉网络抓取与节奏等待），
    验证 _record_stat_snapshot 挂在成功分支且随事务提交。
    """
    engine, Testing = _snapshot_test_db()
    db = Testing()
    v = VTuber(name="测试V")
    db.add(v)
    db.commit()
    db.refresh(v)
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="11073",
                  display_name="测试", followers_count=100,
                  live_status=1, live_title="今晚开播")
    db.add(acc)
    db.commit()
    db.refresh(acc)
    db.close()

    monkeypatch.setattr(scheduler, "SessionLocal", Testing)
    monkeypatch.setattr(scheduler.settings, "REQUEST_INTERVAL_MIN", 0.0)
    monkeypatch.setattr(scheduler.settings, "REQUEST_INTERVAL_MAX", 0.0)
    monkeypatch.setattr(scheduler.settings, "FETCH_BATCH_SIZE", 10 ** 9)
    monkeypatch.setattr(scheduler.settings, "FETCH_BATCH_COOLDOWN", 0)

    async def fake_fetch(acc, db, client=None):
        acc.followers_count += 1   # 模拟抓取到新粉丝数
        return True

    monkeypatch.setattr(scheduler, "_fetch_one_account", fake_fetch)

    result = asyncio.run(scheduler.async_fetch_and_update())
    assert result.success == 1

    db = Testing()
    rows = (
        db.query(AccountStatSnapshot)
        .filter(AccountStatSnapshot.account_id == acc.id)
        .all()
    )
    assert len(rows) == 1
    assert rows[0].followers_count == 101      # 记录的是抓取后的最新值
    assert rows[0].live_status == 1
    assert rows[0].live_title == "今晚开播"
    assert rows[0].captured_at is not None
    db.close()


def test_stat_snapshot_repo_recent_ordering():
    """只读端点数据源：按时间倒序 + limit 生效。"""
    engine, Testing = _snapshot_test_db()
    db = Testing()
    v = VTuber(name="V")
    db.add(v)
    db.commit()
    db.refresh(v)
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="1")
    db.add(acc)
    db.commit()
    db.refresh(acc)

    repo = AccountStatSnapshotRepo(db)
    repo.add(acc.id, 100, 0, None, captured_at=datetime(2026, 8, 1, tzinfo=timezone.utc))
    repo.add(acc.id, 120, 1, "标题", captured_at=datetime(2026, 8, 2, tzinfo=timezone.utc))
    db.commit()

    rows = repo.recent(acc.id, limit=1)
    assert len(rows) == 1
    assert rows[0].followers_count == 120
    assert rows[0].live_title == "标题"
    db.close()


# ── v0.6.1：时效分层调度（T0 独立线程 / T1·T2 手动优先跳过） ────────────

def test_live_sweep_core_applies_live_fields(monkeypatch):
    """T0 直播状态核（v0.6.1）：批量接口回写 live 字段；跳变落统计快照（直播日历 edge）。"""
    from app.services import scheduler as sch

    engine, Testing = _snapshot_test_db()
    db = Testing()
    v = VTuber(name="直播V")
    db.add(v)
    db.commit()
    db.refresh(v)
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="11073",
                  display_name="直播V", followers_count=100, live_status=0)
    db.add(acc)
    db.commit()
    db.refresh(acc)

    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MIN", 0.0)
    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MAX", 0.0)

    async def fake_batch(mids, client=None):
        assert mids == [11073]
        return {"11073": {"live_status": 1, "live_title": "今晚开播",
                          "room_id": "123", "live_url": "https://live.bilibili.com/123"}}

    monkeypatch.setattr(sch, "fetch_bilibili_live_batch", fake_batch)

    result = asyncio.run(sch.live_sweep_core(db))
    assert result.success == 1

    db.expire_all()
    acc2 = db.query(Account).first()
    assert acc2.live_status == 1
    assert acc2.live_title == "今晚开播"
    assert acc2.room_id == "123"
    rows = db.query(AccountStatSnapshot).filter(
        AccountStatSnapshot.account_id == acc.id).all()
    assert len(rows) == 1
    assert rows[0].live_status == 1
    db.close()


def test_account_stream_skips_when_account_busy(monkeypatch):
    """账号流手动优先：账号锁被占（手动抓取在跑）→ 跳过本轮，不进状态通道。"""
    from app.services import scheduler as sch

    assert sch._fetch_lock.acquire(blocking=False)
    try:
        result = asyncio.run(sch.async_fetch_and_update(auto=True))
    finally:
        sch._fetch_lock.release()
    assert result.success == 0
    assert sch.is_fetch_running() is False
    assert sch._status["account"]["running"] is False


def test_run_latest_dynamics_sweep_skips_when_post_busy(monkeypatch):
    """T2 手动优先：帖子锁被占（手动抓取在跑）→ 跳过本轮。"""
    from app.services import scheduler as sch

    assert sch._post_fetch_lock.acquire(blocking=False)
    try:
        out = asyncio.run(sch.run_latest_dynamics_sweep())
    finally:
        sch._post_fetch_lock.release()
    assert out["status"] == "skipped"
    assert sch.is_post_fetch_running() is False
    assert sch._status["post"]["running"] is False


# ── 手动任务优先（v0.9.3）：自动档给手动任务让位 ────────────────────────

class _FakeDb:
    """让位辅助函数只用到 db.commit()，单测不需要真会话。"""

    def commit(self) -> None:
        pass


def test_manual_task_running_excludes_auto_holder():
    """自动档持锁不算「手动任务在跑」：手动端点据此放行（不再 409），
    而真正的手动任务在跑时仍要挡住第二个手动请求。"""
    from app.services import scheduler as sch

    assert sch._fetch_lock.acquire(blocking=False)
    try:
        sch._auto_account_active.set()
        sch._fetch_running = True
        assert sch.any_fetch_running() is True
        assert sch.manual_task_running() is False     # 自动档 → 手动可抢占
        sch._auto_account_active.clear()
        assert sch.manual_task_running() is True      # 手动档 → 拒绝并发手动
    finally:
        sch._fetch_running = False
        sch._auto_account_active.clear()
        sch._fetch_lock.release()
    assert sch.manual_task_running() is False


def test_manual_acquire_does_not_steal_from_manual_holder():
    """手动之间不互相打断：锁被另一个手动任务持有时直接放弃，不置抢占信号。"""
    from app.services import scheduler as sch

    assert sch._fetch_lock.acquire(blocking=False)
    try:
        assert asyncio.run(sch._acquire_manual_account(wait_seconds=0.3)) is False
        assert sch._preempt_account.is_set() is False
    finally:
        sch._fetch_lock.release()


def test_auto_account_yields_to_manual_preempt():
    """核心语义：自动档在断点交还锁 → 手动任务拿到并跑完 → 自动档从断点拿回。

    自动侧跑在独立线程的独立事件循环里（与生产 tier-scheduler 线程一致），
    否则自动侧阻塞式 acquire 会把同一循环里的手动任务一起卡死。
    """
    import threading

    from app.services import scheduler as sch

    order: list[str] = []
    assert sch._fetch_lock.acquire(blocking=False)     # 模拟自动档已持锁在跑
    sch._auto_account_active.set()
    sch._fetch_running = True
    sch._fetch_scope = "full"

    def auto_side() -> None:
        async def run() -> None:
            await asyncio.sleep(0.3)
            yielded = await sch._maybe_preempt_account(_FakeDb())
            order.append(f"auto-resumed yielded={yielded} locked={sch._fetch_lock.locked()}")

        asyncio.run(run())

    async def manual_side() -> None:
        got = await sch._acquire_manual_account(wait_seconds=5)
        order.append(f"manual-acquired={got}")
        sch._fetch_scope = "single"                    # 手动任务会改这个全局标记
        await asyncio.sleep(0.3)                       # 手动任务干活
        sch._fetch_running = False
        sch._fetch_lock.release()

    t = threading.Thread(target=auto_side, daemon=True)
    t.start()
    try:
        asyncio.run(manual_side())
        t.join(timeout=10)
        assert not t.is_alive(), "自动档让位后没有恢复"
    finally:
        sch._fetch_running = False
        sch._auto_account_active.clear()
        sch._preempt_account.clear()
        if sch._fetch_lock.locked():
            sch._fetch_lock.release()

    assert order == ["manual-acquired=True", "auto-resumed yielded=True locked=True"]
    assert sch._fetch_scope == "full"                  # 让位返回后恢复本任务范围标记
    assert sch._preempt_account.is_set() is False
    sch._fetch_scope = None


def test_auto_post_yields_to_manual_preempt():
    """帖子侧同一套语义（T2 最新动态给「更新动态 / 抓取帖子」让位）。"""
    import threading

    from app.services import scheduler as sch

    order: list[str] = []
    assert sch._post_fetch_lock.acquire(blocking=False)
    sch._auto_post_active.set()
    sch._post_fetch_running = True

    def auto_side() -> None:
        async def run() -> None:
            await asyncio.sleep(0.3)
            yielded = await sch._maybe_preempt_post(_FakeDb())
            order.append(f"auto-resumed yielded={yielded} locked={sch._post_fetch_lock.locked()}")

        asyncio.run(run())

    async def manual_side() -> None:
        got = await sch._acquire_manual_post(wait_seconds=5)
        order.append(f"manual-acquired={got}")
        await asyncio.sleep(0.3)
        sch._post_fetch_running = False
        sch._post_fetch_lock.release()

    t = threading.Thread(target=auto_side, daemon=True)
    t.start()
    try:
        asyncio.run(manual_side())
        t.join(timeout=10)
        assert not t.is_alive(), "自动档让位后没有恢复"
    finally:
        sch._post_fetch_running = False
        sch._auto_post_active.clear()
        sch._preempt_post.clear()
        if sch._post_fetch_lock.locked():
            sch._post_fetch_lock.release()

    assert order == ["manual-acquired=True", "auto-resumed yielded=True locked=True"]


def test_auto_checkpoint_noop_without_request(db):
    """没有手动请求时断点检查是空操作（自动档不该无故让位）。"""
    from app.services import scheduler as sch

    assert sch._preempt_account.is_set() is False
    assert asyncio.run(sch._maybe_preempt_account(db)) is False


# ── 综合档（v0.9.3）：数据驱动账号流 + 按平台并发 + 外部批次等待 ──────────

def test_account_sweep_due_data_driven(db):
    """账号流到期判定：无 last_fetched_at（新收录）→ 到期；超过阈值 → 到期；
    新鲜 → 不到期（用户 2026-09-09 定稿：按上次抓取时间判断）。"""
    from app.services import scheduler as sch

    now = datetime(2026, 9, 9, 12, 0)
    v = VTuber(name="V")
    db.add(v)
    db.commit()
    db.refresh(v)
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="1")
    db.add(acc)
    db.commit()

    assert sch.account_sweep_due(db, now=now) is True          # 从未抓过
    acc.last_fetched_at = now - timedelta(hours=25)
    db.commit()
    assert sch.account_sweep_due(db, now=now) is True          # 超过 24h
    acc.last_fetched_at = now - timedelta(hours=1)
    db.commit()
    assert sch.account_sweep_due(db, now=now) is False         # 新鲜
    # 另一个账号过期 → 整体到期（任一账号过期即跑）
    acc2 = Account(vtuber_id=v.id, platform="weibo", platform_uid="2")
    db.add(acc2)
    db.commit()
    assert sch.account_sweep_due(db, now=now) is True


def test_run_platform_rounds_concurrent_across_platforms_serial_within():
    """按平台并发：不同平台同轮并行；同一平台内部串行且顺序不变。"""
    from app.services import scheduler as sch

    active = {"bilibili": 0, "weibo": 0}
    max_active = {"bilibili": 0, "weibo": 0}
    order: list[str] = []
    overlapped = {"v": False}

    async def worker(pf, item):
        active[pf] += 1
        max_active[pf] = max(max_active[pf], active[pf])
        if any(active[p] > 0 for p in active if p != pf):
            overlapped["v"] = True
        order.append(f"{pf}:{item}")
        await asyncio.sleep(0.05)
        active[pf] -= 1
        return sch._RoundOutcome(ok=True)

    groups = {"bilibili": ["a", "b", "c"], "weibo": ["x"]}
    out = asyncio.run(sch._run_platform_rounds(groups, worker))
    assert len(out) == 4
    assert max_active["bilibili"] == 1              # 平台内串行
    assert overlapped["v"] is True                  # 平台之间并行过
    assert [o for o in order if o.startswith("bilibili")] == [
        "bilibili:a", "bilibili:b", "bilibili:c"]


def test_run_platform_rounds_per_platform_parallel():
    """R6（2026-09-13）：`per_platform=N` → **同一平台内并发**抓 N 个，跨平台照旧并行。

    这是"分账号并行"的落点：默认 1 = 旧行为（平台内串行），动态流传 3。
    """
    from app.services import scheduler as sch

    active = {"bilibili": 0, "weibo": 0}
    peak = {"bilibili": 0, "weibo": 0}
    order: list[str] = []

    async def worker(pf, item):
        active[pf] += 1
        peak[pf] = max(peak[pf], active[pf])
        order.append(f"{pf}:{item}")
        await asyncio.sleep(0.05)
        active[pf] -= 1
        return sch._RoundOutcome(ok=True)

    groups = {"bilibili": ["a", "b", "c", "d"], "weibo": ["x", "y"]}
    out = asyncio.run(sch._run_platform_rounds(groups, worker, per_platform=3))
    assert len(out) == 6
    assert peak["bilibili"] == 3          # 一批 3 个并发（第 4 个排下一批）
    assert peak["weibo"] == 2             # 队列只有 2 个，就 2 个并发
    # 队内顺序不变（结果顺序 = 入队顺序）
    assert [o for o in order if o.startswith("bilibili")][:3] == [
        "bilibili:a", "bilibili:b", "bilibili:c"]


def test_platform_pacer_spaces_same_platform_but_not_across():
    """R6 的**风控面不变**保证：并发下同平台请求起跑仍被间隔开，跨平台互不阻塞。"""
    from app.services import scheduler as sch

    pacer = sch._PlatformPacer(0.15, 0.15)

    async def run():
        starts: list[tuple[str, float]] = []

        async def one(pf: str):
            await pacer.wait(pf)
            starts.append((pf, time.monotonic()))

        # 两个平台**同时**起跑：B 站 3 发排队、微博 2 发另开一条通道
        await asyncio.gather(one("bilibili"), one("weibo"), one("bilibili"),
                             one("weibo"), one("bilibili"))
        return starts

    starts = asyncio.run(run())
    bb = sorted(t for pf, t in starts if pf == "bilibili")
    wb = sorted(t for pf, t in starts if pf == "weibo")
    assert len(bb) == 3 and len(wb) == 2
    # 同平台：相邻起跑被拉开（≥ gap）
    assert bb[1] - bb[0] >= 0.10 and bb[2] - bb[1] >= 0.10
    assert wb[1] - wb[0] >= 0.10
    # 跨平台：两条通道互不排队 —— 两平台的首发几乎同时
    assert abs(wb[0] - bb[0]) < 0.10


def test_dynamics_next_due_honours_min_cycle_from_round_start(db, monkeypatch):
    """R6（2026-09-13 用户定）：「一轮 <1min → 休息至 1min」且**从轮开始计时**。

    旧写法是在轮**结束**后再等 `max(30, 预算等待) ± 抖动` —— 一轮 33s + 等 57s 的
    实际周期是 90s，而排期日志看起来只有 57s。现在给 `since`（轮开始时刻），
    到期时刻被抬到 `since + DYNAMICS_MIN_CYCLE_SECONDS`。
    """
    from app.services import scheduler as sch

    # 去掉抖动、用**空预算**（等待=0）→ 到期时刻只由 MIN_GAP 与周期下限决定，可精确断言
    monkeypatch.setattr(sch, "_tier_delay", lambda base, jitter=0.0: base)
    monkeypatch.setattr(sch, "_dynamics_budget", sch._PlatformBudget(12))
    monkeypatch.setattr(sch.settings, "DYNAMICS_MIN_CYCLE_SECONDS", 60.0)

    t0 = time.monotonic()
    due_without = sch._dynamics_next_due(db)
    due_with = sch._dynamics_next_due(db, since=t0)
    # 无 since：老行为 = now + max(MIN_GAP 30, 预算等待 0)
    assert 29.0 <= due_without - time.monotonic() <= 31.0
    # 有 since：被抬到「轮开始 + 60s」（下限赢过 30s）
    assert due_with >= t0 + 60.0 and due_with - t0 <= 61.0

    # 一轮本来就超过周期下限（since 在一小时前）→ 下限不再起作用，回到老行为
    due_old = sch._dynamics_next_due(db, since=time.monotonic() - 3600)
    assert 29.0 <= due_old - time.monotonic() <= 31.0


def test_run_platform_rounds_cools_down_single_platform():
    """某平台风控 → 该平台单独冷却，其它平台继续推进。"""
    from app.services import scheduler as sch

    calls: list[str] = []

    async def worker(pf, item):
        calls.append(f"{pf}:{item}")
        return sch._RoundOutcome(ok=True, rate_limited=(pf == "bilibili" and item == 1))

    groups = {"bilibili": [1, 2], "weibo": [1, 2]}
    asyncio.run(sch._run_platform_rounds(groups, worker, cooldown_seconds=0.3))
    assert calls.count("bilibili:2") == 1 and calls.count("weibo:2") == 1
    assert calls.index("weibo:2") < calls.index("bilibili:2")


def test_combined_tier_runs_both_streams_concurrently(monkeypatch):
    """综合档：动态流与账号流同时起跑（墙钟 ≈ max(两条流)，而不是串行相加）。"""
    from app.services import scheduler as sch

    started: list[str] = []

    async def fake_dynamics():
        started.append("dynamics")
        await asyncio.sleep(0.2)
        return {"status": "done"}

    async def fake_account(auto=False):
        started.append("account")
        await asyncio.sleep(0.2)
        return sch.FetchResult(success=1)

    monkeypatch.setattr(sch, "run_latest_dynamics_sweep", fake_dynamics)
    monkeypatch.setattr(sch, "async_fetch_and_update", fake_account)
    monkeypatch.setattr(sch, "_account_sweep_due_now", lambda db: True)

    t0 = time.monotonic()
    out = asyncio.run(sch._run_combined_tier(dynamics=True, account=None))
    elapsed = time.monotonic() - t0

    assert set(started) == {"dynamics", "account"}
    assert elapsed < 0.35, f"两条流没有并发（耗时 {elapsed:.2f}s）"
    assert out["dynamics"]["status"] == "done"
    assert out["account"].success == 1


def test_wait_for_manual_tasks_waits_then_runs():
    """T4 外部批次：手动任务在跑时排队等待，结束后继续执行（不再直接跳过）。"""
    import threading

    from app.services import scheduler as sch

    sch._fetch_running = True

    def clear_soon() -> None:
        time.sleep(0.3)
        sch._fetch_running = False

    t = threading.Thread(target=clear_soon, daemon=True)
    t.start()
    try:
        assert sch._wait_for_manual_tasks(timeout_seconds=5, poll_seconds=0.05) is True
    finally:
        t.join(timeout=2)
        sch._fetch_running = False


def test_wait_for_manual_tasks_times_out():
    """等待超时 → 放弃本轮（不阻塞 APScheduler 线程池）。"""
    from app.services import scheduler as sch

    sch._fetch_running = True
    try:
        assert sch._wait_for_manual_tasks(timeout_seconds=0.3, poll_seconds=0.05) is False
    finally:
        sch._fetch_running = False


def test_manual_single_v_fetch_preempts_running_auto_sweep(monkeypatch):
    """用户场景（2026-09-08）：综合档账号流正在跑时收录新 V，
    单V抓取必须抢占自动档并真的抓到账号信息（修复前是直接"跳过"→ 账号空白）。

    自动侧走 `async_fetch_and_update(auto=True)` 真路径（v0.9.3 后的账号流），
    网络抓取换成带 sleep 的假实现；手动侧走 async_fetch_vtuber 真路径。
    """
    import threading

    from app.services import scheduler as sch

    engine, Testing = _snapshot_test_db()
    db = Testing()
    old_v = VTuber(name="老账号V")
    new_v = VTuber(name="新收录V")
    db.add_all([old_v, new_v])
    db.commit()
    db.refresh(old_v)
    db.refresh(new_v)
    db.add(Account(vtuber_id=old_v.id, platform="bilibili", platform_uid="100",
                   display_name="老账号"))
    db.add(Account(vtuber_id=new_v.id, platform="bilibili", platform_uid="200",
                   display_name="新账号"))
    db.commit()
    new_v_id = new_v.id
    db.close()

    monkeypatch.setattr(sch, "SessionLocal", Testing)
    monkeypatch.setattr(sch.settings, "REQUEST_INTERVAL_MIN", 0.0)
    monkeypatch.setattr(sch.settings, "REQUEST_INTERVAL_MAX", 0.0)

    fetched: list[str] = []
    auto_started = threading.Event()

    async def fake_fetch(acc, db, client=None, *, pending_avatar=None):
        uid = str(acc.platform_uid)
        fetched.append(uid)
        if uid == "100":                         # 自动档首个账号：慢，留出抢占窗口
            auto_started.set()
            await asyncio.sleep(0.5)
        else:
            await asyncio.sleep(0.05)
        acc.followers_count = 42
        return True

    monkeypatch.setattr(sch, "_fetch_one_account", fake_fetch)

    auto_done: list[str] = []

    def auto_side() -> None:
        asyncio.run(sch.async_fetch_and_update(auto=True))
        auto_done.append("done")

    async def manual_side():
        # 等自动档真的进了第一个账号（否则可能先拿到锁，测不到抢占）
        for _ in range(250):
            if auto_started.is_set():
                break
            await asyncio.sleep(0.02)
        assert auto_started.is_set(), "自动档没有开始"
        return await sch.async_fetch_vtuber(new_v_id)

    t = threading.Thread(target=auto_side, daemon=True)
    t.start()
    try:
        manual_result = asyncio.run(manual_side())
        t.join(timeout=15)
        assert not t.is_alive(), "自动档没有恢复（可能死锁）"
    finally:
        for lock in (sch._fetch_lock,):
            if lock.locked():
                lock.release()
        sch._fetch_running = False
        sch._auto_account_active.clear()
        sch._preempt_account.clear()
        sch._fetch_scope = None

    # 手动任务确实跑到了（不是被"跳过"）
    assert manual_result.success == 1
    assert "跳过" not in " ".join(manual_result.details)
    # 顺序：自动档先抓老账号 → 让位 → 手动抓新账号 → 自动档续跑（再遍历到新账号）
    assert fetched == ["100", "200", "200"]
    assert auto_done == ["done"]

    db = Testing()
    try:
        acc = db.query(Account).filter(Account.platform_uid == "200").one()
        assert acc.followers_count == 42           # 账号信息落库
        # 两次成功抓取各落一条快照：手动单V 一次 + 自动账号流续跑时又一次
        # （v0.9.3 起账号流与 T3a 同口径，成功即写快照；原 T1 是不写的）
        assert db.query(AccountStatSnapshot).filter(
            AccountStatSnapshot.account_id == acc.id).count() == 2
    finally:
        db.close()


def test_fetch_posts_core_limit_latest(monkeypatch, db):
    """启动链阶段 3：「最新 N 条」模式——同页最多入库 N 条新帖即停（不翻页）。"""
    from app.services import scheduler as sch

    items = [_post_item(pid) for pid in ("N1", "N2", "N3", "N4")]

    async def fake_dynamics(mid, offset="", client=None):
        return {"items": items, "has_more": True, "next_offset": "p2"}

    async def fake_detail(_id, client=None):
        return None

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(sch, "fetch_bilibili_dynamics", fake_dynamics)
    monkeypatch.setattr(sch, "fetch_dynamic_detail", fake_detail)
    monkeypatch.setattr("asyncio.sleep", fake_sleep)

    async def run():
        return await sch._fetch_posts_core(123, 0, 3, db, include_videos=False,
                                           stop_on_existing=True, limit_latest=2)

    r = asyncio.run(run())
    assert r.stored == 2
    assert r.dynamics == 2                    # 仅处理 2 条即停
    assert db.query(PostModel).count() == 2   # N3/N4 未入库，留待下次渐进消化


# ── 风控冷却的状态暴露（R12a，devlog/089）─────────────────────────────
# 此前风控**只写日志**：界面上看不到"被限流了、正在冷却"，用户只感到任务变慢或没结果。
# 顶栏状态岛要靠 `fetch_status.rate_limit` 显示这条告警，因此这里把契约钉住。

def test_fetch_status_exposes_rate_limit_cooldown(monkeypatch):
    from app.services import scheduler as sch

    # R27：状态改成**按平台**存在 `_rl_states` 里、并落 app_meta。
    # 本用例只管**显示契约**（落库/重启读回见 tests/test_rate_limit.py），所以落库打成空操作。
    monkeypatch.setattr(sch, "_rl_states", {})
    monkeypatch.setattr(sch, "_rl_persist", lambda state: None)
    assert sch.get_fetch_status()["rate_limit"] == {
        "active": False, "reason": "", "seconds_left": 0, "platform": "", "hits": 0}

    sch._note_rate_limit("code=-352, msg=风控校验失败", 600, "bilibili")
    rl = sch.get_fetch_status()["rate_limit"]
    assert rl["active"] is True
    assert "-352" in rl["reason"]
    assert 590 <= rl["seconds_left"] <= 600, rl
    assert rl["platform"] == "bilibili" and rl["hits"] == 1     # R27 新增的两个字段

    # 冷却窗口过去 → 自动回到 inactive（顶栏告警随之消失，不需要额外清理）
    sch._rl_states["bilibili"] = sch.rl.State(platform="bilibili", until=time.time() - 1, hits=1)
    assert sch.get_fetch_status()["rate_limit"]["active"] is False
