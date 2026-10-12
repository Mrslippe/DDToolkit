# -*- coding: utf-8 -*-
"""v0.9.x 直播日历内容管道 M1-M2 后端测试：
- LiveSessionRepo.upsert_danmakus：幂等 upsert（live_id 唯一）、字段映射、无效跳过
- LiveSessionRepo.merged：表内场次 ∪ self 快照（±90min 窗口合并、双源标记、
  未匹配快照→self 虚拟场次）；M2：danmakus/feed 同场去重（组内主数据优先）
- LiveSessionRepo.upsert_feed：其他数据源接入接口（M2 live_rcmd 路由）
- fetcher._map_live_rcmd：直播开播卡片 → type='live' 场次记录
- live_type.infer_category：title/area/date 信号栈 + fallback
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import (Account, AccountStatSnapshot, LiveSession,
                               VTuber)
from app.repositories.vtuber_repo import AccountStatSnapshotRepo, LiveSessionRepo
from app.services.fetcher import _map_live_rcmd
from app.domain.text import normalize_title          # M1a：家已下沉到 domain（devlog/213）
from app.services.live_type import (
    infer_category, score_title, plan_series, build_learned,
)

T0 = datetime(2026, 9, 1, 12, 0, 0)


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _mk_account(db, uid="10086", platform="bilibili") -> Account:
    v = VTuber(name="测试V", birthday="09-01")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform=platform, platform_uid=uid)
    db.add(acc)
    db.commit()
    return acc


def _snap(db, acc, ts, status=None, fans=1, source="self", title=None):
    db.add(AccountStatSnapshot(account_id=acc.id, followers_count=fans,
                               live_status=status, captured_at=ts, source=source,
                               live_title=title))
    db.commit()


def _dm_item(live_id, title, start_ms, stop_ms=0, area="游戏",
             parent="网络游戏", income=None, count=50):
    return {
        "liveId": live_id, "title": title, "startDate": start_ms,
        "stopDate": stop_ms, "parentArea": parent, "area": area,
        "totalIncome": income, "maxOnlineCount": 100, "danmakusCount": count,
        "coverUrl": None,
    }


EPOCH = datetime(1970, 1, 1)


def _ms(dt: datetime) -> int:
    """naive UTC 约定（库内时间列均为 naive UTC）→ 毫秒 epoch。"""
    return int((dt - EPOCH).total_seconds() * 1000)


# ── upsert_danmakus ────────────────────────────────────────────────

def test_upsert_danmakus_insert_and_update(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    items = [
        _dm_item("live-a", "杂谈回", _ms(T0), _ms(T0 + timedelta(hours=2)),
                 area="虚拟日常", parent="虚拟主播", income=123.5),
        _dm_item("live-b", "歌回", _ms(T0 + timedelta(days=1))),
    ]
    res = repo.upsert_danmakus(acc.id, platform=acc.platform, items=items)
    assert res == {"added": 2, "updated": 0, "skipped": 0}

    # 幂等：重跑不新增；可变字段刷新
    items[0]["totalIncome"] = 999.0
    res = repo.upsert_danmakus(acc.id, platform=acc.platform, items=items)
    assert res == {"added": 0, "updated": 2, "skipped": 0}
    rows = repo.list_by_account(acc.id)
    assert len(rows) == 2
    assert rows[0].total_income == 999.0
    assert rows[0].source == "danmakus"
    assert rows[0].end_at == T0 + timedelta(hours=2)
    assert rows[0].area_name == "虚拟日常"


def test_upsert_danmakus_writes_the_platform_the_caller_gave(db):
    """平台来自**调用方**，不是仓库写死的 `"bilibili"`（M1a，devlog/213）。

    ⚠️ 这里刻意用一个**非 bilibili** 的平台：写死那版会把它悄悄存成 bilibili，
    而行数/字段断言全都照样绿 —— 只有断言 platform 本身才看得见。
    """
    acc = _mk_account(db, platform="weibo")
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, [_dm_item("live-w", "播了", _ms(T0))],
                         platform=acc.platform)
    row = db.query(LiveSession).filter(LiveSession.live_id == "live-w").one()
    assert row.platform == "weibo", "仓库层又把平台写死了（调用方给的是 weibo）"


def test_upsert_danmakus_skips_invalid(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    res = repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        {"liveId": "", "startDate": _ms(T0)},                 # 无 live_id
        {"liveId": "live-x", "startDate": 0},                 # 无开始时间
        {"liveId": "live-y", "startDate": "bad"},             # 非法时间
    ])
    assert res == {"added": 0, "updated": 0, "skipped": 3}
    assert repo.list_by_account(acc.id) == []


def test_upsert_feed_interface(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    added = repo.upsert_feed(acc.id, "736525563447432921", {
        "title": "无限流游戏", "start_at": T0,
        "parent_area_name": "单机游戏", "area_name": "主机游戏",
    })
    assert added is True
    rows = repo.list_by_account(acc.id)
    assert len(rows) == 1
    assert rows[0].source == "feed"
    assert repo.upsert_feed(acc.id, "736525563447432921", {"title": "新标题"}) is False
    assert repo.list_by_account(acc.id)[0].title == "新标题"


# ── merged ─────────────────────────────────────────────────────────

def test_merged_snapshot_patches_danmakus_end(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    # danmakus 场次：直播中（无 end）
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("live-a", "周六来唱歌！", _ms(T0), 0, area="虚拟Singer",
                 parent="虚拟主播", income=10501.5),
    ])
    # self 快照：±90min 内开场，20 分钟后收场
    _snap(db, acc, T0 - timedelta(minutes=5), status=0)
    _snap(db, acc, T0, status=1)
    _snap(db, acc, T0 + timedelta(minutes=20), status=0)

    merged = repo.merged(acc.id)
    assert len(merged) == 1
    m = merged[0]
    assert m["source"] == "danmakus+self"
    assert m["start_at"] == T0                       # danmakus 起点为准
    assert m["end_at"] == T0 + timedelta(minutes=20)  # 快照补 end
    assert m["duration_minutes"] == 20
    assert m["live_title"] == "周六来唱歌！"
    assert m["total_income"] == 10501.5
    assert m["area_name"] == "虚拟Singer"


def test_merged_finalized_row_stays_two_when_far(db):
    """表内场次**已收播**（有 end）且 3h 外才有 self 观测 → 是另一场，不合并
    （防「区间重叠优先」过度合并）。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("live-a", "早场", _ms(T0), _ms(T0 + timedelta(hours=1))),
    ])
    _snap(db, acc, T0 + timedelta(hours=3), status=1, title="晚场")
    _snap(db, acc, T0 + timedelta(hours=4), status=0)

    merged = repo.merged(acc.id)
    assert len(merged) == 2
    assert [m["source"] for m in merged] == ["danmakus", "self"]


def test_merged_open_ended_row_absorbs_later_snapshot(db):
    """表内场次无 end（进行中/未定稿）→ 3h 后的 self 观测仍视为同一场
    （旧规则只看 start 差 90min，会把同一场算成两条）。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[_dm_item("live-a", "播了", _ms(T0))])   # stop 缺省=0
    _snap(db, acc, T0 + timedelta(hours=3), status=1)
    _snap(db, acc, T0 + timedelta(hours=4), status=0)

    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["source"] == "danmakus+self"


def test_self_sessions_split_on_round_robin(db):
    """轮播（`live_status=2`）代表**上一场已经结束**：`1→2→1` 是两场，不是一场。

    实测背景（2026-10-02，devlog/276）：明前奶绿 10-01 那场下播后房间转入轮播
    （快照 1 → 2，房间开始循环放录像），隔天再开播（2 → 1）。原先只认 0 收场 ⇒
    两场被并成一场、时长跨天 —— 日历上"15 小时"那种数字就是这么来的。
    """
    acc = _mk_account(db)
    _snap(db, acc, T0, status=1, title="国庆快乐~")
    _snap(db, acc, T0 + timedelta(hours=2), status=2)          # 下播 → 房间轮播
    _snap(db, acc, T0 + timedelta(hours=26), status=1, title="第二天")
    _snap(db, acc, T0 + timedelta(hours=27), status=0)

    sessions = AccountStatSnapshotRepo(db).live_sessions(acc.id)
    assert len(sessions) == 2, f"轮播没被当成收场：{sessions}"
    assert sessions[0]["end_at"] == T0 + timedelta(hours=2)
    assert sessions[0]["live_title"] == "国庆快乐~"
    assert sessions[1]["start_at"] == T0 + timedelta(hours=26)
    assert sessions[1]["end_at"] == T0 + timedelta(hours=27)


def test_merged_virtual_self_and_row_alone(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    # 只有快照场次（danmakus 未收录主播场景）
    _snap(db, acc, T0, status=1)
    _snap(db, acc, T0 + timedelta(minutes=10), status=0)
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["source"] == "self"
    assert merged[0]["live_title"] is None

    # 只有表内场次（无快照观测期）
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[_dm_item("live-a", "历史场", _ms(T0 - timedelta(days=30)))])
    merged = repo.merged(acc.id)
    assert len(merged) == 2
    assert merged[0]["source"] == "danmakus"


# ── P9-1（v0.9.6）：self 快照并入改「区间重叠优先」 ────────────────────

def test_merged_snapshot_overlap_beyond_start_window(db):
    """回归（用户 2026-09-10 反馈「self 与 danmakus 同场被算两场」）：

    self 快照的起点是「本工具看到开播」的时刻（5min 粒度，应用没运行就没有快照），
    长直播里能比真实开场晚几小时。旧规则「start 差 ≤90min」于是不合并 →
    同一次直播在日历里出现两条；新规则按区间重叠合并（取重叠最多者）。
    实测对应数据：明前奶绿 2026-09-03 danmakus 11:59→17:12 + self 15:16→17:25。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("live-a", "楚什么楚！", _ms(T0), _ms(T0 + timedelta(hours=5, minutes=13))),
    ])
    # self 起点晚 3h16m（远超 90min 窗口），但区间落在 danmakus 场次内
    _snap(db, acc, T0 + timedelta(hours=3, minutes=16), status=1, title="楚什么楚！")
    _snap(db, acc, T0 + timedelta(hours=5, minutes=25), status=0)

    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["source"] == "danmakus+self"
    assert merged[0]["start_at"] == T0                        # 主数据（danmakus）起点保留
    assert merged[0]["end_at"] == T0 + timedelta(hours=5, minutes=13)


def test_merged_snapshot_spanning_rows_absorbs_into_best(db):
    """跨多个表内场次的超长 self 伪场次（实测有 40h 的，多因漏掉一次下播跳变）
    并入重叠最多的那一场，不留 self 虚拟场次。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("live-a", "第一场", _ms(T0), _ms(T0 + timedelta(hours=2))),
        _dm_item("live-b", "第二场", _ms(T0 + timedelta(hours=20)),
                 _ms(T0 + timedelta(hours=29))),
    ])
    _snap(db, acc, T0 + timedelta(hours=3), status=1, title="第二场")
    _snap(db, acc, T0 + timedelta(hours=43), status=0)      # 40h 的伪区间

    merged = repo.merged(acc.id)
    assert len(merged) == 2                                 # 没有多出 self 虚拟场次
    assert [m["source"] for m in merged] == ["danmakus", "danmakus+self"]
    assert merged[1]["end_at"] == T0 + timedelta(hours=29)  # danmakus 的 end 未被伪区间覆盖


def test_merged_both_live_same_title_merges(db):
    """双方都「进行中」（都没有 end）：区间法失效，同标题 + 起播差 ≤6h 视为同场
    （实测 七海 09-09 feed 11:57→ 与 self 15:25→ 同标题）。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_feed = None  # 仅作提示：本用例手动插表内行
    db.add(LiveSession(account_id=acc.id, platform="bilibili", source="feed",
                       live_id="feed-1", title="大米小米玉米杂粮米",
                       start_at=T0, end_at=None))
    db.commit()
    _snap(db, acc, T0 + timedelta(hours=3, minutes=30), status=1,
          title="大米小米玉米杂粮米")                        # 未收播 → end 缺失

    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["source"] == "feed+self"


def test_merged_both_live_diff_title_stays_two(db):
    """同账号两条都进行中但标题不同 → 不合并（防把真·新场次并掉）。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    db.add(LiveSession(account_id=acc.id, platform="bilibili", source="feed",
                       live_id="feed-1", title="早场", start_at=T0, end_at=None))
    db.commit()
    _snap(db, acc, T0 + timedelta(hours=3), status=1, title="晚场")

    merged = repo.merged(acc.id)
    assert len(merged) == 2
    assert [m["source"] for m in merged] == ["feed", "self"]


def test_merged_danmakus_end_wins(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("live-a", "回放场", _ms(T0), _ms(T0 + timedelta(hours=3))),
    ])
    _snap(db, acc, T0 - timedelta(minutes=2), status=1)
    _snap(db, acc, T0 + timedelta(hours=2), status=0)
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["end_at"] == T0 + timedelta(hours=3)      # danmakus end 优先
    assert merged[0]["duration_minutes"] == 180


# ── M2：danmakus/feed 同场去重（组内主数据优先） ─────────────────────

def test_merged_danmakus_and_feed_dedupe(db):
    """同一场直播 danmakus(uuid) 与 feed(live_id) 各一行 → 合并为一场。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("uuid-a", "周六来唱歌！", _ms(T0), _ms(T0 + timedelta(hours=2)),
                 area="虚拟Singer", parent="虚拟主播", income=10501.5),
    ])
    repo.upsert_feed(acc.id, "736525563447432921", {
        "title": "周六来唱歌！", "start_at": T0 + timedelta(minutes=2),
        "parent_area_name": "虚拟主播", "area_name": "虚拟Singer",
        "room_id": "21452505",
    })
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    m = merged[0]
    assert m["source"] == "danmakus+feed"
    assert m["live_id"] == "uuid-a"                    # danmakus 主键优先
    assert m["start_at"] == T0
    assert m["end_at"] == T0 + timedelta(hours=2)
    assert m["total_income"] == 10501.5


def test_merged_recent_pair_exposes_danmakus_id(db):
    """近期场次（danmakus + feed 双行、两端都没 end）对外 id 必须是 danmakus uuid。

    2026-09-10 用户反馈「最近几场直播的信息都展示不出来」的根因回归：
    弹幕详情端点只认 danmakus 的 uuid（实测数字 id → HTTP 400），而这里此前按
    「哪一行先被扫到」定 id —— feed 行先入库时对外暴露数字 id，详情弹窗弹幕/统计全空。
    本用例按真实库形态构造：feed 行先入库（真实库里正是它先被扫到）。
    """
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_feed(acc.id, "723878467234502758", {
        "title": "一起看苹果发布会", "start_at": T0,
        "parent_area_name": "虚拟主播", "area_name": "虚拟Singer",
        "room_id": "1947277414",
    })
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("ee8f2f2b-8447-4eb5-99f2-1680a0923ef9", "一起看苹果发布会",
                 _ms(T0), 0, count=0),      # 刚下播：danmakus 侧还没落 end/弹幕
    ])
    merged = repo.merged(acc.id)
    assert len(merged) == 1, "同场双源必须并成一场"
    m = merged[0]
    assert m["source"] == "danmakus+feed"
    assert m["live_id"] == "ee8f2f2b-8447-4eb5-99f2-1680a0923ef9", \
        "对外 id 必须取最高优先级源（danmakus uuid），否则弹幕详情查不到"
    assert m["segment_count"] == 1, "双源同场不该被标成「中断续播·2 段」"


def test_merged_feed_only_keeps_feed_id(db):
    """反向保证：没有 danmakus 行时对外 id 仍是 feed 的数字 id（不能被定权逻辑吃掉）。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_feed(acc.id, "723878467234502758", {
        "title": "只有 feed", "start_at": T0, "room_id": "1947277414",
    })
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["live_id"] == "723878467234502758"
    assert merged[0]["source"] == "feed"


def test_merged_feed_alone_and_with_snap(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_feed(acc.id, "feed-1", {
        "title": "无限流游戏", "start_at": T0,
        "parent_area_name": "单机游戏", "area_name": "主机游戏",
    })
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["source"] == "feed"
    assert merged[0]["live_id"] == "feed-1"
    assert merged[0]["duration_minutes"] is None

    # feed 场 + 快照（±90min）→ feed 主 + self 补 end
    _snap(db, acc, T0 + timedelta(minutes=10), status=1)
    _snap(db, acc, T0 + timedelta(minutes=40), status=0)
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    m = merged[0]
    assert m["source"] == "feed+self"
    assert m["end_at"] == T0 + timedelta(minutes=40)
    assert m["duration_minutes"] == 40
    assert m["live_title"] == "无限流游戏"


def test_merged_feed_supplements_danmakus_gap(db):
    """danmakus 缺标题（旧数据）→ feed 同场补标题；不同场次不误并。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("uuid-old", "", _ms(T0), _ms(T0 + timedelta(hours=1))),
    ])
    repo.upsert_feed(acc.id, "feed-old", {
        "title": "补的标题", "start_at": T0 + timedelta(minutes=5),
    })
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["live_title"] == "补的标题"
    assert merged[0]["source"] == "danmakus+feed"


def test_merged_two_days_sessions_not_merged(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("uuid-day1", "第一天", _ms(T0)),
        _dm_item("uuid-day2", "第二天", _ms(T0 + timedelta(days=4))),
    ])
    merged = repo.merged(acc.id)
    assert len(merged) == 2
    assert [m["live_title"] for m in merged] == ["第一天", "第二天"]


# ── merged v2（2026-09-07：复制重复 / 中断续播 / 真多场区分） ─────────

def test_merged_dup_records_pick_richer(db):
    """同场双记录（重叠同骨架，一实一稀疏）→ 并一场，主=富记录，收益不翻倍。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    t1, t1e = T0, T0 + timedelta(hours=3)
    t2, t2e = T0 + timedelta(minutes=10), T0 + timedelta(hours=3)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("uuid-a", "泽音一周年3D回", _ms(t1), _ms(t1e),
                 area="虚拟日常", parent="虚拟主播", income=12.0, count=64),
        _dm_item("uuid-b", "泽音一周年3D回", _ms(t2), _ms(t2e),
                 area="虚拟日常", parent="虚拟主播", income=99.0, count=17937),
    ])
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    m = merged[0]
    assert m["live_id"] == "uuid-b"                        # 富记录为主键
    assert m["start_at"] == t1                              # 时间并集
    assert m["end_at"] == t1e
    assert m["total_income"] == 99.0                        # 收益不翻倍
    assert m["danmakus_count"] == 17937
    assert m["segment_count"] == 1                          # 双记录≠两段
    assert m["source"] == "danmakus"


def test_merged_interruption_segments(db):
    """中断续播（同骨架 gap 6min）→ 并为一场，段数 2，收益/弹幕求和。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    a, ae = T0, T0 + timedelta(hours=2)
    b, be = ae + timedelta(minutes=6), ae + timedelta(hours=2)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("uuid-a", "我想你 你想我吗?", _ms(a), _ms(ae),
                 area="虚拟日常", parent="虚拟主播", income=100.0, count=453),
        _dm_item("uuid-b", "我想你 你想我吗?", _ms(b), _ms(be),
                 area="虚拟日常", parent="虚拟主播", income=50.0, count=271),
    ])
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    m = merged[0]
    assert m["segment_count"] == 2
    assert m["start_at"] == a and m["end_at"] == be
    assert m["total_income"] == 150.0
    assert m["danmakus_count"] == 724
    # 详情单场只显示一个 live_id（分段记录不暴露）
    assert m["live_id"] in ("uuid-a", "uuid-b")


def test_merged_restart_diff_title_short_gap(db):
    """平台断播重开/快转场（不同标题 gap 3min）→ 并段（观感连续）。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    a, ae = T0, T0 + timedelta(hours=1)
    b, be = ae + timedelta(minutes=3), ae + timedelta(hours=2)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("uuid-a", "LSTAR狂暴鸿儒直", _ms(a), _ms(ae), count=13701),
        _dm_item("uuid-b", "十月 绝对白兰", _ms(b), _ms(be), count=55051),
    ])
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["segment_count"] == 2
    assert merged[0]["danmakus_count"] == 13701 + 55051


def test_merged_true_multi_session_stays(db):
    """真多场（异标题 gap 90min）→ 保持两场（日历 N 场计数）。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    a, ae = T0, T0 + timedelta(hours=1)
    b, be = ae + timedelta(minutes=90), ae + timedelta(hours=2)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("uuid-a", "【鸣潮】2.8", _ms(a), _ms(ae),
                 area="虚拟日常", parent="虚拟主播", count=18348),
        _dm_item("uuid-b", "一起看看", _ms(b), _ms(be),
                 area="虚拟日常", parent="虚拟主播", count=11608),
    ])
    merged = repo.merged(acc.id)
    assert len(merged) == 2
    assert [m["segment_count"] for m in merged] == [1, 1]


def test_merged_cross_midnight_interruption_merges(db):
    """跨午夜中断续播（前一晚 23:00 断 → 次日 00:20 续，同骨架）→ 一场。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    a, ae = T0 + timedelta(hours=11), T0 + timedelta(hours=11, minutes=47)
    b, be = T0 + timedelta(hours=12, minutes=20), T0 + timedelta(hours=13)
    repo.upsert_danmakus(acc.id, platform=acc.platform, items=[
        _dm_item("uuid-a", "深夜电台", _ms(a), _ms(ae), area="虚拟日常"),
        _dm_item("uuid-b", "深夜电台", _ms(b), _ms(be), area="虚拟日常"),
    ])
    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["segment_count"] == 2


def test_merged_room_dedupe_same_room_feed_rows(db):
    """同 room 的 feed 行：同日紧邻 → room 去重并一场；隔天 → 不误并（回归：
    timedelta 比较 bug 曾导致同 room 行直接抛 TypeError）。"""
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    repo.upsert_feed(acc.id, "feed-1", {
        "title": "杂谈", "start_at": T0, "room_id": "21452505"})
    repo.upsert_feed(acc.id, "feed-2", {
        "title": "杂谈", "start_at": T0 + timedelta(minutes=20), "room_id": "21452505"})
    repo.upsert_feed(acc.id, "feed-3", {
        "title": "歌回", "start_at": T0 + timedelta(days=1), "room_id": "21452505"})
    merged = repo.merged(acc.id)
    assert len(merged) == 2                                  # 同日并一场 + 隔天一场
    assert merged[0]["segment_count"] == 1
    assert merged[1]["live_title"] == "歌回"


# ── M2：live_rcmd 卡片映射（fetcher） ──────────────────────────────

def _live_rcmd_item():
    inner = {
        "type": 1,
        "live_play_info": {
            "room_id": 21452505, "uid": 434334701, "live_status": 1,
            "title": "无穷无尽的魔兽但是前VRG",
            "cover": "https://i0.hdslb.com/bfs/live/new_room_cover/x.jpg",
            "online": 142512, "area_id": 236, "area_name": "主机游戏",
            "parent_area_id": 6, "parent_area_name": "单机游戏",
            "live_start_time": 1788699370, "live_id": 736525563447432921,
            "link": "//live.bilibili.com/21452505?live_from=85002",
        },
    }
    return {
        "type": "DYNAMIC_TYPE_LIVE_RCMD",
        "id_str": "1244945963532943364",
        "modules": {
            "module_author": {"pub_ts": 1788699970, "pub_time": ""},
            "module_dynamic": {
                "major": {"type": "MAJOR_TYPE_LIVE_RCMD",
                          "live_rcmd": {"reserve_type": 0,
                                        "content": json.dumps(inner)}},
            },
        },
    }


def test_map_live_rcmd_fields():
    d = _map_live_rcmd(_live_rcmd_item(), mid=434334701)
    assert d["type"] == "live"
    assert d["platform_uid"] == "434334701"
    assert d["platform_post_id"] == "1244945963532943364"
    assert d["title"] == "无穷无尽的魔兽但是前VRG"
    assert d["permalink"] == "https://live.bilibili.com/21452505"
    assert d["published_at"] == datetime(2026, 9, 6, 12, 56, 10, tzinfo=timezone.utc)  # 开播秒级
    body = json.loads(d["body_json"])
    assert body["live_id"] == "736525563447432921"
    assert body["room_id"] == "21452505"
    assert body["area_name"] == "主机游戏"
    assert body["parent_area_name"] == "单机游戏"
    assert body["live_start_time"] == 1788699370


# ── infer_category ────────────────────────────────────────────────

def test_category_title_signal(db):
    assert infer_category("深夜杂谈回聊聊生活")[0] == "chat"
    assert infer_category("周六来唱歌！")[0] == "song"
    assert infer_category("新年特别直播！")[0] == "special"
    assert infer_category("百万粉纪念歌回")[0] == "special"    # 优先于歌回
    assert infer_category("原神深渊")[0] == "game"
    assert infer_category("联动企划双人合唱")[0] == "collab"

    key, src = infer_category("随便玩玩杂谈")
    assert (key, src) == ("chat", "title")


def test_category_area_signal(db):
    # 标题空白 → 分区兜底（**特异分区**才给得出结论）
    assert infer_category("", area_name="主机游戏", parent_area_name="单机游戏") == ("game", "area")
    assert infer_category(None, area_name="虚拟Singer", parent_area_name="虚拟主播") == ("song", "area")
    # 标题命中优先于分区
    assert infer_category("歌回", area_name="主机游戏", parent_area_name="单机游戏")[0] == "song"


def test_category_generic_area_is_a_last_resort(db):
    """★宽分区（`虚拟日常` 这类）**降权成兜底**（用户 2026-10-12 反馈，`devlog/470`）。

    现场：真机 `虚拟日常` 一个分区压着 **3732 条**（占分区那一路的 92%），
    而它其实不是"内容判据"、是"没填分区"的同义词 ⇒ 原来的"命中即返回"让**任何标题
    都改不了它**（`【突击】继续终末地！`、`小小梦魇2` 全判成 `chat`，用户标注集抓出来的）。

    现在它只给 1.5 分：**标题信号压得过它**（下一条用例），而**它自己单独也判不出自信**
    ⇒ 没别的信号时落中性（`live`）。⚠️ 这是**有意的取舍**：那批场次从 `chat` 变 `live`，
    因为工具确实不知道他们在播什么 —— 跟着"虚拟日常 ⇒ 杂谈"猜，才是把宽分区的名字
    当成了内容结论。
    """
    assert infer_category("", area_name="虚拟日常", parent_area_name="虚拟主播") == ("live", "fallback")
    # 标题里有内容词 ⇒ 压过宽分区（这条是用户标注集里 `area-18`/`area-20` 的回归判据）
    assert infer_category("【突击】继续终末地！", area_name="虚拟日常") == ("game", "title")
    assert infer_category("小小梦魇2", area_name="虚拟日常") == ("game", "title")
    assert infer_category("【3D】即兴表演！", area_name="虚拟日常") == ("3d", "title")
    # 正对照：**特异**分区照旧单独就能定（它真的是内容判据）
    assert infer_category("", area_name="虚拟Gamer") == ("game", "area")


# ── 助眠（T3，2026-10-12：取代「健身」）────────────────────────────
#
# ⚠️ 这一组守的是**词表分离**，不只是"新类目能用"：`助眠`/`哄睡`/`asmr`/`伴睡`
# 原来挂在 `RADIO` 下，两边都留 ⇒ 同一串标题同时命中两类、`_confident`（要求领先 1.0）
# 判不出自信 ⇒ **最该判对的标题反而落回中性**（施工时实测：`score_title("助眠")`
# → `{sleep: 3.0, radio: 3.0}` ⇒ fallback）。所以这里既判"归助眠"，也判"不再归电台"。

def test_category_sleep_replaces_fitness(db):
    """★用户口径：沿用 10 类，但「健身」换成「助眠」。"""
    from app.services.live_type import CATEGORY_KEYS, TYPE_DISPLAY_ORDER

    assert "sleep" in CATEGORY_KEYS and "fitness" not in CATEGORY_KEYS
    assert "sleep" in TYPE_DISPLAY_ORDER and "fitness" not in TYPE_DISPLAY_ORDER
    # 旧的健身词条必须失效（真机那 58 条标题命中应当重新判）
    assert infer_category("健身鹮！")[0] != "fitness"
    assert infer_category("来运动！")[0] != "fitness"


def test_category_sleep_words_are_confident(db):
    """★分离之后，明确的助眠标题要**判得出来**（施工前它们全部落回兜底）。"""
    for title in ("助眠", "哄睡向", "ASMR 白噪音", "伴睡音声", "耳骚", "冥想一下"):
        assert infer_category(title) == ("sleep", "title"), f"{title!r} 没判成助眠"
    # 分区那一路也认（原挂在 RADIO 下）
    assert infer_category("", area_name="助眠", parent_area_name="虚拟主播") == ("sleep", "area")


def test_category_radio_keeps_only_the_programme_words(db):
    """★电台那条**不再**收助眠词：两边都留会让平分 ⇒ 兜底（反向判据）。"""
    assert infer_category("【电台】冬夜小播")[0] == "radio"
    assert infer_category("深夜谈心")[0] == "radio"
    # 这几个必须走 sleep，不许被电台抢走
    for title in ("助眠", "哄睡", "asmr", "伴睡"):
        assert infer_category(title)[0] == "sleep", f"{title!r} 被电台抢走了"
    # `晚安` 留在电台：真机 6 条命中都不是助眠内容（提问箱/下播告别）
    assert infer_category("晚安")[0] == "radio"


# ── 3D 形式 + watch 边界 + 并列档（用户 2026-10-12 的三处修正）──────────

def test_category_3d_form(db):
    """★新加的第 11 类：**3D 形式**（用户口径「3D 形式呈现直播的场次」）。

    ⚠️ 口径（用户 2026-10-12 二次拍板）：「特殊 > 3D，**内容类优先**」——
    冲突时**内容赢**，3D 只接住"判不出内容"的那些。
    实现是**两个数配套**：权重 3.0（与内容强词平分）+ `TITLE_CATEGORY_PRIORITY` 里 3D 排最后。
    """
    # 判不出内容 ⇒ 3D（真机这类是多数）
    assert infer_category("【3D】红豆来咯") == ("3d", "title")
    assert infer_category("【3D】技能冷却中", area_name="虚拟日常") == ("3d", "title")
    # 形式归 3D 的**分区**那一路
    assert infer_category("走夜路", area_name="虚拟主播", parent_area_name="3D虚拟主播") \
        == ("3d", "area")
    # ⚠️ **只有 `special` 能压过 3D**（用户标注集定的，`devlog/470`）：
    # 他标 `【3D】第九届星斯卡！` 是 `special`、`【3D】即兴表演！`/`【3D】露早大评级！` 是 `3d`。
    # ⇒ 平分时 3D 赢内容类（`3d歌回` → 3d），但**赢不了 special**。
    assert infer_category("家用3d歌回")[0] == "3d"
    assert infer_category("【3D联动】拼好团3.0")[0] == "3d"
    assert infer_category("恬豆3D生日会 ！！！") == ("special", "title")
    assert infer_category("10w粉纪念~第一次家用3d！")[0] == "special"
    assert infer_category("【3D】第九届星斯卡！") == ("special", "title")


def test_category_3d_weight_and_priority_are_a_pair(db):
    """★`3d` 的权重与优先级**是一对**，改一个必须想另一个（四轮口径都量过）。

    | 权重 | 结果 |
    |---|---|
    | 4.0 | 与内容强词（3.0）差满 1.0 ⇒ `_confident` 直接判 3D 赢 ⇒ `3d歌回` → 3d（与"特殊>3D>内容"一致，但会压过 special 的 5.0 之外的场景） |
    | 2.5 | 差 0.5 且卡在泛词门槛 ⇒ 判不自信 ⇒ **连内容信号一起丢**、落回分区 ❌ |
    | **3.0** | 与内容强词**平分** ⇒ 交优先级定胜负；`special` 靠优先级压过它，其余内容类让位 ✅ |

    ⚠️ 最终口径（用户标注集定的，`devlog/470`）：**特殊 > 3D > 其余内容类**。
    """
    from app.services.live_type import TITLE_CATEGORY_PRIORITY, TITLE_TERMS, THREED

    assert TITLE_TERMS[THREED]["3d"] == 3.0
    # 3D 在 `special` 之后、**所有其它内容类之前**
    assert TITLE_CATEGORY_PRIORITY[0] == "special"
    assert TITLE_CATEGORY_PRIORITY[1] == THREED
    # mmd 收着备用（真机 0 命中），给 2.5 ⇒ 只有它一个信号时才判 3D
    assert TITLE_TERMS[THREED]["mmd"] == 2.5
    assert infer_category("MMD 直播")[0] == "3d"


def test_category_3d_excludes_false_friends(db):
    """★`晕3d` 不是 3D 直播（真机有 `晕3d了谢会sc` 这种标题，裸 `3d` 会误伤）。"""
    assert "3d" not in score_title("晕3d了谢会sc")
    assert infer_category("晕3d了谢会sc")[0] != "3d"


def test_category_watch_covers_watching_videos(db):
    """★用户修正边界：「或者视频、投稿等主要以观看视频为主体的」都算 `watch`。

    ⚠️ `投稿回`/`看投稿` 与 `upload` 的 `投稿` 必然平分 ⇒ 靠 `TITLE_CATEGORY_PRIORITY`
    （WATCH 在 UPLOAD 之前）打破。这条同时守**并列档**那个修复（见下一条用例）。
    """
    assert infer_category("【看视频】很有品味的分享了很有品位的视频") == ("watch", "title")
    assert infer_category("二创~") == ("watch", "title")
    assert infer_category("哇哈哈边看投稿边聊天") == ("watch", "title")   # 并列 → 优先级
    # 弱信号（切片 2.0）不足以自信 ⇒ 兜底是对的（判不准就别硬判）
    assert infer_category("看我看自己切片【2】")[0] == "live"


def test_confident_groups_ties_by_priority(db):
    """★`_confident` 的三条语义（2026-10-12 两次改动后的最终形状）。

    ① **并列同分算一档**（`_ranked_groups`）：`_argmax` 用优先级打破，`_confident` 也得认；
    ② **差 ≥1.0** ⇒ 自信（与档无关）；
    ③ **差 <1.0 时只认"高级别档领先"** —— 这条是为「内容类优先」加的
       （`{collab 3.0, 3d 2.5}`：差 0.5，但内容排在 3D 前面 ⇒ 判联动）。
    """
    from app.services.live_type import _confident, _ranked_groups

    # ① 同分归成一档 ⇒ 自信（修复前逐类相邻差 0 < 1.0 ⇒ 判成"分歧太大" ⇒ 有优先级也白搭）
    scores = {"watch": 3.0, "upload": 3.0}
    assert _ranked_groups(scores) == [("watch", 3.0)]
    assert _confident(scores) is True
    # ② 强词领先泛词 ⇒ 自信
    assert _confident({"watch": 3.0, "chat": 2.5}) is True
    # ③ **高级别档领先**（差 <1.0）也自信 —— 用 watch(优先级 3) 对 chat(7) 验证这条机制：
    #    换成"低分档优先级更高"的形状则**不**自信（优先级不能压过分数）。
    assert _confident({"watch": 2.5, "chat": 2.0}) is True
    assert _confident({"chat": 3.0, "watch": 2.5}) is False
    # ⚠️ 3D 现在排在内容类**之前**（用户标注集定的）⇒ `{collab 3.0, 3d 2.5}` **不**自信：
    #    低分档（3d）优先级更高 ⇒ 优先级给不出方向 ⇒ 落分区/兜底。
    #    （这条与"3d歌回 → 3d"不矛盾：那条是**平分**，由 `_argmax` 定胜负。）
    assert _confident({"collab": 3.0, "3d": 2.5}) is False
    # 弱词单发仍不自信
    assert _confident({"watch": 2.0}) is False


def test_category_date_anchor(db):
    # 生日当日（MM-DD）
    assert infer_category("", start_at=T0, birthday="09-01") == ("special", "date")
    # 出道日（YYYY-MM-DD）
    assert infer_category("", start_at=T0, debut_date="2022-09-01") == ("special", "date")
    # 手动事件当日
    assert infer_category("", start_at=T0, event_dates=["2026-09-01"]) == ("special", "date")
    # 无信号 → fallback
    assert infer_category("", start_at=T0, birthday="05-05") == ("live", "fallback")


# ── 类型引擎 v2（2026-09-07：多词评分 / 系列聚类 / 用户校正） ────────

def test_score_title_nested_and_weights():
    # 特殊 5.0 压过歌回 3.0（覆盖性事件优先，同 v1 语义）
    s = score_title("百万粉纪念歌回")
    assert s["special"] == 5.0 and s["song"] == 3.0
    # 同分类嵌套只计最长（联动回 3.5，不叠加联动 3.0）
    assert score_title("联动回")["collab"] == 3.5
    # 跨分类嵌套双方保留（演唱会特辑 → special 5.0 / song 2.5）
    s = score_title("演唱会特辑")
    assert s["special"] == 5.0 and s["song"] == 2.5


def test_category_title_v2_confidence(db):
    # 强词单发即自信
    assert infer_category("周六来唱歌！") == ("song", "title")
    assert infer_category("原神深渊") == ("game", "title")
    # 泛词/无词不自信 → 落到分区；⚠️ 但 `虚拟日常` 是**宽分区**（只 1.5 分）
    # ⇒ 连它也给不出自信 ⇒ 落中性（见 `test_category_generic_area_is_a_last_resort`）
    assert infer_category("随便玩玩", area_name="虚拟日常",
                          parent_area_name="虚拟主播") == ("live", "fallback")
    # 换成**特异**分区就判得出来（正对照：不是"分区一律失效"）
    assert infer_category("随便玩玩", area_name="虚拟Gamer") == ("game", "area")


def test_normalize_title_skeleton():
    assert normalize_title("【歌回】周一 20:00 第12期") == "歌回"
    assert normalize_title("晚上好！") == "晚上好"
    assert normalize_title("杂谈  回") == "杂谈回"      # 标点/空格剥离
    assert normalize_title("") == ""


def test_plan_series_and_series_source():
    sessions = [
        {"live_id": "a", "live_title": "【歌回】周一"},
        {"live_id": "b", "live_title": "【歌回】周二"},
    ]
    sp = plan_series(sessions, {})
    assert sp == {"歌回": "song"}
    # 系列命中在标题评分之前（source=series）
    assert infer_category("【歌回】周三", series_categories=sp) == ("song", "series")


def test_series_override_propagates():
    # 「晚上好」×3 无标题信号；修正一场 → 系列聚合投票 4.0 → 全系列改判
    sessions = [
        {"live_id": "a", "live_title": "晚上好"},
        {"live_id": "b", "live_title": "晚上好"},
        {"live_id": "c", "live_title": "晚上好"},
    ]
    sp = plan_series(sessions, {"a": "chat"})
    assert sp == {"晚上好": "chat"}
    # 被校正场次本身 = override；同系列其他场次 = series
    assert infer_category("晚上好", live_id="a", overrides={"a": "chat"},
                          series_categories=sp) == ("chat", "override")
    assert infer_category("晚上好", live_id="b", overrides={"a": "chat"},
                          series_categories=sp) == ("chat", "series")


def test_learned_from_correction():
    sessions = [{"live_id": "a", "live_title": "聊聊原神"}]
    learned = build_learned({"a": "chat"}, sessions)
    assert learned == {"chat": {"原神": 2.0}}
    # 空标题不入词库
    assert build_learned({"a": "chat"}, [{"live_id": "a", "live_title": None}]) == {}
