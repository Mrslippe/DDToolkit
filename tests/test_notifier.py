"""桌面通知（R50，devlog/219）：文案 / 开关 / 降噪 / 投递链路。

判错的两个代价（与 `test_runtime_settings.py` 同款思路）：
① **弹了不该弹的**：首次收录一口气入库几十条，若照单通知，用户开机就被刷屏 ——
   通知一旦变成噪音，用户就会把它整个关掉，那这个功能等于没做；
② **该弹的没弹**：去重键 / 限流 / 开关任何一处写反，表现都是"什么都没发生"，
   而界面上完全看不出来（这正是本仓最怕的那类失败）。

所以断言分三层：**文案**（点哪去、说什么）、**闸门**（开关与降噪）、**链路**
（投递判据 + 端点）。
"""
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import runtime_settings as rs
from app.core.config import settings
from app.core.database import Base, get_db
from app.main import app
from app.services import notifier


@pytest.fixture
def db():
    """内存库（StaticPool：TestClient 把同步端点丢到工作线程跑，默认池会给它另一条连接）。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture
def client(db):
    """HTTP 层：把 `get_db` 指到内存库（**不碰开发库**），用完恢复。"""
    prev = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    if prev is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev


@pytest.fixture(autouse=True)
def _clean_state():
    """通知状态是**进程级全局**（去重/限流/最近投递），漏一条就会串到别的用例。"""
    notifier.reset_state()
    rs.clear()
    yield
    notifier.reset_state()
    rs.clear()


@pytest.fixture
def sent():
    """把投递换成同步收集：不起线程、不建窗、不弹真卡片。"""
    got: list = []
    notifier.set_sink(got.append)
    yield got


# ── 文案：点哪去、说什么 ─────────────────────────────────────────────

def test_compose_live_start_text():
    item = notifier.compose_live_start("明前奶绿", live_title="看日剧喵",
                                       platform_uid="12345")
    assert item.title == "明前奶绿 开播了"
    assert "B站直播间" in item.body and "看日剧喵" in item.body
    assert item.kind == notifier.KIND_LIVE
    assert item.key == "live:bilibili:12345"


def test_compose_live_start_click_target_prefers_url_then_room_then_home():
    """点击目标优先级：直播间 url → 由房间号拼的直播链接 → 主播主页。

    `room_id` 这一档是实测补的：B 站账号的 `live_url` 常常是空的，少了它用户点了
    卡片只会落到主播主页，而不是**正在播的那一间**。
    """
    explicit = notifier.compose_live_start("X", url="https://live.bilibili.com/9")
    assert explicit.url == "https://live.bilibili.com/9"

    by_room = notifier.compose_live_start("X", room_id="22637261")
    assert by_room.url == "https://live.bilibili.com/22637261"

    # 房间号不是数字（上游字段脏了）→ 当作没有，退回主页
    fallback = notifier.compose_live_start("X", room_id="not-a-number",
                                           platform_uid="12345")
    assert fallback.url == "https://space.bilibili.com/12345"

    # 三者都没有 → 这条通知不可点（不编一个假链接）
    assert notifier.compose_live_start("X").url is None


def test_account_home_url_matches_frontend_convention():
    assert notifier.account_home_url("bilibili", "123") == "https://space.bilibili.com/123"
    assert notifier.account_home_url("weibo", "456") == "https://weibo.com/u/456"
    assert notifier.account_home_url("bilibili", "") is None


def test_compose_new_posts_merges_counts_and_types():
    item = notifier.compose_new_posts("明前奶绿", "bilibili", [
        {"platform_post_id": "1", "type": "video", "title": "新投稿",
         "permalink": "https://www.bilibili.com/video/BV1"},
        {"platform_post_id": "2", "type": "dynamic", "title": "转发",
         "permalink": "https://t.bilibili.com/2"},
    ])
    assert item is not None
    assert item.title == "明前奶绿 更新了动态"
    assert "2 条新内容" in item.body and "投稿" in item.body
    # 一个 V 一轮只一条：点它开**最新那条**（列表里没有选择余地）
    assert item.url == "https://www.bilibili.com/video/BV1"
    assert item.key == "post:bilibili:1,post:bilibili:2"


def test_compose_new_posts_without_items_returns_none():
    assert notifier.compose_new_posts("X", "bilibili", []) is None
    assert notifier.compose_new_posts("X", "bilibili", [{}]) is None


def test_long_text_is_trimmed_to_limits():
    item = notifier.compose_new_posts("很长" * 40, "bilibili", [
        {"platform_post_id": "1", "type": "dynamic", "title": "标题" * 200},
    ])
    assert item is not None
    assert len(item.title) <= notifier.TITLE_LIMIT
    assert len(item.body) <= notifier.BODY_LIMIT


# ── 闸门：开关与降噪 ─────────────────────────────────────────────────

def test_master_switch_blocks_everything(sent):
    rs.apply({"NOTIFY_ENABLED": False})
    assert notifier.notify("live", "T", "B") is False
    assert notifier.notify("test", "T", "B") is False       # 测试通知也走总开关
    assert sent == []


def test_kind_switch_blocks_only_that_kind(sent):
    """关掉「开播提醒」不该连带关掉动态提醒；而**测试通知不受这两个开关影响**。"""
    rs.apply({"NOTIFY_LIVE": False})
    assert notifier.notify("live", "开播", "B") is False
    assert notifier.notify("post", "动态", "B") is True
    assert notifier.notify("test", "测试", "B") is True
    assert [n.kind for n in sent] == ["post", "test"]


def test_same_event_is_deduped(sent):
    """同一场直播 / 同一条帖子被两个调用点弹两次 —— 去重键挡的就是这个。"""
    assert notifier.notify("live", "T", "B", key="live:bilibili:1") is True
    assert notifier.notify("live", "T", "B", key="live:bilibili:1") is False
    assert len(sent) == 1

    # 新动态按**帖子级**去重：同一批里只要有一条见过，整条通知就不再弹
    items = [{"platform_post_id": "10", "type": "video", "title": "A"}]
    assert notifier.notify_new_posts("V", "bilibili", items) is True
    assert notifier.notify_new_posts("V", "bilibili", items) is False
    assert len(sent) == 2


def test_rate_limit_drops_extra_and_test_notification_is_exempt(sent):
    """限流：窗口内超出上限的**丢弃并记日志**（不排队补弹）；测试通知不吃配额。"""
    monkey = settings.__dict__
    monkey["NOTIFY_RATE_MAX"] = 3
    try:
        for i in range(5):
            notifier.notify("post", f"T{i}", "B", key=f"k{i}")
        # 测试通知 force=True：连点不该被自己人限流（实测踩过：拖滑杆连测 8 次后按钮"失效"）
        for i in range(5):
            notifier.notify("test", f"测试{i}", "B", key=f"t{i}", force=True)
    finally:
        monkey.pop("NOTIFY_RATE_MAX", None)
    assert len([n for n in sent if n.kind == "post"]) == 3
    assert len([n for n in sent if n.kind == "test"]) == 5


def test_invisible_emoji_modifiers_are_stripped():
    """变体选择符/零宽字符在 GDI 里会画成空方块 —— 落库前就该剥掉（emoji 本体保留）。"""
    item = notifier.compose_new_posts("V", "bilibili", [
        {"platform_post_id": "1", "type": "dynamic", "title": "弹幕\ufe0f❤️‍🔥测试\u200b"},
    ])
    assert item is not None
    assert "\ufe0f" not in item.body and "\u200b" not in item.body
    assert "测试" in item.body


# ── 链路：投递判据 + 端点 ───────────────────────────────────────────

def test_queue_path_records_delivery_verdict():
    """不装 sink → 走**真实队列**：投递线程跑完后 `last_delivery()` 必须有判据。

    这条是「发一条测试通知」端点赖以工作的那一半 —— 端点就是轮询它来回答
    "到底弹没弹"（而不是自己猜一个成功）。注意断言只要求**判据被记下**：
    有没有真的弹出来取决于运行环境（无头 CI 里弹不出来，`popup=False` 也算如实记录）。
    """
    notifier.notify("test", "标题", "正文", key="queue-path-1", force=True)
    deadline = time.monotonic() + 5.0
    got: dict = {}
    while time.monotonic() < deadline:
        got = notifier.last_delivery() or {}
        if got.get("title") == "标题":
            break
        time.sleep(0.05)
    notifier.stop_worker()
    assert got.get("title") == "标题", "投递线程没有回写判据（端点会误报「没发出去」）"
    assert "popup" in got and "detail" in got


def test_test_notification_endpoint_returns_verdict(client):
    """端点必须**真的走一遍投递**再回答：它存在的意义就是"验通道"。

    这里不弹真卡片（测试环境没有桌面），所以判据是"队列收下了 + 如实带回原因"，
    而不是静默成功。
    """
    body = client.post("/settings/test-notification").json()
    assert body["queued"] is True and body["title"]
    assert set(body) >= {"queued", "title", "body", "popup", "icon", "detail"}


# ── 测试通知的取材（R50b，devlog/226）────────────────────────────────
# 用户口径（2026-09-27）：「测试通知修改为固定发送明前奶绿的最新动态」——
# 通用文案验不出真实观感（没头像、标题太短、点进去是示例站）。

def _seed_demo_vtuber(db, *, dynamic_at=None, video_at=None):
    """造一个「明前奶绿」+ 她的动态/投稿（用来验测试通知的取材）。"""
    from app.models.vtuber import Account, Post, VTuber

    v = VTuber(name="明前奶绿")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="22603245",
                  url="https://space.bilibili.com/22603245")
    db.add(acc)
    db.commit()
    if dynamic_at:
        db.add(Post(platform="bilibili", platform_uid="22603245", platform_post_id="900",
                    type="dynamic", title="今晚十点半来播", summary="晚安电台聊聊天",
                    permalink="https://t.bilibili.com/900", published_at=dynamic_at))
    if video_at:
        db.add(Post(platform="bilibili", platform_uid="22603245", platform_post_id="901",
                    type="video", title="新投稿：看日剧", summary="本期聊日剧",
                    permalink="https://www.bilibili.com/video/BV1xx", published_at=video_at))
    db.commit()
    return v, acc


def test_test_notification_sends_the_demo_vtuber_latest_dynamic(db, client, sent):
    """测试通知取的必须是**她的真实动态**：标题、正文、点击目标、头像都来自那条帖子。"""
    _seed_demo_vtuber(db, dynamic_at=datetime(2026, 9, 26, 12, 0))
    body = client.post("/settings/test-notification").json()
    assert body["title"] == "明前奶绿 更新了动态"
    assert "今晚十点半来播" in body["body"]
    # 点一下要能打开**那条帖子**（而不是示例站）
    assert body["url"] == "https://t.bilibili.com/900"
    assert body["source"] == "明前奶绿 的最新动态（动态）"


def test_test_notification_takes_the_newest_one_regardless_of_type(db, client, sent):
    """「最新」= 时间上最新，**不按类型挑**。

    实测她的动态流里是「图文 / 转发」两类（B 站把带图的动态建成 `image`、纯文字才是
    `dynamic`）：按 `type='dynamic'` 挑反而会挑到更旧的一条（2026-09-27 踩到）。
    """
    _seed_demo_vtuber(db, dynamic_at=datetime(2026, 9, 20, 12, 0),
                      video_at=datetime(2026, 9, 26, 12, 0))
    body = client.post("/settings/test-notification").json()
    assert body["source"] == "明前奶绿 的最新动态（投稿）"
    assert body["url"] == "https://www.bilibili.com/video/BV1xx"


def test_test_notification_stays_on_the_demo_vtuber_when_data_is_absent(db, client, sent):
    """库里没有她（或她还没有帖子）→ 仍然是**她**的通知，只是退成「最小卡片」。

    用户口径（2026-09-27）：「无论用户库里有没有明前奶绿动态，都默认调取明前奶绿最新动态，
    不再调用通用文案」—— 所以这里**不许**再出现 "DDtoolkit 测试通知" 那种另一种长相，
    也不编造内容（正文只剩"1 条新内容"），并且**仍然要弹**（不能点了没反应）。
    """
    body = client.post("/settings/test-notification").json()
    assert body["title"] == "明前奶绿 更新了动态"
    assert body["source"].startswith("明前奶绿")
    assert "1 条新内容" in body["body"]
    assert "DDtoolkit 测试通知" not in body["title"]


def test_test_notification_can_be_clicked_repeatedly(db, client, sent):
    """连点多次都要弹（一次性去重键）：否则第二次点看起来像"按钮坏了"。

    走 sink 才能数清"投递了几次"——真实队列那条路只留最后一次判据。
    """
    _seed_demo_vtuber(db, dynamic_at=datetime(2026, 9, 26, 12, 0))
    client.post("/settings/test-notification")
    client.post("/settings/test-notification")
    assert len([n for n in sent if n.kind == "test"]) == 2


def test_icon_size_follows_font_scale():
    """大字号下图标要按**目标尺寸**重新栅格化（2026-09-27）：只按 DPI 取，
    300% 时等于把 48px 拉大到 135px，头像糊成一团。"""
    settings.NOTIFY_FONT_PCT = 150
    try:
        base = notifier._icon_base_size()
    finally:
        del settings.__dict__["NOTIFY_FONT_PCT"]
    settings.NOTIFY_FONT_PCT = 300
    try:
        big = notifier._icon_base_size()
    finally:
        del settings.__dict__["NOTIFY_FONT_PCT"]
    assert base >= 32 and big > base


# ── 「开播」的判据：轮播（live_status=2）不是开播（2026-09-27 用户实测）──────
# 现象：用户在下播时间收到"明前奶绿 开播了"。根因：T0 的 `started` 写成
# `bool(live_status) and not prev_status`，而 B 站 **2 = 轮播/录播循环**
# （主播下播后常挂着）⇒ `0 → 2` 被当成开播。

def _sweep_with_status(db, monkeypatch, status: list[int]):
    """跑一遍 T0 直播状态核，`fetch_bilibili_live_batch` 换成固定返回。"""
    import asyncio

    from app.services import scheduler

    async def fake_batch(uids, client=None):
        return {str(u): {"live_status": status[0], "live_title": "测试标题",
                         "room_id": 25034104} for u in uids}

    monkeypatch.setattr(scheduler, "fetch_bilibili_live_batch", fake_batch)
    # 批间停顿是给真轮询用的：测试要的是状态机，不必等（见 config 的 STARTUP_LIVE_INTERVAL_*）
    for key, val in (("STARTUP_LIVE_INTERVAL_MIN", 0.0), ("STARTUP_LIVE_INTERVAL_MAX", 0.0)):
        scheduler.settings.__dict__[key] = val
    try:
        return asyncio.run(scheduler.live_sweep_core(db))
    finally:
        for key in ("STARTUP_LIVE_INTERVAL_MIN", "STARTUP_LIVE_INTERVAL_MAX"):
            scheduler.settings.__dict__.pop(key, None)


def _seed_live_account(db, live_status: int = 0):
    from app.models.vtuber import Account, VTuber

    v = VTuber(name="明前奶绿")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="22603245",
                  live_status=live_status, room_id="25034104")
    db.add(acc)
    db.commit()
    return acc


def test_live_sweep_does_not_notify_on_round_play(db, sent, monkeypatch):
    """0 → 2（轮播）**不是开播**：这是用户实测的那条假提醒。"""
    _seed_live_account(db, live_status=0)
    _sweep_with_status(db, monkeypatch, [2])
    assert [n.kind for n in sent] == []


def test_live_sweep_notifies_on_real_start_only(db, sent, monkeypatch):
    """真开播（0 → 1）与"轮播转直播"（2 → 1）要通知；转到轮播（1 → 2）不通知。

    ⚠️ 阶段之间 `reset_state()`：同一场直播不重复弹是**本来的设计**（去重键
    `live:{平台}:{uid}` 带 TTL），而这里要验的是"进入沿"本身，所以把记账清干净再跑下一段。
    """
    _seed_live_account(db, live_status=0)
    status = [2]
    _sweep_with_status(db, monkeypatch, status)          # 0 → 2（轮播）
    assert [n.kind for n in sent] == []

    sent.clear()                       # 夹具给的收集列表是同一个对象，清记账时一起清
    notifier.reset_state()
    notifier.set_sink(sent.append)
    status[0] = 1
    _sweep_with_status(db, monkeypatch, status)          # 2 → 1（轮播转直播）
    assert [n.kind for n in sent] == ["live"]
    assert "开播了" in sent[0].title

    sent.clear()
    notifier.reset_state()
    notifier.set_sink(sent.append)
    status[0] = 2
    _sweep_with_status(db, monkeypatch, status)          # 1 → 2（转轮播）
    assert [n.kind for n in sent] == []

    status[0] = 1
    _sweep_with_status(db, monkeypatch, status)          # 2 → 1（再开播）
    assert [n.kind for n in sent] == ["live"]


# ── 与调度器的接缝：什么时候**不**该通知 ─────────────────────────────

def test_new_posts_helper_uses_id_watermark(db):
    """新帖判定用主键水位 + **发布时间水位**：只对"这一轮入库且比已有的更新"开口。

    这是"首次收录/回填不通知"的实现基础（`_post_mark` 的三个返回值）。
    """
    from app.models.vtuber import Account, Post, VTuber
    from app.services import scheduler

    v = VTuber(name="明前奶绿")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid="1")
    db.add(acc)
    db.commit()

    mark, count, newest = scheduler._post_mark(db, acc)
    assert (mark, count, newest) == (0, 0, None)   # 首次抓取前：空库 → 调用方据此不通知

    db.add(Post(platform="bilibili", platform_uid="1", platform_post_id="100",
                type="dynamic", title="第一条", published_at=datetime(2026, 9, 20, 10, 0)))
    db.commit()
    mark2, count2, newest2 = scheduler._post_mark(db, acc)
    assert count2 == 1 and mark2 > mark and newest2 == datetime(2026, 9, 20, 10, 0)

    # 回填：入库一条**比已有的更老**的内容（id 更大，但发布时间更早）⇒ 不算新帖
    db.add(Post(platform="bilibili", platform_uid="1", platform_post_id="099",
                type="dynamic", title="补档的老内容",
                published_at=datetime(2026, 9, 1, 10, 0)))
    db.commit()
    got: list = []
    notifier.set_sink(got.append)
    scheduler._notify_new_posts(db, acc, mark2, newest2)
    assert got == []                       # ← 用户口径："刚添加账号时不要推送"

    # 真新帖：发布时间晚于水位 ⇒ 通知，且只报它
    db.add(Post(platform="bilibili", platform_uid="1", platform_post_id="101",
                type="video", title="第二条", published_at=datetime(2026, 9, 26, 12, 0)))
    db.commit()
    scheduler._notify_new_posts(db, acc, mark2, newest2)
    assert len(got) == 1
    assert "第二条" in got[0].body            # 只通知水位之后入库、且比水位更新的那条
    assert got[0].title == "明前奶绿 更新了动态"


def test_notify_new_posts_swallows_errors(db, monkeypatch):
    """通知出任何事都不许拖累抓取：`_notify_new_posts` 必须自己吞掉异常。"""
    from app.services import scheduler

    def boom(*_a, **_k):
        raise RuntimeError("上游炸了")

    monkeypatch.setattr(notifier, "notify_new_posts", boom)
    scheduler._notify_new_posts(db, object(), 0, datetime(2026, 9, 1))   # 不抛 = 通过
