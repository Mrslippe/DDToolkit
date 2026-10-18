# -*- coding: utf-8 -*-
"""多录播号的优先级与兜底（`app/services/vod_scan.py`，`docs/plans/vod-autofill.md` B2）。

用户口径（2026-10-14）：「支持同时添加多个账号并设定优先级，高优先级的缺漏由低优先级兜底」。

这里守三条会**静默出错**的性质：

① **顺序就是优先级**（`vod_account_uid` 左 = 高优先）—— 排错了不会报错，只是配错来源；
② **高优先占位后低优先不得覆盖** —— 兜底池必须逐号收窄，否则低优先号会抢走高优先的场次；
③ **已有 `vod_url` 的场次全程不参与** —— 那是用户手填的（不变量 39）。

取数可注入 ⇒ 这些判据**不需要网络**。
"""
import asyncio
from datetime import datetime, timedelta

from app.domain import vod_autofill as va
from app.domain.vod_source import TimeHint
from app.services import vod_scan as vs
from app.services.vod_scan import AccountScan, ScanResult

START_UTC = datetime(2026, 10, 11, 11, 0)          # 北京 19:00


def row(live_id, start=START_UTC, vod=None):
    return {"live_id": live_id, "start_at": start, "vod_url": vod,
            "live_title": f"场次 {live_id}"}


def fake_item(bvid, hint_at, mid, duration=18000):
    return {
        "bvid": bvid, "title": f"【直播回放】{bvid}", "duration_seconds": duration,
        "published_at": START_UTC - timedelta(hours=4),
        "permalink": f"https://www.bilibili.com/video/{bvid}",
        "cover_url": "", "mid": mid, "source_name": "直播回放",
        "tier": "replay", "hint": TimeHint(at=hint_at, year_from_title=True),
    }


# ── ① 顺序 = 优先级 ───────────────────────────────────────────────────

def test_vod_accounts_come_first_and_the_vtuber_own_account_is_last():
    mids = vs.ordered_mids("2132180406", "111, 222")
    assert mids == ["111", "222", "2132180406"]


def test_ordered_mids_dedupes_but_keeps_priority_order():
    """重复扫同一个号是浪费，而顺序是语义 —— 去重必须保序。"""
    assert vs.ordered_mids("111", "222,111,333") == ["222", "111", "333"]
    assert vs.ordered_mids(None, "1,1,2") == ["1", "2"]
    assert vs.ordered_mids("111", None) == ["111"]
    assert vs.ordered_mids(None, None) == []
    # 中文逗号也要认（用户手输的常见形态）
    assert vs.ordered_mids(None, "1，2") == ["1", "2"]


# ── ② 兜底：高优先占位，低优先只补缺 ──────────────────────────────────

def _scan(rows, mids, mapping, sources=None):
    """`mapping[mid] = [items]`；`sources[mid]` 可覆盖来源名。**都不碰网络**。"""
    async def resolve(mid, **_kw):
        if sources is not None and mid not in sources:
            return None
        return {"kind": "series", "id": "1", "name": (sources or {}).get(mid, f"回放-{mid}")}

    async def fetch(mid, _source):
        return mapping.get(mid, [])

    return asyncio.run(vs.scan(rows, mids, fetch_items=fetch, resolve=resolve))


def test_lower_priority_fills_only_what_the_higher_one_missed():
    rows = [row("L1"), row("L2", START_UTC + timedelta(days=1))]
    high = [fake_item("BVhigh", datetime(2026, 10, 11, 19, 0), "H")]           # 只配 L1
    low = [fake_item("BVlow1", datetime(2026, 10, 11, 19, 0), "L"),            # 也想配 L1
           fake_item("BVlow2", datetime(2026, 10, 12, 19, 0), "L")]            # L2 只有它
    res = _scan(rows, ["H", "L"], {"H": high, "L": low})
    got = {m.live_id: m.candidate.bvid for m in res.matches}
    assert got == {"L1": "BVhigh", "L2": "BVlow2"}       # ⚠️ L1 没被低优先抢走
    assert [a.matched for a in res.accounts] == [1, 1]
    assert res.unmatched == []


def test_a_miss_on_the_high_priority_account_is_left_for_the_lower_one():
    """高优先号**取不到东西**时，那一场必须留给下一个号（不是记成"已处理"）。

    `ok` 的语义在这里定清楚：**这次取数有没有成**（不是"有多少条"）——
    "该号确实是空的"（`ok=True, item_count=0`）与"这次没取到"（`ok=False` + `error`）
    要分得开，否则界面说不出"是这个号没有，还是刚才没连上"。
    """
    rows = [row("L1")]
    low = [fake_item("BVlow", datetime(2026, 10, 11, 19, 0), "L")]
    # H 在 sources 里缺席 ⇒ resolve 返回 None ⇒ 该号算"没取到"
    res = _scan(rows, ["H", "L"], {"H": [], "L": low}, sources={"L": "回放-L"})
    assert [m.candidate.bvid for m in res.matches] == ["BVlow"]
    assert res.accounts[0].ok is False and res.accounts[0].matched == 0
    assert res.accounts[0].error                       # 失败要带得出原因


def test_an_empty_but_successful_account_is_ok_true():
    """⚠️ 与上一条成对：**号是空的**（取数成功、0 条）不是失败 —— `ok=True`。"""
    async def resolve(mid, **_kw):
        return {"kind": "series", "id": "1", "name": "空系列"}

    async def fetch(mid, _s):
        return []

    res = asyncio.run(vs.scan([row("L1")], ["H"], fetch_items=fetch, resolve=resolve))
    assert res.accounts[0].ok is True
    assert res.accounts[0].item_count == 0
    assert res.accounts[0].error is None
    assert [r["live_id"] for r in res.unmatched] == ["L1"]     # 那一场如实留在待补里


def test_all_accounts_empty_leaves_everything_unmatched():
    rows = [row("L1"), row("L2", START_UTC + timedelta(days=1))]
    res = _scan(rows, ["H", "L"], {})
    assert res.matches == []
    assert [r["live_id"] for r in res.unmatched] == ["L2", "L1"]   # 新的在前（供审查表看）


# ── ③ 已有录播不参与 ──────────────────────────────────────────────────

def test_sessions_with_a_manual_vod_never_enter_the_pool():
    rows = [row("L1", vod="BVmanual"), row("L2", START_UTC + timedelta(days=1))]
    high = [fake_item("BVhigh", datetime(2026, 10, 11, 19, 0), "H"),
            fake_item("BVhigh2", datetime(2026, 10, 12, 19, 0), "H")]
    res = _scan(rows, ["H"], {"H": high})
    assert [m.live_id for m in res.matches] == ["L2"]
    assert "L1" not in [r["live_id"] for r in res.unmatched]      # 也不该出现在"待补"里


# ── 记账与来源标注 ────────────────────────────────────────────────────

def test_account_records_carry_source_name_and_counts():
    rows = [row("L1")]
    res = _scan(rows, ["H"], {"H": [fake_item("BV1", datetime(2026, 10, 11, 19, 0), "H")]},
                sources={"H": "直播回放"})
    acc: AccountScan = res.accounts[0]
    assert acc.ok is True and acc.item_count == 1 and acc.matched == 1
    assert acc.source and acc.source["name"] == "直播回放"
    # 候选条目要带上"来自哪个号、哪个来源" —— 审查表靠它说"为什么是它"
    m = res.matches[0]
    assert m.candidate.mid == "H"
    assert m.candidate.source_name == "直播回放"


def test_resolve_failure_is_recorded_not_raised():
    async def bad_resolve(mid, **_kw):
        raise RuntimeError("上游炸了")

    async def fetch(mid, _s):        # pragma: no cover - 不该被调用
        raise AssertionError("resolve 失败时不该继续取数")

    res = asyncio.run(vs.scan([row("L1")], ["H"], fetch_items=fetch, resolve=bad_resolve))
    assert res.matches == []
    assert res.accounts[0].error and "上游炸了" in res.accounts[0].error


def test_scan_result_is_sorted_for_review():
    rows = [row("L2", START_UTC + timedelta(days=1)), row("L1")]
    items = [fake_item("BVa", datetime(2026, 10, 11, 19, 0), "H"),
             fake_item("BVb", datetime(2026, 10, 12, 19, 0), "H")]
    res = _scan(rows, ["H"], {"H": items})
    assert [m.start_at for m in res.matches] == sorted(m.start_at for m in res.matches)


# ── ③ 来源自动挑：没有合集/系列时**退回投稿流**（2026-10-15 用户实测） ──────

def _fake_list_sources(sources):
    """替换 `vod_source.list_sources` 的最小桩（**不碰网络**）。"""
    async def _ls(mid, **_kw):
        return sources
    return _ls


def test_resolve_falls_back_to_uploads_when_the_account_has_no_series(monkeypatch):
    """★ **一个"全是投稿"的号必须能扫**（用户 2026-10-15 报回来的 bug）。

    实测形态：`94009831` 的清单接口 HTTP 200 / `code=0`，但 seasons 与 series
    **两个列表都是空的** —— 那个号的 1093 条录播全在**投稿**里。
    此前 `resolve_source` 只挑系列/合集 ⇒ `pick_source([])` = None ⇒ 整个号被报成
    「没找到可扫的来源（合集/系列为空，投稿也没取到）」，而投稿那条路**根本没试过**。
    """
    from app.services import vod_source as src_mod

    only_uploads = [{"kind": "uploads", "id": "", "name": "投稿", "total": None}]
    monkeypatch.setattr(src_mod, "list_sources", _fake_list_sources(only_uploads))
    picked = asyncio.run(vs.resolve_source("94009831"))
    assert picked is not None and picked["kind"] == "uploads", picked


def test_resolve_still_prefers_a_series_when_there_is_one(monkeypatch):
    """正对照：有系列时**不许**被投稿抢走（名字命中 + 有条数）。"""
    from app.services import vod_source as src_mod

    both = [{"kind": "series", "id": "2484684", "name": "直播回放", "total": 942},
            {"kind": "uploads", "id": "", "name": "投稿", "total": None}]
    monkeypatch.setattr(src_mod, "list_sources", _fake_list_sources(both))
    picked = asyncio.run(vs.resolve_source("2132180406"))
    assert picked and picked["kind"] == "series" and picked["id"] == "2484684", picked


def test_scan_hands_the_earliest_session_to_the_fetcher_as_a_lower_bound():
    """★ 取数下界 = **库里最早的一场直播 − 一天**（用户 2026-10-15 的翻页口径）。

    投稿流靠它决定"翻到第几页就停"，所以这条必须真的传下去 ——
    传丢了的症状是"翻满 24 页"（慢，而且没有错），**不会报错**。
    `PAGE_STOP_MARGIN` 那一天的边距是防"刚好跨过边界的那一页被切掉"。
    """
    from app.services import vod_source as src_mod

    seen: dict = {}

    async def resolve(mid, **_kw):
        return {"kind": "uploads", "id": "", "name": "投稿"}

    async def fetch(mid, source):
        seen.update(source)
        return []

    rows = [row("L-new", datetime(2026, 10, 11, 11, 0)),
            row("L-old", datetime(2026, 8, 1, 11, 0))]
    asyncio.run(vs.scan(rows, ["H"], fetch_items=fetch, resolve=resolve))
    assert seen["stop_before"] == datetime(2026, 8, 1, 11, 0) - src_mod.PAGE_STOP_MARGIN
    # 正对照：场次全都没有时间时，不编一个下界出来（宁可不早停）
    seen.clear()
    asyncio.run(vs.scan([{"live_id": "L", "start_at": None, "vod_url": None}], ["H"],
                        fetch_items=fetch, resolve=resolve))
    assert seen["stop_before"] is None
