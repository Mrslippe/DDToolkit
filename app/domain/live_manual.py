"""手动记录场次的纯函数（B2，devlog/454）：**本地时间归一** + **录播地址规范化** + 冲突重叠判定。

用户口径（2026-10-08）：「日历上能手动补一场 + 给场次存录播地址」。

**这里不许有任何 IO**（见 `app/domain/__init__.py`）：主键三件事都是纯计算 ——
路由层要把「用户填的墙上时间」换成库里的 UTC naive、把「用户贴的地址」换成**能点开**的外链、
还要判断这段时间是不是已经有场次。放这里才能被 `tests/test_live_manual.py` 直接钉住，
不必起 HTTP 也不是绕过端点测"内部函数"。

## 为什么录播地址必须**规范化**而不是原样存

外链能不能打开由壳的主机白名单决定（`frontend/src-tauri/src/lib.rs::EXTERNAL_HOSTS`，
只认 `https://` + 精确主机）。用户手里那串东西的形态是散的：裸 `BV1xx411c7mD`、
带一堆跟踪参数的分享链接、`m.bilibili.com` 移动端域名、`b23.tv` 短链……
**原样存下来等于把"能不能点开"推迟到用户点击那一刻**，而那时只能弹一句「打不开」。
所以入库前统一成唯一形态：`https://www.bilibili.com/video/<BV号>[?p=N]`。
白名单那边由 `tests/test_external_link_hosts.py` 的第三条判据对账（产出主机必须在名单里）。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone, tzinfo
from urllib.parse import parse_qs, urlsplit

#: 录播地址的规范形态（唯一的入库形态；`p` 是多 P 视频的分 P 号）
VOD_CANONICAL = "https://www.bilibili.com/video/{bvid}"
#: BV 号（B 站视频 id：`BV` + 10 位 base58）
BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")
#: 接受**输入**的 B 站视频主机（输出一律收敛到 `www.bilibili.com`，见 VOD_CANONICAL）
VOD_INPUT_HOSTS = frozenset({"bilibili.com", "www.bilibili.com", "m.bilibili.com"})


class VodUrlError(ValueError):
    """录播地址不合格 —— `str(e)` 是**给用户看的中文原因**（路由层 422 直接回显）。"""


def bvid_of(raw: str | None) -> str | None:
    """从「BV 号 / B 站视频链接」里抠出 BV 号；抠不到 → None（**不做校验**，只做提取）。"""
    s = (raw or "").strip()
    if not s:
        return None
    hit = BV_RE.fullmatch(s)
    if hit:
        return hit.group(0)
    hit = BV_RE.search(_split(s).path)
    return hit.group(0) if hit else None


def _split(url: str):
    """`urlsplit` 的兜底版：畸形输入（如 `http://[`）返回空结果而不是抛 ValueError。

    路由层把这里的结果当"用户填错了"，不该升级成 500 —— 用户能看见一句中文原因
    比看见"服务器内部错误"有用得多。
    """
    try:
        return urlsplit(url)
    except ValueError:
        from urllib.parse import SplitResult
        return SplitResult("", "", "", "", "")


def normalize_vod(raw: str | None) -> str | None:
    """用户填的录播地址 → 规范外链；空 → None；不合格 → `VodUrlError`（中文原因）。

    接受：裸 BV 号 · `www./m./裸 bilibili.com` 的 `/video/BV…` 链接（含查询参数）。
    拒绝并说明理由：`b23.tv` 短链（展开后才是真地址，且短链主机不在可打开名单里）、
    `http://`（壳只放行 https）、非 B 站主机、链接里没有 BV 号。

    ⚠️ **拒绝比放行重要**：这条路上"宽容一点"的代价是库里存下一批点不开的地址，
    而用户以为存好了。所以每个拒绝分支都给一句**能照着改**的话。
    """
    s = (raw or "").strip()
    if not s:
        return None
    bare = BV_RE.fullmatch(s)
    if bare:
        return VOD_CANONICAL.format(bvid=bare.group(0))
    if "://" not in s:
        raise VodUrlError(
            f"看不懂这个录播地址：{s}（填 BV 号，或 www.bilibili.com/video/BV… 链接）")
    u = _split(s)
    if u.scheme != "https":
        raise VodUrlError(f"只支持 https 链接（收到的是 {u.scheme}:）")
    host = (u.hostname or "").lower()
    if host == "b23.tv":
        raise VodUrlError("b23.tv 是短链，打不开：请在浏览器里打开它，把展开后的地址贴过来")
    if host not in VOD_INPUT_HOSTS:
        raise VodUrlError(
            f"只支持 B 站录播地址（www.bilibili.com/video/BV…），这个主机不支持：{host or s}")
    bv = bvid_of(s)
    if not bv:
        raise VodUrlError("这个链接里没有 BV 号（只认 B 站视频地址，房间号/动态链接都不行）")
    page = (parse_qs(u.query).get("p") or [""])[0]
    suffix = f"?p={page}" if page.isdigit() and int(page) > 0 else ""
    return VOD_CANONICAL.format(bvid=bv) + suffix


def to_utc_naive(dt: datetime, *, local_tz: tzinfo | None = None) -> datetime:
    """用户填的时间 → 库里的 UTC naive（全库时间口径，与 `LiveSessionOut` 的序列化对齐）。

    - **带偏移**的输入（前端 `toISOString()` / `2026-10-08T20:30:00+08:00`）→ 直接换算；
    - **不带偏移**的输入（`<input type="datetime-local">` 的产物 `2026-10-08T20:30`）
      → 按**本机本地时区**解释。⚠️ 这是本函数存在的理由：把它当 UTC 存下来，
      东八区用户填的 20:30 会显示成次日 04:30 —— 一个用户说不清、代码里也看不出的错。

    `local_tz` 只为测试可注入（默认走 `datetime.astimezone()` 的系统本地时区，DST 感知）。
    """
    aware = dt if dt.tzinfo is not None else (
        dt.replace(tzinfo=local_tz) if local_tz is not None else dt.astimezone())
    return aware.astimezone(timezone.utc).replace(tzinfo=None)


def sessions_overlap(a_start: datetime, a_end: datetime | None,
                     b_start: datetime, b_end: datetime | None) -> bool:
    """两个场次时间段是否重叠（**端点相等也算**）；`end=None` = 未结束/未知 → 视为开放区间。

    ⚠️ 端点相等算重叠是**有意的**：用户手填一场 20:00–22:00，而库里已有一条
    22:00 起播的记录，这不是"刚好接上"，是"很可能就是同一场被记了两遍"。
    少报一次冲突的代价（日历上同一天出现两条几乎一样的场次，且都没法自动分辨）
    远大于多问一次。
    """
    a_hi = a_end if a_end is not None else a_start
    if a_end is None or b_end is None:
        # 任一端开放（进行中/未记结束）：只要**不是明确结束在对方开始之前**就算冲突
        if a_end is not None:
            return b_start <= a_end
        if b_end is not None:
            return a_start <= b_end
        return True        # 两边都开放：同一时间一个 V 只可能有一场直播
    return a_start <= b_end and b_start <= a_hi


def is_manual_source(source: str | None) -> bool:
    """`source` 组合串里是否含手动记录（`manual` / `feed+manual` / `manual+self`）。

    合并会把多源拼成 `+` 串（`LiveSessionRepo._join_sources`），所以判据是**分词**而不是等值 ——
    写 `source == "manual"` 会在"用户补的这一场恰好被并进相邻段"时判错，
    而那正是编辑/删除按钮该不该出现的时候。
    """
    return "manual" in (source or "").split("+")
