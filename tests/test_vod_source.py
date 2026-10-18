# -*- coding: utf-8 -*-
"""录播来源条目的前处理（`app/domain/vod_source.py`，`docs/plans/vod-autofill.md` B1）。

判据对着三类**会静默出错**的地方：

① 标题里的场次时间 —— 解析错了不会报错，只会让这条录播"配不上任何场次"（表现为漏配）；
② 分级 —— 把切片/翻唱当成录播，会污染"时长接近"这条最强的信号；
③ 跨日与跨年 —— `00点场` 属于前一天、无年份标题要按发布时间补年，这两条全靠推断，
   推错就是**配错场次**（比漏配更糟）。

真标题样本取自明前奶绿「直播回放」系列（`series_id=2484684`，942 条，2026-10-14 实测）。
"""
from datetime import datetime, timedelta
import asyncio
import json

import pytest

from app.domain import vod_source as vs

#: 该系列 942/942 都长这样；发布时间取实测值（pub=2026-10-11 16:53 UTC）
REAL_TITLE = "【直播回放】低能小游戏（ 2026年10月11日18点场"
REAL_PUB = datetime(2026, 10, 11, 16, 53)


# ── ① 标题时间解析 ────────────────────────────────────────────────────

def test_parses_the_real_corpus_shape():
    """实测形态：`YYYY年M月D日HH点场` ⇒ 北京墙上时间，且标出来自标题。"""
    hint = vs.parse_time_hint(REAL_TITLE, published_at=REAL_PUB)
    assert hint is not None
    assert hint.at == datetime(2026, 10, 11, 18, 0)
    assert hint.year_from_title is True


def test_parses_iso_style_time():
    """⚠️ 回归：`2026-10-11 18:30` 曾**只解到日期**（时间正则只认「点/时」），
    于是这条与场次差 18 小时、静默配不上。"""
    hint = vs.parse_time_hint("2026-10-11 18:30 直播回放", published_at=REAL_PUB)
    assert hint is not None and hint.at == datetime(2026, 10, 11, 18, 30)


def test_early_morning_label_keeps_the_date_and_gets_a_wider_window():
    """⚠️ **早场（0–5 点）的日期是录播号按惯例写的"前一天"** —— 但解析器**不改日期**。

    实测样本：`【直播回放】吃饱了来一下 2026年06月07日00点场`，发布在 06-06，对应的场次在 06-06。
    旧版只给 `h == 0` 减一天（1–5 点照样错）；现在改成**把"早场"交给匹配窗口表达**：
    标题时刻原样返回，由 `matching_tolerance()` 给一个 6 小时的窗口，让它能配到前一天那一场。
    """
    hint = vs.parse_time_hint("【直播回放】吃饱了来一下 2026年06月07日00点场",
                              published_at=datetime(2026, 6, 6, 14, 0))
    assert hint is not None and hint.at == datetime(2026, 6, 7, 0, 0)
    assert hint.date_only is False
    # 早场 ⇒ 宽窗口；常规时刻 ⇒ 调用方给的默认值
    assert vs.matching_tolerance(hint, 90) == vs.EARLY_TOLERANCE_MINUTES
    normal = vs.parse_time_hint("【直播回放】某场 2026年6月6日19点场")
    assert normal is not None and vs.matching_tolerance(normal, 90) == 90
    # 只在 0–5 点算早场（06 点起是正常的晚间档）
    late = vs.parse_time_hint("【直播回放】某场 2026年6月6日6点场")
    assert late is not None and vs.matching_tolerance(late, 90) == 90


def test_dot_separated_date_is_read_as_date_only():
    """★ 用户 2026-10-15：「录播号有可能标题和直播标题也不完全一样，例如
    `【明前奶绿录播】梦境吱花之国庆回忆 2026.10.10` 实际上就是 10.10 的
    「看看大家的投稿0.0」场次」—— **点号日期**要能读出来、且按"同一天"匹配。
    """
    hint = vs.parse_time_hint("【明前奶绿录播】梦境吱花之国庆回忆 2026.10.10",
                              published_at=datetime(2026, 10, 12, 4, 0))
    assert hint is not None
    assert hint.at == datetime(2026, 10, 10, 0, 0)
    assert hint.date_only is True, "没给时刻 ⇒ 按同一天匹配，不拿 00:00 算时间差"
    assert vs.matching_tolerance(hint, 200) == -1
    # 前缀也不一样（不是"直播回放"）⇒ 归到 dated（有时间没回放词），照样能配
    tier, hint2 = vs.classify("【明前奶绿录播】梦境吱花之国庆回忆 2026.10.10",
                              18000, datetime(2026, 10, 12, 4, 0))
    assert tier == "replay" and hint2 is not None and hint2.date_only


def test_date_only_matches_the_same_day_session_even_if_uploaded_later():
    """例子里那条：10.10 的录播 → 10.10 的场次（隔两天才上传也照样配上）。"""
    session_cn = datetime(2026, 10, 10, 19, 1)               # 北京（场次开播）
    start_utc = session_cn - timedelta(hours=8)
    hint = vs.parse_time_hint("【明前奶绿录播】梦境吱花之国庆回忆 2026.10.10",
                              published_at=datetime(2026, 10, 12, 4, 0))
    assert hint is not None and hint.at.date() == (start_utc + timedelta(hours=8)).date()
    """★ 用户 2026-10-15 指出的第三种形态：**非官方录播号可能晚很久才传，只在标题里标日期**。

    ⇒ 标题只有日期时 `date_only=True`，`matching_tolerance()` 返回 `-1`（"按同一天匹配"），
    调用方**不拿**那个补出来的 00:00 算时间差（算出来会是 −20 小时那种荒谬值）。
    """
    hint = vs.parse_time_hint("【直播回放】第第第一次见面！请多关照！ 2022年9月17日",
                              published_at=datetime(2022, 9, 20, 4, 0))
    assert hint is not None
    assert hint.at == datetime(2022, 9, 17, 0, 0)
    assert hint.date_only is True
    assert vs.matching_tolerance(hint, 90) == -1

    tier, hint2 = vs.classify("【直播回放】某场 2026年9月17日", 18000,
                              datetime(2026, 9, 20, 4, 0))
    assert tier == "replay" and hint2 is not None and hint2.date_only is True


def test_dot_separated_date_is_read_as_date_only():
    """★ 用户 2026-10-15：「录播号有可能标题和直播标题也不完全一样，例如
    `【明前奶绿录播】梦境吱花之国庆回忆 2026.10.10` 实际上就是 10.10 的
    「看看大家的投稿0.0」场次」—— **点号日期**要能读出来、且按"同一天"匹配。
    """
    hint = vs.parse_time_hint("【明前奶绿录播】梦境吱花之国庆回忆 2026.10.10",
                              published_at=datetime(2026, 10, 12, 4, 0))
    assert hint is not None
    assert hint.at == datetime(2026, 10, 10, 0, 0)
    assert hint.date_only is True, "没给时刻 ⇒ 按同一天匹配，不拿 00:00 算时间差"
    assert vs.matching_tolerance(hint, 200) == -1
    # 前缀不是"直播回放"（是"XX录播"）⇒ 仍认得出来（`REPLAY_TOKENS` 含"录播"）
    tier, hint2 = vs.classify("【明前奶绿录播】梦境吱花之国庆回忆 2026.10.10",
                              18000, datetime(2026, 10, 12, 4, 0))
    assert tier == "replay" and hint2 is not None and hint2.date_only
    # 而"标题与直播标题完全不同"这件事本身不是问题：配对只看**日期**，不比标题文字
    assert hint.at.date() == datetime(2026, 10, 10).date()


def test_year_is_inferred_from_publish_date_and_may_roll_back():
    """无年份标题用发布时间补年；补出来的日子比发布日还晚 ⇒ 说的是**去年**（跨年场次）。"""
    hint = vs.parse_time_hint("10月11日18点场 录播", published_at=REAL_PUB)
    assert hint is not None
    assert hint.at == datetime(2026, 10, 11, 18, 0)
    assert hint.year_from_title is False          # 补出来的，调用方可以据此降权

    hint2 = vs.parse_time_hint("12月31日23点场 跨年",
                               published_at=datetime(2026, 1, 1, 4, 0))
    assert hint2 is not None and hint2.at == datetime(2025, 12, 31, 23, 0)


def test_dirty_or_missing_dates_degrade_instead_of_raising():
    """上游标题写错日期/时间时**返回 None 或退化**，不许把整条扫描炸掉。"""
    assert vs.parse_time_hint("【直播回放】某场 2026年2月30日19点场") is None   # 不存在的日期
    assert vs.parse_time_hint("【直播回放】24点场") is None                    # 没有年份也没有时间
    assert vs.parse_time_hint("") is None
    assert vs.parse_time_hint(None) is None
    # 「24点」这种脏值退化成"只用日期"，而不是整条丢掉
    hint = vs.parse_time_hint("2026年10月11日24点场", published_at=REAL_PUB)
    assert hint is not None and hint.at == datetime(2026, 10, 11, 0, 0)


# ── ② 分级 ────────────────────────────────────────────────────────────

def test_real_replay_is_classified_as_replay():
    tier, hint = vs.classify(REAL_TITLE, 20097, REAL_PUB)
    assert tier == "replay" and hint is not None and hint.at.hour == 18


def test_short_uploads_are_excluded():
    """实测该系列有 15 条 <10 分钟的（测试稿/中断稿）——它们不是录播。"""
    assert vs.classify("【直播回放】TEST 2026年08月29日19点场", 146, REAL_PUB)[0] == "excluded"
    assert vs.classify("【直播回放】文字怪谈！ 2024年07月16日20点场", 15, REAL_PUB)[0] == "excluded"


def test_always_excluded_words_kill_the_candidate():
    assert vs.classify("翻唱合集 第一弹", 20000, REAL_PUB)[0] == "excluded"
    assert vs.classify("音声作品 第三弹", 20000, REAL_PUB)[0] == "excluded"


def test_slice_collection_is_excluded_but_a_single_slice_word_is_not():
    """「切片」**单独一刀切会误杀**：有人的整场回放标题里就写着"X月X日直播切片"。
    口径：出现 ≥2 次（=合集本身就是切片集）才排除。"""
    assert vs.classify("演唱会切片合集 切片 切片", 9000, REAL_PUB)[0] == "excluded"
    tier, _ = vs.classify("2026年10月11日18点场 直播切片", 15000, REAL_PUB)
    assert tier == "dated"          # 有可读时间 ⇒ 仍可参与匹配


def test_unknown_duration_is_not_treated_as_short():
    """时长未知（上游没给）**不等于短** —— 当成 0 会让真回放被丢掉。"""
    tier, hint = vs.classify("【直播回放】某场 2026年10月11日18点场", None, REAL_PUB)
    assert tier == "replay" and hint is not None


def test_plain_upload_falls_back_to_weak():
    """投稿流里混的普通投稿：没时间、不像回放 ⇒ weak（只能靠发布时间+时长兜底）。"""
    assert vs.classify("随便一个投稿没有日期", 15000, REAL_PUB)[0] == "weak"
    assert vs.classify(None, 15000, REAL_PUB)[0] == "weak"


# ── ④ 服务层：上游一条 → `SourceItem` 参数（`app/services/vod_source.py::_to_item`） ──

def test_upload_duration_is_read_from_body_json():
    """★ **投稿流的时长在 `body_json.duration` 里**（`"5:34:00"`），不是顶层字段。

    2026-10-15 修：此前只读顶层的 `duration`（那是**系列/合集**的字段）⇒
    每一条投稿都是"时长未知" ⇒ `classify` 里「<10 分钟直接丢」与兜底路径的
    「≥30 分钟」两条**全部失效**（实测 `94009831` 的 99 条投稿里 99 条都是 `None`）。
    """
    import json
    from app.services.vod_source import _to_item

    raw = {
        "platform_post_id": "BV1A8pp6hEjU",
        "title": "【明前奶绿录播】玩点低能小游戏 2026.10.11",
        "body_json": json.dumps({"duration": "5:34:00", "bvid": "BV1A8pp6hEjU"}),
        "published_at": datetime(2026, 10, 11, 16, 0),
        "permalink": "https://www.bilibili.com/video/BV1A8pp6hEjU",
    }
    got = _to_item(raw, mid="94009831", source_name="投稿")
    assert got is not None
    assert got["duration_seconds"] == (5 * 60 + 34) * 60      # 20040 秒
    assert got["tier"] == "replay"
    # 正对照：系列/合集那条路的顶层 `duration`（秒）照旧认
    raw2 = {"bvid": "BV1x", "title": "【直播回放】某场 2026年10月11日19点场",
            "duration": 17904, "pubdate": 1788000000}
    assert _to_item(raw2, mid="1", source_name="直播回放")["duration_seconds"] == 17904


def test_a_short_upload_is_dropped_now_that_duration_is_known():
    """时长能读出来之后，「<10 分钟的切片/动态」才真的会被丢掉（修之前读不到时长 ⇒ 全放过）。"""
    import json
    from app.services.vod_source import _to_item

    raw = {
        "platform_post_id": "BV1short",
        "title": "【明前奶绿录播】一小段",
        "body_json": json.dumps({"duration": "3:20"}),
        "published_at": datetime(2026, 10, 11, 16, 0),
        "permalink": "https://www.bilibili.com/video/BV1short",
    }
    assert _to_item(raw, mid="94009831", source_name="投稿") is None


# ── ⑤ 投稿流的翻页与过滤（`fetch_uploads`，2026-10-15 用户口径） ──────────

def _upload_page(n, *, prefix="BV", title=None, pub=None, duration="5:00:00"):
    """造一页投稿（`fetch_bilibili_videos` 的返回形状）。`title`/`pub` 给函数则按序号算。"""
    items = []
    for i in range(n):
        t = title(i) if callable(title) else (title or f"【直播回放】第 {i} 场 2026年10月11日19点场")
        p = pub(i) if callable(pub) else (pub or datetime(2026, 10, 11, 12, 0))
        items.append({
            "platform_post_id": f"{prefix}{i}",
            "title": t,
            "body_json": json.dumps({"duration": duration}),
            "published_at": p,
            "permalink": f"https://www.bilibili.com/video/{prefix}{i}",
        })
    return items


def _patch_upload_pages(monkeypatch, pages, asked):
    from app.services import vod_source as svc

    async def fake_fetch(mid, page=1, page_size=50, client=None):
        asked.append(page)
        items = pages.get(page, [])
        return {"items": items, "total": sum(len(v) for v in pages.values())}

    monkeypatch.setattr(svc, "fetch_bilibili_videos", fake_fetch)


def test_uploads_paging_stops_when_the_page_is_older_than_the_earliest_session(monkeypatch):
    """★ 翻页判据 = **当页最后一条的发布时间 vs 最早的一场直播**（用户 2026-10-15）。

    投稿按发布倒序 ⇒ 一页里最旧的那条已经早于下界，后面的只会更旧、配不上任何场次。
    这里第 2 页整体落在下界之前 ⇒ 只翻两页（第 3 页**一次都不许请求**），
    且第 2 页那些过旧的条目一条都不进候选。
    """
    asked: list[int] = []
    pages = {
        1: _upload_page(50, prefix="new", pub=datetime(2026, 10, 11, 12, 0)),
        2: _upload_page(50, prefix="old",
                        title=lambda i: f"【直播回放】旧场 {i} 2026年07月01日19点场",
                        pub=datetime(2026, 7, 1, 12, 0)),
        3: _upload_page(40, prefix="ancient",
                        title=lambda i: f"【直播回放】更旧 {i} 2022年01月01日19点场",
                        pub=datetime(2022, 1, 1, 12, 0)),
    }
    _patch_upload_pages(monkeypatch, pages, asked)

    from app.services import vod_source as svc
    out = asyncio.run(svc.fetch_uploads("94009831", stop_before=datetime(2026, 9, 1)))
    assert asked == [1, 2], f"第 3 页不该被请求（asked={asked}）"
    assert len(out) == 50 and all(i["bvid"].startswith("new") for i in out)


def test_uploads_paging_without_a_lower_bound_goes_to_the_short_page(monkeypatch):
    """正对照：不传下界时**照旧一路翻到短页**（下界是优化，不是新的硬限制）。"""
    asked: list[int] = []
    pages = {1: _upload_page(50), 2: _upload_page(50), 3: _upload_page(7)}
    _patch_upload_pages(monkeypatch, pages, asked)

    from app.services import vod_source as svc
    out = asyncio.run(svc.fetch_uploads("94009831"))
    assert asked == [1, 2, 3]
    assert len(out) == 107


def test_uploads_drop_videos_that_are_obviously_not_recordings(monkeypatch):
    """★ 标题和时间**都不像录播**的丢掉（用户 2026-10-15：「视频标题和时间明显不是录播，也丢弃」）。

    判据落在 `tier` 上：`replay`（标题有回放词）/ `dated`（标题有可读场次时间）留，
    `weak`（两样都没有）在投稿流里就是别的投稿混进来了。
    """
    asked: list[int] = []
    pages = {1: [
        {"platform_post_id": "BVkeep1", "title": "【直播回放】某场 2026年10月11日19点场",
         "body_json": json.dumps({"duration": "5:00:00"}),
         "published_at": datetime(2026, 10, 12, 3, 0), "permalink": "https://b/BVkeep1"},
        {"platform_post_id": "BVdrop", "title": "新衣服展示与幕后花絮",
         "body_json": json.dumps({"duration": "5:00:00"}),
         "published_at": datetime(2026, 10, 12, 3, 0), "permalink": "https://b/BVdrop"},
        {"platform_post_id": "BVkeep2", "title": "2026.10.10 随便聊聊",
         "body_json": json.dumps({"duration": "5:00:00"}),
         "published_at": datetime(2026, 10, 12, 3, 0), "permalink": "https://b/BVkeep2"},
    ]}
    _patch_upload_pages(monkeypatch, pages, asked)

    from app.services import vod_source as svc
    out = asyncio.run(svc.fetch_uploads("94009831", stop_before=datetime(2026, 1, 1)))
    assert [i["bvid"] for i in out] == ["BVkeep1", "BVkeep2"]
    assert [i["tier"] for i in out] == ["replay", "dated"]


def test_upload_times_are_normalized_to_naive_utc():
    """★ 投稿流给的是**带时区**的 datetime，必须归一成朴素 UTC。

    2026-10-15 真机实测：不归一 ⇒ 翻页下界那一比直接抛
    `TypeError: can't compare offset-naive and offset-aware datetimes`，
    整个投稿号 `ok=False`（而系列那条路照旧正常，所以看起来像"这个号有问题"）。
    """
    import json
    from datetime import timezone
    from app.services.vod_source import _to_item

    aware = datetime(2026, 10, 11, 16, 53, tzinfo=timezone.utc)
    raw = {
        "platform_post_id": "BV1tz",
        "title": "【直播回放】某场 2026年10月11日19点场",
        "body_json": json.dumps({"duration": "5:00:00"}),
        "published_at": aware,
        "permalink": "https://www.bilibili.com/video/BV1tz",
    }
    got = _to_item(raw, mid="1", source_name="投稿")
    assert got["published_at"] == datetime(2026, 10, 11, 16, 53)
    assert got["published_at"].tzinfo is None
    # 和场次时刻（朴素 UTC）比得起来 —— 这正是上面那个 TypeError 的现场
    assert got["published_at"] < datetime(2026, 10, 12, 0, 0)


# ── ⑥ 与场次对齐用的常量 ──────────────────────────────────────────────
def test_module_constants_match_the_measured_corpus():
    """这几个阈值是**实测定出来的**，改动要让用例红（否则静默放宽/收紧）。

    实测（2026-10-14，942 条）：时长中位 17904s、p25 15730s；<600s 的 15 条。
    """
    assert vs.MIN_REPLAY_SECONDS == 600
    assert vs.MIN_FALLBACK_SECONDS == 1800
    assert vs.MIN_FALLBACK_SECONDS > vs.MIN_REPLAY_SECONDS   # 兜底必然更严
    assert vs.MINUTE == timedelta(minutes=1)
