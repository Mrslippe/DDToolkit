# -*- coding: utf-8 -*-
"""手动记录场次的纯函数（B2，devlog/454）：`app/domain/live_manual.py` 的判据。

三件事各有一组用例，都是**纯计算**（不起 HTTP、不开库）：
① 录播地址规范化（能点开才算存对了）；② 用户填的时间 → UTC naive；
③ 两段时间是否重叠（冲突提示的判据）。

⚠️ 白名单对账（产出主机必须在 `lib.rs::EXTERNAL_HOSTS` 里）**不在这里** ——
它在 `tests/test_external_link_hosts.py` 的第三条判据，与另外两条同处一个真源旁边。
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.domain.live_manual import (BV_RE, VOD_CANONICAL, VodUrlError, bvid_of,
                                    is_manual_source, normalize_vod,
                                    sessions_overlap, to_utc_naive)

BV = "BV1xx411c7mD"
CST = timezone(timedelta(hours=8))


# ── ① 录播地址规范化 ────────────────────────────────────────────────

def test_bare_bv_becomes_a_clickable_url():
    """裸 BV 号 → 规范外链（这是最常见的手填形态：从 B 站页面地址栏里抠出来的那一段）。"""
    assert normalize_vod(BV) == VOD_CANONICAL.format(bvid=BV)
    assert normalize_vod(f"  {BV}  ") == VOD_CANONICAL.format(bvid=BV)


@pytest.mark.parametrize("raw", [
    f"https://www.bilibili.com/video/{BV}",
    f"https://m.bilibili.com/video/{BV}",                       # 移动端域名 → 收敛到 www
    f"https://bilibili.com/video/{BV}",                         # 裸域
    f"https://www.bilibili.com/video/{BV}?spm_id_from=333.999",  # 分享链接的跟踪参数
    f"https://www.bilibili.com/video/{BV}/",                    # 末尾斜杠
    f"https://www.bilibili.com/video/{BV}?vd_source=abc&p=3",   # 分 P（要保留）
])
def test_video_links_collapse_to_one_shape(raw):
    """各种分享形态 → **同一种**入库形态（`p` 是唯一保留的查询参数：它选的是分 P）。"""
    got = normalize_vod(raw)
    assert got == VOD_CANONICAL.format(bvid=BV) + ("?p=3" if "p=3" in raw else "")
    # 反面对照：跟踪参数一个都不许进库（否则"同一场"会有好几个不同的 vod_url）
    assert "spm_id_from" not in got and "vd_source" not in got


@pytest.mark.parametrize("raw,why", [
    ("https://b23.tv/abc123", "短链"),
    (f"http://www.bilibili.com/video/{BV}", "非 https"),
    (f"https://www.youtube.com/watch?v={BV}", "非 B 站主机"),
    ("https://www.bilibili.com/video/av12345", "没有 BV 号"),
    ("https://live.bilibili.com/12345", "直播间不是录播"),
    ("随便写点什么", "不是地址也不是 BV 号"),
    ("https://evil.com/video/BV1xx411c7mD", "别的主机（哪怕带 BV 号也不行）"),
])
def test_bad_vod_is_rejected_with_a_reason(raw, why):
    """不合格 → `VodUrlError`，且**每一条都带一句中文原因**（路由层 422 直接回显给用户）。

    判据不只是"拒了"，还要求原因里带上"能照着改"的信息量：空消息 = 用户只看到"422"。
    """
    with pytest.raises(VodUrlError) as e:
        normalize_vod(raw)
    assert str(e.value).strip(), f"{why} 被拒了但没给原因"


def test_blank_vod_is_none_not_an_error():
    """空 = "没有录播地址"（合法状态：不是每场都有录播），不是错误。"""
    assert normalize_vod(None) is None
    assert normalize_vod("") is None
    assert normalize_vod("   ") is None


def test_bvid_of_extracts_or_gives_up():
    """提取器：只要路径里有 BV 号就认（**不做主机校验** —— 校验是 `normalize_vod` 的事）。"""
    assert bvid_of(BV) == BV
    assert bvid_of(f"https://www.bilibili.com/video/{BV}?p=2") == BV
    assert bvid_of("https://www.bilibili.com/video/av123") is None
    assert bvid_of(None) is None
    assert bvid_of("") is None
    # 形态边界：BV + 10 位（少了不认 —— 否则 `BV1` 这种前缀会被当 id 存进库）
    assert not BV_RE.fullmatch("BV1")
    assert not BV_RE.fullmatch(BV + "9")


def test_malformed_url_does_not_raise_valueerror():
    """畸形输入走"用户填错了"这条路（`VodUrlError`），**不是**未捕获的 ValueError。

    `urlsplit("http://[")` 会抛 `ValueError: Invalid IPv6 URL` —— 没有这层兜底，
    用户贴一串乱码拿到的是 500（界面上显示"服务器内部错误"），而不是"看不懂这个地址"。
    """
    with pytest.raises(VodUrlError):
        normalize_vod("http://[::1/video/BV1xx411c7mD")
    assert bvid_of("http://[::1/x") is None


# ── ② 用户填的时间 → UTC naive ──────────────────────────────────────

def test_naive_input_is_read_as_local_wall_clock():
    """`<input type="datetime-local">` 的产物（不带偏移）按**本机本地时区**解释。

    这条是整批改动里最容易静默错的一处：当成 UTC 存下来，东八区用户填的 20:30
    在日历上会显示成次日 04:30 —— 一个用户说不清、代码里也看不出的错。
    `local_tz` 注入让判据与运行机器的时区无关（显式 +08:00）。
    """
    got = to_utc_naive(datetime(2026, 10, 8, 20, 30), local_tz=CST)
    assert got == datetime(2026, 10, 8, 12, 30)
    assert got.tzinfo is None                     # 库内口径：naive UTC


def test_aware_input_is_converted_by_its_offset():
    """带偏移的输入按偏移换算（同一时刻的两种写法 → 同一个值）。"""
    a = to_utc_naive(datetime(2026, 10, 8, 20, 30, tzinfo=CST))
    b = to_utc_naive(datetime(2026, 10, 8, 12, 30, tzinfo=timezone.utc))
    assert a == b == datetime(2026, 10, 8, 12, 30)
    # 系统时区默认值时也必须是同一时刻（本地机 +08:00 ⇒ 同上；UTC 机器上也自洽）
    assert to_utc_naive(datetime(2026, 10, 8, 12, 30, tzinfo=timezone.utc)) == b


# ── ③ 冲突判定（两段时间是否重叠） ──────────────────────────────────

T = datetime(2026, 10, 8, 12, 0)


@pytest.mark.parametrize("a_end,b_start,b_end,expect", [
    (T + timedelta(hours=2), T + timedelta(hours=1), T + timedelta(hours=3), True),   # 交叉
    (T + timedelta(hours=2), T + timedelta(hours=2), T + timedelta(hours=3), True),   # 端点相等
    (T + timedelta(hours=2), T - timedelta(hours=1), T, True),                        # 端点相等（另一侧）
    (T + timedelta(hours=2), T + timedelta(hours=3), T + timedelta(hours=4), False),  # 分开
    (T + timedelta(hours=2), T - timedelta(hours=2), T - timedelta(hours=1), False),  # 在之前
    (None, T - timedelta(hours=1), T + timedelta(hours=1), True),   # 我方未记结束 → 开放
    (None, T + timedelta(hours=1), T + timedelta(hours=2), True),   # 开放区间与它之后的重叠
    (T + timedelta(hours=2), T + timedelta(hours=1), None, True),   # 对方进行中（无 end）
    (T + timedelta(hours=2), T + timedelta(hours=3), None, False),  # 对方进行中，但我已结束后才开始
    (None, T + timedelta(hours=1), None, True),                     # 两边都开放
])
def test_sessions_overlap_table(a_end, b_start, b_end, expect):
    """重叠表：端点相等算冲突（同一时间一个 V 只可能有一场），`end=None` 视为开放区间。"""
    assert sessions_overlap(T, a_end, b_start, b_end) is expect


# ── ④ source 分词 ──────────────────────────────────────────────────

@pytest.mark.parametrize("src,expect", [
    ("manual", True),
    ("manual+self", True),
    ("feed+manual", True),
    ("danmakus", False),
    ("danmakus+self", False),
    (None, False),
    ("", False),
])
def test_is_manual_source_splits_composite(src, expect):
    """判据是**分词**而不是等值：合并后是 `feed+manual` 这样的组合串。

    写成 `source == "manual"` 会在"用户补的这一场恰好被并进相邻段"时判错，
    而那正是编辑/删除按钮该不该出现的时候。
    """
    assert is_manual_source(src) is expect
