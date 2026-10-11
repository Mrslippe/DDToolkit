# -*- coding: utf-8 -*-
"""C1「找录播」的匹配口径与取数（需求 2.1，`devlog/464`）。

判据对着三类**会静默出错**的地方：
① 时长串解析（`"1:45:32"` → 分钟）—— 认不出必须 `None`（当 0 会把真回放排到最后）；
② 打分（时长接近 / 开播后发布 / 标题重合各自的分量，"时长远短"要**减出来**）；
③ 取数：**时间窗是硬门槛**（窗口外的不能进候选）、翻页按时间窗停、
   上游取数失败**不许伪装成"没有回放"**。
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.domain import vod_match as vm
from app.services import vod_finder as vf

T0 = datetime(2026, 9, 25, 7, 18, tzinfo=timezone.utc)


# ── ① 时长解析 ────────────────────────────────────────────────────────

def test_parse_duration():
    assert vm.parse_duration("1:45:32") == 106        # 32 秒不进位
    assert vm.parse_duration("2:00:30") == 121        # 30 秒进位
    assert vm.parse_duration("45:32") == 46
    assert vm.parse_duration("12:00:30") == 721
    # ⚠️ 认不出 ⇒ **None**（不是 0）：0 分钟会被当成"严重不匹配"，
    #    一条真回放因为上游没给 length 就被排到最后
    assert vm.parse_duration("") is None
    assert vm.parse_duration(None) is None
    assert vm.parse_duration("坏值") is None
    assert vm.parse_duration("0:00:00") is None
    assert vm.parse_duration("1:2:3:4") is None
    assert vm.parse_duration("-1:30") is None


def test_title_overlap_ignores_layout_and_keeps_two_char_words():
    assert vm.title_parts("【3D】新人首播") == ["3D", "新人首播"]
    assert vm.title_overlap("深夜杂谈", "【杂谈】随便聊聊") != []      # 互为子串
    assert vm.title_overlap("的", "的") == []                        # 单字不算
    # ⚠️ 两边毫无关系是**正常**的（实测真回放标题常与场次标题无关）⇒ 空列表不是错误
    assert vm.title_overlap("好不容易休息了", "最肯忘却古人诗") == []


# ── ② 打分 ────────────────────────────────────────────────────────────

def score(**kw):
    base = dict(start_at=T0, duration_minutes=193, published_at=T0 + timedelta(hours=23),
                video_minutes=149, session_title="鬼武者叮咚⭐", video_title="随便起的名")
    base.update(kw)
    return vm.score_candidate(**base)


def test_duration_is_the_strongest_signal():
    """时长接近（149 vs 193，容差 = max(35%, 20 分) = 68）⇒ 加满分 60，且理由说得出来。"""
    s, plus, minus = score()
    assert s >= 80 and any("时长接近" in p for p in plus)
    # 时长远短（剪辑/翻唱的特征）⇒ **减出来**（不进分，还要给一句 cautions）
    s2, _p2, minus2 = score(video_minutes=3)
    assert s2 < 40 and any("时长远短" in m for m in minus2)


def test_published_after_start_beats_published_before():
    """回放**必然**在开播之后；发布在开播前要扣（那多半是上一场的或普通投稿）。"""
    after, plus_a, minus_a = score(published_at=T0 + timedelta(hours=2))
    before, _plus_b, minus_b = score(published_at=T0 - timedelta(hours=1))
    assert after > before
    assert any("开播后发布" in p for p in plus_a) and not minus_a
    assert any("开播**之前**" in m for m in minus_b)


def test_unknown_duration_does_not_penalise():
    """时长未知 ⇒ **不加不减**（不能因为上游没给 length 就把它当"不匹配"）。"""
    s, plus, minus = score(video_minutes=None)
    assert not any("时长" in p for p in plus)
    assert not any("时长" in m for m in minus)
    assert s > 0        # 时间那条照样给分


def test_title_hits_add_but_never_subtract():
    with_hit, plus, _m = score(video_title="鬼武者叮咚⭐ 回放")
    without, _p, _m2 = score(video_title="完全无关的标题")
    assert with_hit > without and any("标题重合" in p for p in plus)


def test_naive_and_aware_datetimes_can_be_compared():
    """库里的时间是**朴素 UTC**、B 站给的是带偏移的 —— 混比不许炸。"""
    s, _plus, _minus = score(start_at=datetime(2026, 9, 25, 7, 18),       # 朴素
                             published_at=T0 + timedelta(hours=1))        # 带偏移
    assert s > 0


# ── ③ 取数（时间窗硬门槛 / 停页 / 失败不伪装）──────────────────────────

def item(bvid: str, *, minutes: int | None, hours_after: float | None,
         title: str = "标题") -> dict:
    pub = None if hours_after is None else T0 + timedelta(hours=hours_after)
    return {"platform_post_id": bvid, "title": title, "permalink": f"https://b/{bvid}",
            "published_at": pub, "cover_url": "",
            "body_json": f'{{"duration": "{"%d:00" % minutes if minutes else ""}"}}'}


@pytest.fixture
def session():
    return {"start_at": T0, "end_at": T0 + timedelta(minutes=193), "live_title": "鬼武者叮咚⭐"}


def _patch_pages(monkeypatch, pages: dict[int, dict | None], seen: list[int] | None = None):
    async def fake(mid, page=1, page_size=30, client=None):
        if seen is not None:
            seen.append(page)
        return pages.get(page)
    monkeypatch.setattr(vf, "fetch_bilibili_videos", fake)


def test_window_outside_candidates_are_dropped(monkeypatch, session):
    """★ 时间窗是**硬门槛**：一个月前那条 190 分钟的实况不许进候选（第一版就是这样错的）。"""
    _patch_pages(monkeypatch, {1: {"items": [
        item("BV-old", minutes=190, hours_after=-24 * 30, title="一个月前的实况"),
        item("BV-fresh", minutes=149, hours_after=23),
    ]}})
    out = asyncio.run(vf.find_candidates(session, ["1"]))
    assert [c["bvid"] for c in out] == ["BV-fresh"]
    assert out[0]["in_window"] is True


def test_paging_stops_when_the_window_is_passed(monkeypatch, session):
    """★ 时间窗停页：第一页里最早那条已早于开播 ⇒ 不再翻第二页（倒序，后面只会更早）。"""
    seen: list[int] = []
    _patch_pages(monkeypatch, {1: {"items": (
        [item(f"BV{i}", minutes=149, hours_after=None) for i in range(29)]
        + [item("BV-old", minutes=149, hours_after=-24 * 10)])}}, seen=seen)
    asyncio.run(vf.find_candidates(session, ["1"]))
    assert seen == [1]


def test_paging_continues_while_still_inside_the_window(monkeypatch, session):
    """第一页还全在窗口内 ⇒ 继续翻（按发布时间倒序，说明窗口还没走完），
    并且**第二页里那条像回放的能排到第一**（翻页不是为了凑数，是为了找到它）。"""
    seen: list[int] = []
    # 第一页全是 5 分钟的切片（时长分给不上），第二页那条才是 193 分钟的回放
    page1 = {"items": [item(f"BV{i}", minutes=5, hours_after=1 + i * 0.1)
                       for i in range(30)]}
    page2 = {"items": [item("BV-hit", minutes=193, hours_after=20)]}
    _patch_pages(monkeypatch, {1: page1, 2: page2}, seen=seen)
    out = asyncio.run(vf.find_candidates(session, ["1"]))
    assert seen[:2] == [1, 2], "第一页没越过时间窗 ⇒ 必须接着翻"
    assert out and out[0]["bvid"] == "BV-hit", "翻出来的那条回放要排在最前"


def test_upstream_failure_is_not_disguised_as_no_replay(monkeypatch, session):
    """★ 取数失败（风控/未登录）⇒ 已经取到的**照样按候选交出来**，不能说成"没有回放"。

    ⚠️ 这条判据必须让**第一页成功、第二页失败**：只在第一页就失败时 `collected` 是空的，
    "失败时直接把原始条目返回"那个 bug（原始条目没有 `in_window` 等键 ⇒ 调用方 KeyError）
    根本露不出来 —— 第一版就是这么写的，变异当场没被杀死。
    """
    seen: list[int] = []
    page1 = {"items": [item(f"BV{i}", minutes=190, hours_after=1 + i * 0.1)
                       for i in range(30)]}
    _patch_pages(monkeypatch, {1: page1, 2: None}, seen=seen)
    out = asyncio.run(vf.find_candidates(session, ["1"]))
    assert seen[:2] == [1, 2]
    assert out, "第一页取到的候选不该因为第二页失败就丢掉"
    # 返回的必须是**候选**（映射过），不是原始上游条目
    assert all("in_window" in c and "score" in c and "reasons" in c for c in out)
    assert all(c["in_window"] for c in out)


def test_mids_are_scanned_and_ranked_together(monkeypatch, session):
    """V 自己的号与录播号**平等竞争**：谁像回放谁排前面（不看是谁的号）。"""
    calls: list[str] = []

    async def fake(mid, page=1, page_size=30, client=None):
        calls.append(str(mid))
        if str(mid) == "self":
            return {"items": [item("BV-self", minutes=3, hours_after=2, title="切片")]}
        return {"items": [item("BV-group", minutes=190, hours_after=26, title="录播组")]}
    monkeypatch.setattr(vf, "fetch_bilibili_videos", fake)

    out = asyncio.run(vf.find_candidates(session, ["self", "group"]))
    assert set(calls) == {"self", "group"}
    assert [c["bvid"] for c in out] == ["BV-group", "BV-self"], "时长像的那条必须排前面"


def test_candidates_are_capped(monkeypatch, session):
    """候选封顶（给用户点选的东西不该是一屏列表）。"""
    _patch_pages(monkeypatch, {1: {"items": [
        item(f"BV{i}", minutes=190, hours_after=1 + i * 0.01) for i in range(30)]}})
    out = asyncio.run(vf.find_candidates(session, ["1"]))
    assert len(out) == vf.MAX_CANDIDATES


def test_default_mids_puts_the_v_account_first_and_dedupes():
    """`default_mids`：V 自己的号在前，用户指定的录播号在后，且去重（含中文逗号）。"""
    class _Acc:
        platform = "bilibili"
        platform_uid = "111"
        vtuber_id = 7

    class _V:
        vod_account_uid = "222, 111，333"

    mids = vf.default_mids(db=None, account=_Acc(), vtuber=_V())
    assert mids == ["111", "222", "333"]


def test_window_text_is_human_readable():
    txt = vf.window_text(T0)
    assert "2026-09-25" in txt and "开播" in txt
