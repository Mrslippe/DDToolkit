# -*- coding: utf-8 -*-
"""多录播号扫描 + **优先级兜底**（`docs/plans/vod-autofill.md` B2）。

## 用户口径（2026-10-14）

> 支持同时添加多个账号并设定优先级，高优先级的缺漏由低优先级兜底；
> 有些录播账号可能不是合集/系列/分P，投稿中也可能会混杂一些其他投稿，所以前处理逻辑也要写。

## 三件事

1. **优先级 = `vtubers.vod_account_uid` 的顺序**（逗号分隔，**左 = 高优先**）。
   这不是新列：f015 起就是保序去重的自由字符串，本模块把"顺序有意义"写成契约。
2. **兜底**：一个场次**一旦被高优先号配上就不再参与**后面的号 —— 于是"高优先缺漏"
   自然由低优先补上，且**不会被低优先覆盖**。
3. **前处理**：`app/domain/vod_source.py`（分级 / 排除切片翻唱 / 解析标题时间），
   投稿流与合集走的是同一套 —— 用户担心的"投稿里混着别的东西"在那一层被筛掉。

## 分层

本模块**取数 + 编排**；判定全在 `app/domain/vod_autofill.py`（纯函数，有单测）。
`fetch_items` 可注入 ⇒ 单测不需要网络。
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import httpx

from app.domain import vod_autofill as va
from app.services import vod_source as src

logger = logging.getLogger(__name__)

#: 取数函数签名：`(mid, source) -> [SourceItem 构造参数]`。可注入（单测用）。
FetchItems = Callable[[str, dict], Awaitable[list[dict]]]
#: 来源解析函数签名：`(mid) -> source | None`。同样可注入（**不注入就会打网络**）。
ResolveSource = Callable[[str], Awaitable[dict | None]]


@dataclass
class AccountScan:
    """一个录播号的扫描结果（审查表要按号分组显示）。"""

    mid: str
    ok: bool
    #: 用了哪个来源（`{"kind", "id", "name"}`）；取数失败时可能是空的
    source: dict | None = None
    item_count: int = 0
    #: 这个号**新配上**的场次数（兜底阶段才算）
    matched: int = 0
    error: str | None = None


@dataclass
class ScanResult:
    matches: list[va.Match] = field(default_factory=list)
    unmatched: list[dict] = field(default_factory=list)
    accounts: list[AccountScan] = field(default_factory=list)
    #: 一共扫了多少条候选（过完前处理之后）
    items_total: int = 0


def ordered_mids(primary_mid: str | None, vod_account_uids: str | None) -> list[str]:
    """要扫的 mid 列表，**按优先级**：用户指定的录播号在前（左 = 高优先），V 自己的号兜底在最后。

    为什么要带 V 自己的号：有的 V **就是自己发回放**（实测 3/12 有投稿在窗口内），
    把它放最后 = "录播号都没有时再试它"，正是兜底语义。
    ⚠️ 去重但保序（`dict.fromkeys`）—— 重复扫同一个号纯属浪费，而顺序是语义。
    """
    mids: list[str] = []
    for m in str(vod_account_uids or "").replace("，", ",").split(","):
        m = m.strip()
        if m:
            mids.append(m)
    own = str(primary_mid or "").strip()
    if own:
        mids.append(own)
    return list(dict.fromkeys(mids))


async def resolve_source(mid: str, *, client: httpx.AsyncClient | None = None,
                         want: dict | None = None) -> dict | None:
    """定这个号扫哪个来源：`want` 显式给了就用它，否则 `list_sources` + `pick_source` 自动挑。

    ⚠️ **显式给来源时也要把名字补上**（2026-10-15 真机验收抓到的）：调用方传来的
    `want` 通常只有 `{"kind","id"}`（前端选完来源就回传这两个），而审查表上"来自「XX」"
    那一栏靠 `name` —— 不补就是一片空白，用户看不出这条录播是哪个系列来的。
    补法：列一次来源清单找回名字；**取不到名字不算失败**（来源本身是有效的）。
    """
    if want and want.get("kind"):
        if want.get("name"):
            return want
        try:
            sources = await src.list_sources(mid, client=client)
        except Exception as e:                                   # noqa: BLE001
            logger.info("录播来源补名失败 mid=%s: %s: %s", mid, type(e).__name__, e)
            return want
        hit = next((s for s in sources
                    if s["kind"] == want["kind"] and str(s["id"]) == str(want.get("id"))), None)
        return {**want, "name": (hit or {}).get("name") or _kind_label(want["kind"])}
    sources = await src.list_sources(mid, client=client)
    cands = [s for s in sources if s["kind"] != "uploads" and (s.get("total") or 0) > 0]
    picked = src.pick_source(cands)
    if picked:
        return picked
    # ⚠️ **没有合集/系列时退回投稿流**（2026-10-15 用户实测报回来的 bug）：
    #    `94009831` 的清单接口 HTTP 200 / `code=0`，但 seasons 与 series **两个列表都是空的**
    #    —— 那个号的录播**全在投稿里**（实测 1093 条，标题都是「【明前奶绿录播】…」）。
    #    此前这里只挑系列/合集 ⇒ `pick_source([])` = None ⇒ 整个号被报成
    #    「没找到可扫的来源（合集/系列为空，投稿也没取到）」，而**投稿那条路根本没试过**。
    #    投稿本来就是三条路之一（`default_fetch_items` 早就分派好了），这里只是把它接上。
    return next((s for s in sources if s["kind"] == "uploads"), None)


def _kind_label(kind: str) -> str:
    """来源类型的中文名（补不上名字时的兜底：**不显示空串**）。"""
    return {"series": "系列", "season": "合集", "uploads": "投稿"}.get(kind, kind)


async def default_fetch_items(mid: str, source: dict) -> list[dict]:
    """默认取数：按来源类型分派（系列 / 合集 / 投稿）。

    ⚠️ `source["stop_before"]`（可选）是**取数用的下界**，不是来源的属性 ——
    由 `scan()` 按"最早的一场直播"算好塞进来，投稿流靠它决定**翻到第几页就停**
    （2026-10-15 用户口径：最后一条投稿早于最早的一场直播，就不翻了）。
    只喂给投稿流：系列/合集是上传者自己归档的、接口也不保证按发布倒序，
    早停会丢东西 —— 而那条路本来只有 5 页。
    """
    kind = source.get("kind")
    if kind == "series":
        return await src.fetch_series_archives(mid, str(source["id"]),
                                               source_name=source.get("name") or "系列")
    if kind == "season":
        return await src.fetch_season_archives(mid, str(source["id"]),
                                               source_name=source.get("name") or "合集")
    return await src.fetch_uploads(mid, stop_before=source.get("stop_before"))


async def scan(rows: list[dict], mids: list[str], *,
               fetch_items: FetchItems | None = None,
               resolve: ResolveSource | None = None,
               tolerance_minutes: int = va.DEFAULT_TOLERANCE_MINUTES) -> ScanResult:
    """按优先级扫多个录播号，逐号与**尚未配上**的场次配对。

    ⚠️ **配对池逐号收窄**：第 i 个号只看"前 i-1 个号没配上的场次" ——
    这就是兜底的本体（高优先占位，低优先只补缺），也让"低优先覆盖高优先"不可能发生。
    ⚠️ **配对放线程里跑**（2026-10-15，用户实测报"扫描时前端也被阻塞"）：
    `match_sessions` 是纯 CPU，满池（942 场 × 927 条候选）实测 **0.7s**（性能修复前 **69s**）。
    直接在事件循环里跑，那段时间**整个后端一个请求都答不了** —— 前端看起来"卡死"。
    它与数据库无关（只吃 `rows`/`items` 两个纯数据），所以丢给线程是安全的。
    ⚠️ `resolve` 必须可注入：不注入就会真的打上游（单测里表现为超时，看起来像"代码坏了"）。
    ⚠️ **已有 `vod_url` 的场次不进池子**（保护用户手填，不变量 39）。
    曾经这里有个 `include_matched` 开关给"清空"用（那时清空要先重扫一遍）——
    f018 之后清空改成纯数据库操作、一个上游请求都不发 ⇒ 那个开关**没有调用方了，已删**。
    """
    fetch = fetch_items or default_fetch_items
    resolve_fn: ResolveSource = resolve or resolve_source
    result = ScanResult()
    remaining = [r for r in rows
                 if r.get("live_id") and r.get("start_at") and not r.get("vod_url")]
    # ★ 「最早的一场直播」—— 取数时的下界（2026-10-15 用户口径：投稿翻到比它更旧就停）。
    #   算的是**库里的全部场次**（不只还没配上的那些）：翻页判据不该随匹配进度变化。
    #   边距见 `src.PAGE_STOP_MARGIN`（场次记录与真实开播本来就有偏差）。
    earliest = min((r["start_at"] for r in rows if r.get("start_at")), default=None)
    stop_before = (earliest - src.PAGE_STOP_MARGIN) if earliest else None
    taken: list[va.Match] = []

    for mid in mids:
        record = AccountScan(mid=mid, ok=False)
        try:
            source = await resolve_fn(mid)
        except Exception as e:                                   # noqa: BLE001
            record.error = f"{type(e).__name__}: {e}"
            result.accounts.append(record)
            continue
        record.source = source
        if not source:
            record.error = "没找到可扫的来源（合集/系列为空，投稿也没取到）"
            result.accounts.append(record)
            continue
        try:
            # ⚠️ 下界**只进这次调用的副本**：`record.source` 要原样反映"用的是哪个来源"，
            #    把取数参数混进去会让审查表上那一栏多出一个用户看不懂的键。
            raw = await fetch(mid, {**source, "stop_before": stop_before})
        except Exception as e:                                   # noqa: BLE001
            record.error = f"{type(e).__name__}: {e}"
            result.accounts.append(record)
            continue

        items = [va.SourceItem(**it) for it in raw]
        record.item_count = len(items)
        record.ok = True
        result.items_total += len(items)

        matched = await asyncio.to_thread(
            va.match_sessions, remaining, items, tolerance_minutes=tolerance_minutes)
        for m in matched:
            m.candidate.mid = mid
            if m.candidate.source_name in ("系列", "合集") and source.get("name"):
                m.candidate.source_name = str(source["name"])
        record.matched = len(matched)
        taken.extend(matched)
        hit = {m.live_id for m in matched}
        remaining = [r for r in remaining if str(r["live_id"]) not in hit]
        result.accounts.append(record)
        logger.info("录播扫描 mid=%s 来源=%s 候选=%s 新配=%s 剩余场次=%s",
                    mid, (source or {}).get("name"), len(items), len(matched), len(remaining))

    result.matches = sorted(taken, key=lambda m: (m.confidence, m.start_at))
    result.unmatched = sorted(remaining, key=lambda r: r["start_at"], reverse=True)
    return result
