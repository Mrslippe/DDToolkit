# -*- coding: utf-8 -*-
"""场次 ↔ 录播的配对口径（`app/domain/vod_autofill.py`，`docs/plans/vod-autofill.md` B1）。

判据对着三条**会静默出错**的性质：

① **时区**：库里 `start_at` 是朴素 UTC，而录播标题是北京墙上时间。少加这 8 小时，
   命中率从 94% 掉到 0.7%（2026-10-14 实测）—— 而界面上只会看到"一条都没配上"，不报错。
② **不许覆盖用户手填的 `vod_url`**（不变量 39）：已有录播的场次必须被排除在匹配池外。
③ **一场只出一条主选**：同场多段要进 `alternates`，否则写入时会互相覆盖。
"""
from datetime import datetime, timedelta

from app.domain import vod_autofill as va
from app.domain.vod_source import TimeHint

#: 一场 19:00（北京）开播的直播 ⇒ 库里存 11:00 UTC
START_UTC = datetime(2026, 10, 11, 11, 0)


def row(live_id="L1", start=START_UTC, vod=None):
    return {"live_id": live_id, "start_at": start, "vod_url": vod}


def item(bvid="BV1", title="【直播回放】某场", duration=18000, pub=None, tier="replay",
         hint_at=None, mid="2132180406", source_name="直播回放"):
    if hint_at is None and tier in ("replay", "dated"):
        hint_at = datetime(2026, 10, 11, 19, 0)
    # ⚠️ 默认发布时间**必须落在同一个北京日**（START_UTC 11:00Z = 北京 19:00 ⇒ 07:00Z = 北京 15:00）。
    #    早先这里写的是 +6h（= 北京次日 01:00），兜底判据当场红 —— 那不是 bug，
    #    正是"按**北京日**比"这条口径在起作用（录播发布在 UTC 看常常已经是第二天）。
    if pub is None:
        pub = START_UTC - timedelta(hours=4)
    return va.SourceItem(
        bvid=bvid, title=title, duration_seconds=duration,
        published_at=pub,
        permalink=f"https://www.bilibili.com/video/{bvid}",
        mid=mid, source_name=source_name, tier=tier,
        hint=TimeHint(at=hint_at, year_from_title=True) if hint_at else None)


# ── ① 时区 ────────────────────────────────────────────────────────────

def test_start_at_is_interpreted_as_utc_not_beijing():
    """`start_at` 11:00 UTC + 8 = 19:00 北京 ⇒ 与标题的 `19点场` 精确对齐。"""
    assert va.to_beijing(START_UTC) == datetime(2026, 10, 11, 19, 0)
    ms = va.match_sessions([row()], [item()])
    assert len(ms) == 1 and ms[0].minutes_delta == 0.0


def test_aware_datetimes_are_normalised_first():
    """带时区的入参先归一到 UTC 再换 —— 直接 +8 会得到错的值。"""
    aware = datetime(2026, 10, 11, 11, 0, tzinfo=va.BEIJING)     # = 03:00 UTC
    assert va.to_beijing(aware) == datetime(2026, 10, 11, 11, 0)


def test_tolerance_boundary_is_inclusive_and_measured():
    """窗口 200 分：边界内算配上、超出算没配上。

    这个数是**实测**定的（2026-10-15，真库真上游）：中位 48–52 分，
    而尾巴到 138 分都是同一天（录播号晚开录，用户指出的形态）；
    最近的不同日条目差 1142 分以上 ⇒ 200 分既覆盖尾巴、又不会跨日误配。
    """
    assert va.DEFAULT_TOLERANCE_MINUTES == 200
    near = item(hint_at=datetime(2026, 10, 11, 22, 20))          # +200 分
    far = item(hint_at=datetime(2026, 10, 11, 22, 21))           # +201 分
    assert len(va.match_sessions([row()], [near])) == 1
    assert va.match_sessions([row()], [far]) == []


def test_a_late_starting_recording_on_the_same_night_still_matches():
    """★ 用户 2026-10-15 指出的形态：非官方录播号**与直播时间有差距**。

    实测漏配样本（真库）：场次北京 18:42 开播、录播标题写 `21点场` ⇒ 差 **138 分**，
    旧的 90 分窗口配不上。同晚不会连开两场 ⇒ 放宽到 200 分是安全的。
    """
    late_start = item(bvid="BVlate", tier="replay", hint_at=datetime(2026, 10, 11, 21, 0))
    assert len(va.match_sessions([row()], [late_start])) == 1


def test_early_session_title_still_matches():
    """录播号会按**实际开播**标注，可能早于场次记录（实测偏移 min −127 分）。"""
    early = item(hint_at=datetime(2026, 10, 11, 17, 30))         # −200 分
    assert len(va.match_sessions([row()], [early])) == 1


# ── ② 不许覆盖用户手填 ────────────────────────────────────────────────

def test_sessions_that_already_have_a_vod_are_not_matched():
    """⚠️ 不变量 39：`vod_url` 是全表唯一"用户手写、没有自动源"的列。"""
    rows = [row("L1", vod="https://www.bilibili.com/video/BVmanual")]
    assert va.match_sessions(rows, [item()]) == []
    # 没录播的那一场照常匹配
    rows2 = [row("L1", vod="BVmanual"), row("L2", start=START_UTC + timedelta(days=1))]
    ms = va.match_sessions(rows2, [item(hint_at=datetime(2026, 10, 12, 19, 0))])
    assert [m.live_id for m in ms] == ["L2"]


def test_rows_without_live_id_are_skipped():
    """self 快照推导的虚拟场次没有 id（`vod_url` 无处可写）⇒ 不进池，也不算"漏配"。"""
    rows = [{"live_id": None, "start_at": START_UTC, "vod_url": None}]
    assert va.match_sessions(rows, [item()]) == []
    assert va.unmatched_sessions(rows, []) == []


# ── ③ 一场只出一条主选 ────────────────────────────────────────────────

def test_longest_recording_wins_and_others_become_alternates():
    """同场多段（实测 28 场）：主选**时长最长**，其余进 `alternates`（审查表可切换）。"""
    short = item(bvid="BVshort", duration=3600)
    long_ = item(bvid="BVlong", duration=20000)
    ms = va.match_sessions([row()], [short, long_])
    assert len(ms) == 1
    assert ms[0].candidate.bvid == "BVlong"
    assert [a.bvid for a in ms[0].alternates] == ["BVshort"]


def test_confidence_orders_title_over_dated_over_fallback():
    """同场同时有多条时，按 (置信度, |时间差|, 时长) 选主选。"""
    dated = item(bvid="BVdated", tier="dated", hint_at=datetime(2026, 10, 11, 19, 30))
    replay = item(bvid="BVreplay", tier="replay", hint_at=datetime(2026, 10, 11, 19, 0))
    ms = va.match_sessions([row()], [dated, replay])
    assert ms[0].candidate.bvid == "BVreplay" and ms[0].confidence == va.CONF_TITLE
    assert ms[0].auto_ok is True


def test_fallback_match_is_marked_not_auto_checked():
    """没有可读时间的条目走兜底（同日 + 时长 ≥30 分），**默认不勾选**。"""
    plain = item(bvid="BVweak", tier="weak", hint_at=None, duration=7200)
    ms = va.match_sessions([row()], [plain])
    assert len(ms) == 1
    assert ms[0].confidence == va.CONF_FALLBACK
    assert ms[0].minutes_delta is None
    assert ms[0].auto_ok is False          # 审查表据此决定默认不勾


def test_fallback_needs_a_long_enough_video():
    """兜底（标题里什么日期都没有）也要过"时长 ≥30 分"这一关 —— 切片/动态滤掉。"""
    too_short = item(bvid="BVy", tier="weak", hint_at=None, duration=120)
    assert va.match_sessions([row()], [too_short]) == []
    # 发布时刻缺失 ⇒ 兜底无从判断（**不猜**）
    no_pub = item(bvid="BVz", tier="weak", hint_at=None, duration=7200)
    no_pub.published_at = None
    assert va.match_sessions([row()], [no_pub]) == []


def test_fallback_accepts_a_late_upload():
    """★ 用户 2026-10-15：「**非官方录播号可能上传时间和直播时间有很大差距**」。

    标题里连日期都没有、又隔了好几天才传的条目，旧版一律拒（"发布日必须同一天"）⇒ 真回放配不上。
    现在**发布远晚于场次（≥ `LATE_UPLOAD_DAYS`）也算兜底**（长视频、默认不勾，交人审查）。
    """
    late = item(bvid="BVlate", tier="weak", hint_at=None, duration=10800,
                pub=START_UTC + timedelta(days=5))
    ms = va.match_sessions([row()], [late])
    assert len(ms) == 1, "隔 5 天补传的也应该进候选（默认不勾，让人看一眼）"
    assert ms[0].confidence == va.CONF_FALLBACK and ms[0].auto_ok is False


def test_date_only_title_matches_by_same_day_not_by_time():
    """★ 标题只给日期（非官方录播号的常见形态）：按**同一天**配对，`minutes_delta` 记 None。

    拿那个补出来的 00:00 算时间差，会把一场晚 8 点的直播算成差 20 小时 ⇒ 直接配不上。
    """
    date_only = item(bvid="BVd", tier="replay", hint_at=datetime(2026, 10, 11, 0, 0))
    date_only.hint = TimeHint(at=datetime(2026, 10, 11, 0, 0), year_from_title=True,
                              date_only=True)
    date_only.published_at = START_UTC + timedelta(days=7)      # 隔一周才传
    ms = va.match_sessions([row()], [date_only])
    assert len(ms) == 1, "标题标了日期就该配上，与什么时候上传无关"
    assert ms[0].confidence == va.CONF_TITLE and ms[0].auto_ok is True
    assert ms[0].minutes_delta is None, "没有可比时刻 ⇒ 不许编一个时间差出来"
    # 隔天的同一条不该配上（同一天是硬判据）
    other = item(bvid="BVe", tier="replay", hint_at=datetime(2026, 10, 12, 0, 0))
    other.hint = TimeHint(at=datetime(2026, 10, 12, 0, 0), year_from_title=True,
                          date_only=True)
    assert va.match_sessions([row()], [other]) == []


def test_unknown_duration_falls_back_by_date_only():
    """时长未知（上游没给）不该一票否决 —— 同一天就够兜底（由人审查）。"""
    unknown = item(bvid="BVu", tier="weak", hint_at=None, duration=None)
    ms = va.match_sessions([row()], [unknown])
    assert len(ms) == 1 and ms[0].confidence == va.CONF_FALLBACK


def test_early_morning_recording_matches_the_previous_night_session():
    """★ 早场：录播号把凌晨开的播标成前一天（`06月07日00点场` 对的是 **06-06** 那一场）。

    解析器**不改日期**，靠窗口给宽（`EARLY_TOLERANCE_MINUTES` = 6 小时）——
    06-06 19:00 开播 vs 标题的 06-07 00:00 差 **5 小时**，90 分的窗口配不上，6 小时的能。
    """
    # 场次：北京 06-06 19:00 = UTC 11:00
    row_ = row("L1", start=datetime(2026, 6, 6, 11, 0))
    early = item(bvid="BVearly", tier="replay",
                 hint_at=datetime(2026, 6, 7, 0, 0))
    ms = va.match_sessions([row_], [early])
    assert len(ms) == 1, "早场必须能配上前一晚那一场"
    assert ms[0].minutes_delta == 300.0        # +5 小时
    # 但同一场次不该被"当天 20 点"的普通条目抢走：它更近，仍应胜出
    same_night = item(bvid="BVnight", tier="replay",
                      hint_at=datetime(2026, 6, 6, 19, 0))
    ms2 = va.match_sessions([row_], [early, same_night])
    assert ms2[0].candidate.bvid == "BVnight", "更近的那条该是主选"


def test_interrupted_stream_shares_one_recording_between_two_sessions():
    """★ 用户 2026-10-15：「同一场直播被中途切断了，录播就变成了两场……

    让这**两场时间上非常相近的直播合并作为一场直播的录播**」。

    实测形态：一场直播断一次 ⇒ `live_sessions` 里两行（两个 live_id），
    而录播号**只发一条**（标题写的是开播那一刻）。用"一条录播只许配一场"的规则，
    第二段永远配不上 —— 而它就是那一场后半段。
    """
    # 第一段 19:00 开播；断了 40 分钟后 20:40 又开（第二段必然是另一个 live_id）
    first = row("L1", start=datetime(2026, 10, 11, 11, 0))       # 北京 19:00
    second = row("L2", start=datetime(2026, 10, 11, 12, 40))     # 北京 20:40
    # 录播只有一条，标题写的是开播那一刻（19:00）
    rec = item(bvid="BVshared", tier="replay", duration=5 * 3600,
               hint_at=datetime(2026, 10, 11, 19, 0))
    ms = va.match_sessions([first, second], [rec])
    assert len(ms) == 2, "中断续播的两场都该配上这一条录播"
    assert {m.live_id for m in ms} == {"L1", "L2"}
    assert {m.candidate.bvid for m in ms} == {"BVshared"}, "两场共用同一条"
    # 主选是最准的那一场（差 0 分），第二段差 −100 分（它的开播**晚于**录播标的时刻）
    deltas = {m.live_id: m.minutes_delta for m in ms}
    assert deltas["L1"] == 0.0 and deltas["L2"] == -100.0


def test_share_needs_the_same_night():
    """⚠️ 跨夜的两场**不许**共用一份录播（否则深夜与次日早晨会被并成一场）。"""
    night = row("L1", start=datetime(2026, 10, 11, 11, 0))       # 北京 19:00
    morning = row("L2", start=datetime(2026, 10, 12, 0, 0))      # 北京次日 08:00（差 13 小时）
    rec = item(bvid="BVlong", tier="replay", duration=6 * 3600,
               hint_at=datetime(2026, 10, 11, 19, 0))
    ms = va.match_sessions([night, morning], [rec])
    assert [m.live_id for m in ms] == ["L1"], "只有当晚那一场该配上"


def test_share_does_not_apply_within_the_normal_window():
    """同晚但都落在窗口内的两场：仍是**各配各的**（共享只在"超出常规窗口"时兜底）。"""
    a = row("L1", start=datetime(2026, 10, 11, 11, 0))           # 北京 19:00
    b = row("L2", start=datetime(2026, 10, 11, 11, 50))          # 北京 19:50
    r1 = item(bvid="BV1", tier="replay", hint_at=datetime(2026, 10, 11, 19, 0))
    r2 = item(bvid="BV2", tier="replay", hint_at=datetime(2026, 10, 11, 19, 50))
    ms = va.match_sessions([a, b], [r1, r2])
    assert {m.live_id: m.candidate.bvid for m in ms} == {"L1": "BV1", "L2": "BV2"}


# ── 结果排序与漏配 ────────────────────────────────────────────────────

def test_matches_are_sorted_by_confidence_then_time():
    rows = [row("L1", START_UTC), row("L2", START_UTC + timedelta(days=2))]
    items = [item(bvid="BVb", tier="weak", hint_at=None,
                  pub=datetime(2026, 10, 13, 7, 0), duration=7200),
             item(bvid="BVa", hint_at=datetime(2026, 10, 11, 19, 0))]
    ms = va.match_sessions(rows, items)
    assert [m.candidate.bvid for m in ms] == ["BVa", "BVb"]
    assert ms[0].confidence < ms[1].confidence


def test_unmatched_sessions_lists_only_real_gaps():
    """`unmatched_sessions` = 有 id、没录播、又没配上的 —— 就是"手动补"那一列。"""
    rows = [row("L1"), row("L2", START_UTC + timedelta(days=1)),
            row("L3", START_UTC + timedelta(days=2), vod="BVhave")]
    ms = va.match_sessions(rows, [item(hint_at=datetime(2026, 10, 11, 19, 0))])
    assert [m.live_id for m in ms] == ["L1"]
    assert [r["live_id"] for r in va.unmatched_sessions(rows, ms)] == ["L2"]   # L3 已有录播
