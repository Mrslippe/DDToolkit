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
from app.repositories.vtuber_repo import LiveSessionRepo
from app.services.fetcher import _map_live_rcmd
from app.services.live_type import (
    infer_category, score_title, normalize_title, plan_series, build_learned,
)

T0 = datetime(2026, 9, 1, 12, 0, 0)


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _mk_account(db, uid="10086") -> Account:
    v = VTuber(name="测试V", birthday="09-01")
    db.add(v)
    db.flush()
    acc = Account(vtuber_id=v.id, platform="bilibili", platform_uid=uid)
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
    res = repo.upsert_danmakus(acc.id, items)
    assert res == {"added": 2, "updated": 0, "skipped": 0}

    # 幂等：重跑不新增；可变字段刷新
    items[0]["totalIncome"] = 999.0
    res = repo.upsert_danmakus(acc.id, items)
    assert res == {"added": 0, "updated": 2, "skipped": 0}
    rows = repo.list_by_account(acc.id)
    assert len(rows) == 2
    assert rows[0].total_income == 999.0
    assert rows[0].source == "danmakus"
    assert rows[0].end_at == T0 + timedelta(hours=2)
    assert rows[0].area_name == "虚拟日常"


def test_upsert_danmakus_skips_invalid(db):
    acc = _mk_account(db)
    repo = LiveSessionRepo(db)
    res = repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [_dm_item("live-a", "播了", _ms(T0))])   # stop 缺省=0
    _snap(db, acc, T0 + timedelta(hours=3), status=1)
    _snap(db, acc, T0 + timedelta(hours=4), status=0)

    merged = repo.merged(acc.id)
    assert len(merged) == 1
    assert merged[0]["source"] == "danmakus+self"


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
    repo.upsert_danmakus(acc.id, [_dm_item("live-a", "历史场", _ms(T0 - timedelta(days=30)))])
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    repo.upsert_danmakus(acc.id, [
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
    # 标题空白 → 分区兜底
    assert infer_category("", area_name="主机游戏", parent_area_name="单机游戏") == ("game", "area")
    assert infer_category(None, area_name="虚拟Singer", parent_area_name="虚拟主播") == ("song", "area")
    assert infer_category("", area_name="虚拟日常", parent_area_name="虚拟主播") == ("chat", "area")
    # 标题命中优先于分区
    assert infer_category("歌回", area_name="主机游戏", parent_area_name="单机游戏")[0] == "song"


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
    # 泛词/无词不自信 → 落到分区（不再先命中先得）
    assert infer_category("随便玩玩", area_name="虚拟日常",
                          parent_area_name="虚拟主播") == ("chat", "area")


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
