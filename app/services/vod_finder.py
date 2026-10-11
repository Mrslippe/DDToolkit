# -*- coding: utf-8 -*-
"""找录播：在指定账号的投稿里，为某一场直播找候选回放（C1，需求 2.1，`devlog/464`）。

## 成本（2026-10-11 真机实测）

| 项 | 实测 |
|---|---|
| 一页（`arc/search`，`ps=30`，`order=pubdate`） | **0.17–0.82s**（平均 **0.43s**） |
| 一页盖住多长时间 | 差异极大：投稿密的 V 盖几天，稀的盖**几个月**（实测 30 条跨 1 月→10 月） |
| 风控 | 12 个账号各 1 页、间隔 0.8–1.5s：**无风控**（匿名才必被 412，`capabilities.py` 记过） |
| 命中率 | **3/12** 个 V 在开播后 7 天内有投稿 —— 但其中两条明显不是回放（一条发布在开播前 3 小时、一条是音声） |

⇒ 两条设计结论：

1. **翻页用"时间窗"停**（`order=pubdate` 倒序 ⇒ 一旦最早那条已早于开播前的下界，再翻只会更早）；
   **最多翻 `MAX_PAGES` 页**兜底（防止一个 V 半年没投稿却把页翻穿）；
2. **结果一律是候选**：打分排序 + 给出"为什么是它"，由用户点一下确认（计划原话：
   "不要自动写死，误配比漏配更糟"）。

## 账号来源（计划口径：V 的账号本身 + 用户可指定"录播账号"）

⚠️ 真机现实：这个用户的 12 个 V **自己都不发回放**（投稿普遍 3~5 分钟，是剪辑/翻唱）——
回放在"专门录播号"上。所以本模块支持**一次扫多个 mid**（V 自己的 + 用户指定的录播号），
把两边的候选合在一起按分数排；本地索引里那些「XX录播组」也能作为线索（`suggest_vod_accounts`）。
"""
from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy.orm import Session

from app.domain.vod_match import (AFTER_START_WINDOW, BEFORE_START_TOLERANCE, as_utc,
                                  parse_duration, score_candidate, title_overlap)
from app.models.vtuber import Account
from app.services.fetcher import fetch_bilibili_videos

logger = logging.getLogger(__name__)

#: 最多翻几页（时间窗停页之外的兜底：一个半年没投稿的号不该把页翻穿）
MAX_PAGES = 3
#: 每页条数（B 站 `ps` 上限就是 50；30 是实测覆盖时间的常用档）
PAGE_SIZE = 30
#: 返回给界面几条候选（多了是噪声，用户要的是"点一下"）
MAX_CANDIDATES = 8
#: 时间窗下界：早于这个时间的投稿不必再翻页
_WINDOW_LO = BEFORE_START_TOLERANCE


async def find_candidates(session: dict, mids: list[str], *,
                          max_pages: int = MAX_PAGES) -> list[dict]:
    """在 `mids` 这些账号的投稿里，为 `session` 找候选回放（按分数降序）。

    `session` 用到的键：`start_at` / `end_at` / `live_title`（或 `title`）。
    每个 mid 各自翻页、各自打分，最后合并排序 —— 这样"V 自己"和"录播号"是**平等竞争**的，
    谁像回放谁排前面（而不是先看 V 再看录播号）。

    ⚠️ **时间窗是硬门槛，不参与打分**（2026-10-11 实测校准）：第一版让窗口外的条目也能进来，
    结果榜首是**一个月前**的一条 190 分钟实况（时长分 60 满分）—— 那显然不是"这一场的回放"。
    "这一场的回放"本来就含"时间对得上"，窗口外的东西摆出来只会让人误配。
    窗口内一条都没有 ⇒ 返回空 + 让调用方如实说"可能还没发/在别的录播号上"。
    """
    start = as_utc(session.get("start_at"))
    if start is None:
        return []
    end = as_utc(session.get("end_at"))
    duration = None
    if end and end > start:
        duration = round((end - start).total_seconds() / 60)
    title = session.get("live_title") or session.get("title")

    out: list[dict] = []
    for mid in [str(m) for m in mids if str(m or "").strip()]:
        out.extend(await _scan_mid(mid, start=start, duration=duration, title=title,
                                   max_pages=max_pages))
    in_window = [c for c in out if c["in_window"]]
    # 排序：分数降序，其次"发布得更早的在前"（同一场若被拆成多段，先发的通常是第一段）
    in_window.sort(key=lambda c: (-c["score"], c["published_at"] or start))
    return in_window[:MAX_CANDIDATES]


async def _scan_mid(mid: str, *, start: datetime, duration: int | None,
                    title: str | None, max_pages: int) -> list[dict]:
    """翻一个账号的投稿（时间窗停页），返回它这边的候选。"""
    lo = start - _WINDOW_LO
    collected: list[dict] = []
    for page in range(1, max(1, max_pages) + 1):
        try:
            res = await fetch_bilibili_videos(mid, page=page, page_size=PAGE_SIZE)
        except Exception as e:                                 # noqa: BLE001
            logger.warning("找录播：拉 %s 第 %s 页失败 %s: %s", mid, page, type(e).__name__, e)
            break
        if res is None:
            logger.info("找录播：mid=%s 第 %s 页没取到（风控/未登录/网络）", mid, page)
            break                       # ⚠️ 失败**不伪装成"没有回放"**：前面取到的照样算
        items = res.get("items") or []
        if not items:
            break
        collected.extend(items)
        dates = [as_utc(i.get("published_at")) for i in items if i.get("published_at")]
        if dates and min(dates) < lo:
            break                       # 已越过时间窗（倒序 ⇒ 后面只会更早）
        if len(items) < PAGE_SIZE:
            break                       # 最后一页
    # ⚠️ **只在这里映射一次**：早先的版本在"取数失败"那条分支上 `return collected`
    # —— 那是**原始上游条目**（没有 `in_window` 等键），调用方一取就 KeyError。
    return [_to_candidate(mid, i, start=start, duration=duration, title=title)
            for i in collected]


def _to_candidate(mid: str, item: dict, *, start: datetime, duration: int | None,
                  title: str | None) -> dict:
    body = item.get("body_json")
    video_len = None
    if isinstance(body, str) and body:
        try:
            import json

            video_len = parse_duration((json.loads(body) or {}).get("duration"))
        except Exception:                                      # noqa: BLE001
            video_len = None
    score, plus, minus = score_candidate(
        start_at=start, duration_minutes=duration,
        published_at=item.get("published_at"), video_minutes=video_len,
        session_title=title, video_title=item.get("title"))
    pub = as_utc(item.get("published_at"))
    return {
        "mid": str(mid),
        "bvid": item.get("platform_post_id") or "",
        "title": item.get("title") or "",
        "permalink": item.get("permalink") or "",
        "published_at": item.get("published_at"),
        "duration_minutes": video_len,
        "cover_url": item.get("cover_url") or "",
        "score": score,
        "reasons": plus,
        "cautions": minus,
        "title_hits": title_overlap(title, item.get("title")),
        #: 是否落在"这一场的回放"时间窗内（**硬门槛**：只有它为真才进候选列表）
        "in_window": bool(pub and start - BEFORE_START_TOLERANCE <= pub
                          <= start + AFTER_START_WINDOW),
    }


def default_mids(db: Session, account: Account | None, vtuber) -> list[str]:
    """要扫哪些账号：**V 的 B 站号** + 用户指定的录播号（去重、保序）。

    ⚠️ 顺序有意义（界面上"先扫谁"）：V 自己的号在前，用户指定的录播号在后。
    ⚠️ 非 B 站的场次**照样扫 B 站号** —— 回放大都发在 B 站，哪怕这场直播在别的平台。
    """
    mids: list[str] = []
    if account is not None and account.platform == "bilibili" and account.platform_uid:
        mids.append(str(account.platform_uid))
    elif account is not None and account.vtuber_id:
        row = (db.query(Account)
               .filter(Account.vtuber_id == account.vtuber_id,
                       Account.platform == "bilibili")
               .first())
        if row and row.platform_uid:
            mids.append(str(row.platform_uid))
    extra = getattr(vtuber, "vod_account_uid", None) if vtuber is not None else None
    for m in str(extra or "").replace("，", ",").split(","):
        m = m.strip()
        if m and m not in mids:
            mids.append(m)
    return mids


def window_text(start_at: datetime | None) -> str:
    """给界面看的一句时间窗描述（"找的是哪一段"）。"""
    start = as_utc(start_at)
    if start is None:
        return ""
    lo = start - BEFORE_START_TOLERANCE
    hi = start + AFTER_START_WINDOW
    return f"{lo:%Y-%m-%d %H:%M} ～ {hi:%Y-%m-%d %H:%M}（该场 {start:%Y-%m-%d %H:%M} 开播）"
