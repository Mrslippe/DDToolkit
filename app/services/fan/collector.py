"""数据分析工作台 · 采集器（2026-10-18）。

按 **(主播, 时间区间)** 抓取全量弹幕事实表，落到数据根的 `stats/` 与 `raw/`。

## 为什么是一次性的 v2 拉取

`GET /api/v2/live?liveId=&pageSize=100000` **一次请求拿全一场**（实测 41k~80k 条 /
2~18 秒）。v3 的分页帧要 2~5 次且慢得多。这条是 `_probe/fan_pilot_v3.py` 验证过的口径。

## 为什么必须独立于主抓取链路

主 fetcher 抓的是帖子/直播场次（KB 级、分钟级节奏）。这里每场要 7 MB、连续几十场 ——
混进主循环会拖慢主功能，还会撞上 `ARCHITECTURE.md §6` 的并发不变量（两把锁与让位）。
⇒ 本模块是**用户显式触发、独立并发上限、可取消**的任务。

## 落盘契约（必须与 `loader` 的读取一致）

`stats/<live_id>.json` 里的 `type_hist["0"]` 与 `sum_price` 是 `checks.C1` 内部恒等式的
两端 —— 写错会让每一场都被判 `dropped`。本模块**从原始记录现算**这两个量，不取上游汇总。
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import re
import json
import logging
import os
import time
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx

from app.core.useragent import UA_CHROME

from app.core.timecn import cn_day
from app.services.externals.vtbcat import fetch_lives, match_session
from app.services.fan.acv import acv_from_online_rank
from app.services.fan.duration import apply_rate_end
from app.services.fan.quality import apply_replay_cut
from app.services.fan.sysmsg import apply_sys_end
from app.services.fan.quality_gate import evaluate as quality_evaluate
from app.services.fan.loader import MIN_RECORDS, VtuberRef, ensure_data_dir

logger = logging.getLogger(__name__)

# ── 具名常量 ────────────────────────────────────────────────────────────────
DANMAKUS_BASE = "https://ukamnads.icu"
#: 一次拿全一场；这是实测出来的值（见模块 docstring）
#: 单页大小。**必须小**：实测上游有两类坑 ——
#: ① 超大 pageSize（100000）会静默截断并谎报 `hasMore=false`；
#: ② 更大的 pageSize 配上 `pageNum` 时，**部分场次直接返回 0 条 / total=0**
#:    （同一场：无 pageNum + 50000 → 12,974 条；带 pageNum + 50000 → 0 条）。
#: 5000 在大场（155k）与小场（13k）上都能正常翻页。
COLLECT_PAGE_SIZE = 5_000
#: 首次（不带 pageNum）用的大页，够小场次一次取完
COLLECT_PAGE_SIZE_BIG = 100_000
#: 单场最多翻多少页（防上游异常时死循环；50k × 20 = 100 万条，远超任何真实场次）
#: 单场最多翻多少页。5000/页 × 60 = 30 万条 —— 实测最长的一场 131,583 条需要 27 页，
#: 原来的 20 页正好卡在 100,000，会被误判成「已取全」。
COLLECT_MAX_PAGES = 60
#: 单页返回空但 total>0 时最多重试几次（并发限流导致，重试通常就出来了）
FETCH_EMPTY_ATTEMPTS = 3
#: 并发上限。**不要调大** —— 上游对突发请求敏感，实测 3 路稳定
COLLECT_CONCURRENCY = 3
#: 单场超时。实测最慢 18 秒，给 120 秒余量
COLLECT_TIMEOUT_S = 120.0
#: 单场重试次数（含首次）
COLLECT_ATTEMPTS = 3
#: 相邻请求之间的最小间隔（秒），避免把上游打满
COLLECT_GAP_S = 0.2
#: **枚举场次**用的预算（秒 / 次数）。与单场采集分开：枚举只是问"有哪些场"，
#: 上游挂掉时要**快速失败**（实测它会 502 并把 3 次重试拖成 38 秒，用户以为界面卡死）。
ENUM_TIMEOUT_S = 15.0
ENUM_ATTEMPTS = 2

#: ⚠️ UA **必须**取自 `core/useragent.py` —— `tests/test_user_agent.py` 有护栏：
#: `app/` 下只有那一个文件能出现 UA 字面量（抄一份的症状是各请求伪装成不同浏览器）。
HEADERS = {"User-Agent": UA_CHROME,
           "Origin": "https://ukamnads.icu",
           "Referer": "https://ukamnads.icu/"}

#: 记录类型
T_DANMAKU, T_GIFT, T_GUARD, T_SC, T_ENTER = 0, 1, 2, 3, 4
Guard_rank = {"舰长": 1, "提督": 2, "总督": 3}

STATE_RUNNING = "running"
STATE_DONE = "done"
STATE_FAILED = "failed"
STATE_CANCELLED = "cancelled"


@dataclass
class SessionPlan:
    """待采的一场。

    `stop_at` 来自上游的 `stopDate`（平台记录的下播时间）。有它就用它算时长 ——
    比"从事件时间戳推"可靠（实测中位差 6 分钟，但尾部能差 8 小时）。
    """

    live_id: str
    start_at: str
    stop_at: str | None = None
    #: 平台自己报的弹幕总量与收入（质量闸 L2 用；缺省 0 = 平台没给）
    danmakus_count: int = 0
    income: float = 0.0


@dataclass
class CollectProgress:
    """一次采集任务的进度。**前端只读这个结构。**"""

    vtuber: str
    since: str
    until: str
    state: str = "idle"
    total: int = 0
    done: int = 0
    failed: int = 0
    skipped: int = 0          # 已存在且跳过
    #: 逐场失败明细（2026-10-19）：`[{live_id, start_at, reason}]`。
    #: 之前只有 `failed` 一个计数，拿不到“哪几场没采到、为什么”—— 采集弹窗要用它。
    failures: list[dict[str, Any]] = field(default_factory=list)
    current: str = ""
    message: str = ""
    #: 当前场次的阶段：enumerate / fetch / aggregate / write / verify（2026-10-27）
    phase: str = ""
    #: 当前翻页进度（仅 fetch 阶段有意义）
    page: int = 0
    pages: int = 0
    #: 本次任务累计拉到的记录数与耗时（用于算吞吐 / ETA）
    records: int = 0
    #: 逐场状态：`[{live_id, start_at, state, records, reason}]`（前端列表用它）
    sessions_detail: list[dict[str, Any]] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    @property
    def throughput(self) -> dict[str, float]:
        """记录/秒与场次/秒（前端显示“正在以多快速度拉”）。"""
        sec = max(1e-6, self.elapsed)
        return {"records_per_s": round(self.records / sec, 1),
                "sessions_per_min": round((self.done + self.failed + self.skipped) / sec * 60, 2)}

    @property
    def eta_s(self) -> float | None:
        """按“已处理场次的平均耗时”估剩余秒数；样本不足 1 场时返回 None。"""
        fin = self.done + self.failed + self.skipped
        if fin <= 0:
            return None
        left = max(0, self.total - fin)
        return round(self.elapsed / fin * left, 1)

    @property
    def elapsed(self) -> float:
        return (self.finished_at or time.time()) - self.started_at

    def as_dict(self) -> dict[str, Any]:
        return {
            "vtuber": self.vtuber,
            "since": self.since,
            "until": self.until,
            "state": self.state,
            "total": self.total,
            "done": self.done,
            "failed": self.failed,
            "skipped": self.skipped,
            "failures": self.failures,
            "current": self.current,
            "message": self.message,
            "elapsed": round(self.elapsed, 1),
        }


def _mark(p: CollectProgress, live_id: str, state: str, records: int, reason: str) -> None:
    """更新逐场状态（同一个 live_id 只保留一条）。"""
    for item in p.sessions_detail:
        if item.get("live_id") == live_id:
            item.update({"state": state, "records": records, "reason": reason})
            return
    p.sessions_detail.append({"live_id": live_id, "start_at": "", "state": state,
                              "records": records, "reason": reason})

class CollectError(Exception):
    """采集失败（可展示给用户）。"""


# ── 上游 ────────────────────────────────────────────────────────────────────
#: 退避基数（秒）
RETRY_BASE_S = 0.8
#: 单次重试的最长等待
RETRY_MAX_S = 20.0


def _retry_delay(attempt: int, *, base: float = RETRY_BASE_S,
                 cap: float = RETRY_MAX_S, jitter: float = 0.3) -> float:
    """第 `attempt` 次重试前等待多久：指数退避 + ±`jitter` 随机抖动。

    抖动是为了**打散并发任务的重试时刻** —— 上游 504 抖动时，3 个并发任务
    如果同时退避、同时重试，会把压力重新叠在同一瞬间。
    """
    import random
    d = min(cap, base * (2 ** max(0, attempt - 1)))
    return d * (1 + random.uniform(-jitter, jitter))


def adaptive_timeout_s(total_records: int, *, base: float = COLLECT_TIMEOUT_S,
                       per_1k: float = 3.0, cap: float = 600.0) -> float:
    """按"这场的记录数"估一个请求超时。

    实测 15 万条的场次用固定 120s 很容易被腰斩；线性给到 `total/1000 × 3s`，
    下限 `base`、上限 `cap`。
    """
    if total_records <= 0:
        return base
    return float(min(cap, max(base, total_records / 1000.0 * per_1k)))

async def _get_json(client: httpx.AsyncClient, path: str,
                    params: list[tuple[str, Any]], *,
                    attempts: int = COLLECT_ATTEMPTS,
                    timeout_s: float | None = None) -> dict | None:
    """带重试的 GET。返回解析后的 JSON，失败返回 None。"""
    last: str = ""
    for i in range(max(1, attempts)):
        if i:
            # 指数退避 + ±30% 抖动：避免多个并发任务在同一时刻齐步重试（504 风暴）
            await asyncio.sleep(_retry_delay(i))
        try:
            kwargs = {"timeout": timeout_s} if timeout_s else {}
            r = await client.get(f"{DANMAKUS_BASE}{path}", params=params,
                                 headers=HEADERS, **kwargs)
            if r.status_code != 200:
                last = f"HTTP {r.status_code}"
                # 4xx 里只有 408/429 值得重试；其余（404/403）重试也是白等
                if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
                    break
                continue
            if r.content[:1] != b"{":
                last = "响应不是 JSON"
                continue
            return r.json()
        except (httpx.HTTPError, json.JSONDecodeError, ValueError) as exc:
            last = f"{type(exc).__name__}: {exc}"
        await asyncio.sleep(COLLECT_GAP_S)
    logger.warning("danmakus %s 取数失败（%s）", path, last)
    return None


async def fetch_records(client: httpx.AsyncClient, live_id: str, *,
                         with_extra: bool = False) -> list[dict] | tuple[list[dict], dict] | None:
    """取一场的**全部**记录。

    返回 `None` 表示上游没给数据；否则返回列表。

    上游有三类坑（2026-10-20 实测）：

    1. 超大 `pageSize` 会截断并谎报 `hasMore=false`（100000 → 55,264 条，实际 155,264）；
    2. 部分场次**带上 `pageNum` 就返回 0 条 / total=0**，不带则正常；
    3. 并发时偶尔返回空页。

    对策：**先不带 `pageNum` 取一页**（pageSize=100000）。拿到的条数若已等于 `total`，就是全量；
    否则再按 5000 一页翻页补齐；翻页若在首页就返回空，则退回第一步那份（尽力而为）。
    """
    # ① 不带 pageNum 的一次性请求
    _params = [("liveId", live_id), ("pageSize", COLLECT_PAGE_SIZE_BIG)]
    if with_extra:
        # `includeExtra=true` 会带上 `live.extra.onlineRank`（逐秒同接时间线）
        _params.append(("includeExtra", "true"))
    j = await _get_json(client, "/api/v2/live", _params)
    if not j:
        return None
    inner = j.get("data") or {}
    env = inner
    first = ((env.get("data") or {}).get("danmakus")) or []
    total = int(env.get("total") or 0)
    extra = (((env.get("data") or {}).get("live") or {}).get("extra")) or {}
    # ⚠️ 不能只看 total：服务端把 total 也谎报成 100000 时（正好等于大页上限），
    # 会让我们误判「已取全」。命中页上限就强制翻页。
    if len(first) >= total and len(first) < COLLECT_PAGE_SIZE_BIG:
        return (first, extra) if with_extra else first   # 一次就够（小场次走这里）

    # ② 需要翻页（大场次）
    out: list[dict] = []
    for page in range(1, COLLECT_MAX_PAGES + 1):
        recs: list[dict] = []
        has_more = False
        # 大场次给更长的超时：15 万条用固定 120s 会被腰斩（2026-10-27）
        _timeout = adaptive_timeout_s(max(total, len(first)))
        for attempt in range(FETCH_EMPTY_ATTEMPTS):
            jj = await _get_json(client, "/api/v2/live",
                                 [("liveId", live_id), ("pageSize", COLLECT_PAGE_SIZE),
                                  ("pageNum", page)],
                                 timeout_s=_timeout)
            if not jj:
                break
            e = jj.get("data") or {}
            recs = ((e.get("data") or {}).get("danmakus")) or []
            has_more = bool(e.get("hasMore"))
            if recs:
                break
            await asyncio.sleep(1.2 * (attempt + 1))
        if page == 1 and not recs:
            return (first, extra) if with_extra else first   # 不认 pageNum，退回一次性结果
        out.extend(recs)
        if not recs or not has_more:
            break
    result = out if len(out) >= len(first) else first
    return (result, extra) if with_extra else result


async def list_sessions(client: httpx.AsyncClient, v: VtuberRef) -> list[SessionPlan]:
    """列出该主播的场次（用 `channel` 端点，公开免鉴权）。"""
    j = await _get_json(client, "/api/v2/channel",
                        [("uId", v.mid), ("includeLive", "true")],
                        attempts=ENUM_ATTEMPTS, timeout_s=ENUM_TIMEOUT_S)
    if not j:
        raise CollectError(f"取不到 {v.name} 的场次列表（上游无响应或返回异常）")
    data = (j.get("data") or {})
    lives = data.get("lives") or []
    out: list[SessionPlan] = []
    for x in lives:
        lid = x.get("liveId")
        if not lid:
            continue
        # `startDate` 是毫秒时间戳（实测）；缺了就跳过 —— 没有日期无法按区间筛
        ms = x.get("startDate") or x.get("start_date")
        if not isinstance(ms, (int, float)):
            continue
        # ⚠️ 必须是 UTC（同 569 的坑）：这里用本地时间会让"按日期筛场次"在东八区差一天
        # `stopDate` 是下播时间（毫秒），0 表示未结束；缺失时保持 None，由调用方回退
        stop = x.get("stopDate") or x.get("stop_date")
        stop_iso = None
        if isinstance(stop, (int, float)) and stop > 0:
            stop_iso = _utc_iso(int(stop))[:19]
        out.append(SessionPlan(
            str(lid), _utc_iso(ms)[:19], stop_iso,
            danmakus_count=int(x.get("danmakusCount") or 0),
            income=float(x.get("totalIncome") or 0.0),
        ))
    out.sort(key=lambda s: s.start_at)
    return out


def plan_range(sessions: list[SessionPlan], since: str, until: str) -> list[SessionPlan]:
    """按闭区间筛场次（比较 `start_at` 的日期部分）。"""
    return [s for s in sessions if since <= s.start_at[:10] <= until]


# ── 聚合（落盘契约在此）────────────────────────────────────────────────────
#: 相邻事件间隔超过它，就怀疑"混入了别场/离群记录"（3 小时）
GAP_CUT_MS = 3 * 3600 * 1000


def _utc_iso(ms: int) -> str:
    """毫秒时间戳 → **UTC** 的 `YYYY-MM-DD HH:MM:SS.ffffff`（不带时区后缀，与库内一致）。"""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")
#: 被切掉的一侧最多占全部事件的这个比例 —— 超过就认为"真的播了那么久"，不切
TRIM_MAX_SHARE = 0.05


def _trim_span(ts: list[int]) -> tuple[int, int, int]:
    """把"离群时间戳"从场次跨度里裁掉，返回 `(start_ms, end_ms, dropped)`。

    背景（2026-10-20）：`start_at` / `end_at` 原本取所有事件时间戳的 min / max。
    个别散落记录（例如开播 4 天后的 2 条弹幕）会把跨度拉到几昼夜，
    于是"场次时长"彻底失真 —— 实测 77 场里有 6 场被拉长超过 20%。

    规则（保守，宁可少切）：
    1. 找**最大**的相邻间隔；不超过 `GAP_CUT_MS` 就停；
    2. 只切掉**少数一侧**，且该侧占比必须 < `TRIM_MAX_SHARE`；
    3. 重复，直到没有可切的间隔。

    这样"真的有中场休息、两侧都很多"的场次不会被切。
    """
    if not ts:
        return 0, 0, 0
    arr = sorted(ts)
    dropped = 0
    while len(arr) > 2:
        gi, gg = 1, arr[1] - arr[0]
        for i in range(2, len(arr)):
            gap = arr[i] - arr[i - 1]
            if gap > gg:
                gi, gg = i, gap
        if gg <= GAP_CUT_MS:
            break
        left, right = gi, len(arr) - gi
        if min(left, right) > len(arr) * TRIM_MAX_SHARE:
            break
        if left <= right:
            dropped += left
            arr = arr[gi:]
        else:
            dropped += right
            arr = arr[:gi]
    return arr[0], arr[-1], dropped


#: 文本归一化：去首尾空白、内部空白压成一个空格、全角空格按空白处理。
#: 只做**无损**归并（不投票拆词、不做同义归并）—— 近义改写仍会逃逸，这是已知限制。
_WS = re.compile(r"\s+")


def _norm_text(raw: object) -> str:
    """把一条弹幕文本压成用于**精确去重**的键。空文本返回空串（不计入）。"""
    if not isinstance(raw, str):
        return ""
    return _WS.sub(" ", raw.replace("\u3000", " ")).strip()


def _hash_text(txt: str) -> int:
    """归一化文本 → **稳定的 64 位哈希**（blake2b，8 字节）。

    为什么必须用 blake2b 而不是内置 `hash()`：后者受 `PYTHONHASHSEED` 影响，
    **每个进程都不一样**，跨次采集无法比对。blake2b 是确定性的、无依赖。

    哈希的是**归一化后**的文本（空白已压平），因此既支持精确重复统计，也保住了
    大小写、标点与 emoji 的区分 —— 将来换更复杂的去重规则时，仍可在哈希序列上重算。
    空文本返回 0（作为占位，保证 `mh` 与 `mt` 一一对齐；真实哈希不可能为 0）。
    """
    if not txt:
        return 0
    return int.from_bytes(hashlib.blake2b(txt.encode("utf-8"), digest_size=8).digest(), "big")


#: 破坏性行为判定的版本号：判据一变就 +1，旧 stats 里的 bp 可以据此判断是否过期
BP_VERSION = 1
#: 判定"复制他人弹幕"的时间窗（毫秒）
BP_WINDOW_MS = 5_000


def _behaviour_profile(records: list[dict], *, top: int = 20) -> dict[str, Any]:
    """采集时预计算**破坏性弹幕行为**画像（2026-10-27）。

    现在只做**精确复制**（同一文本哈希在 ±`BP_WINDOW_MS` 内被别人也发过），
    因为这是我们手上数据能可靠支撑的部分；模糊变体留给 `msh` 的 simhash 事后处理。

    产出（都进 `stats["bp"]`，体积约 2–5 KB/场）：
    - `copy_msgs` / `copy_ratio`：被判为"跟着别人发"的条数与占比；
    - `users`：受影响用户数；
    - `top`：前 N 名 `{uid, copied, msgs, ratio, targets, lag_med}`；
    - `lag_med`：源消息 → 复制消息的延迟中位数（毫秒），脚本通常很稳定；
    - `interval_cv`：该用户发车间隔的变异系数（越小越"规律"）。
    """
    ev: list[tuple[int, str, int]] = []
    for rec in records:
        if str(rec.get("type")) != "0":
            continue
        uid = rec.get("uId")
        ms = rec.get("ts") or rec.get("timestamp")
        if not isinstance(uid, int) or not isinstance(ms, (int, float)):
            continue
        txt = _norm_text(rec.get("message"))
        if not txt:
            continue
        ev.append((int(ms), str(uid), _hash_text(txt)))
    if not ev:
        return {"version": BP_VERSION, "copy_msgs": 0, "copy_ratio": 0.0,
                "users": 0, "top": []}
    ev.sort()

    by_hash: dict[int, list[tuple[int, str]]] = {}
    for ts, uid, h in ev:
        by_hash.setdefault(h, []).append((ts, uid))

    copied: dict[str, int] = {}
    total: dict[str, int] = {}
    targets: dict[str, set[str]] = {}
    lags: dict[str, list[int]] = {}
    stamps: dict[str, list[int]] = {}
    for ts, uid, _h in ev:
        total[uid] = total.get(uid, 0) + 1
        stamps.setdefault(uid, []).append(ts)

    for lst in by_hash.values():
        if len(lst) < 2:
            continue
        n = len(lst)
        for i, (ts, uid) in enumerate(lst):
            # 只看窗口内的邻居（列表已按时间排序，双向扫到超窗即停）
            j = i - 1
            while j >= 0 and ts - lst[j][0] <= BP_WINDOW_MS:
                pu, pts = lst[j][1], lst[j][0]
                if pu != uid:
                    copied[uid] = copied.get(uid, 0) + 1
                    targets.setdefault(uid, set()).add(pu)
                    lags.setdefault(uid, []).append(ts - pts)
                    break
                j -= 1
            else:
                k = i + 1
                while k < n and lst[k][0] - ts <= BP_WINDOW_MS:
                    nu, nts = lst[k][1], lst[k][0]
                    if nu != uid:
                        copied[uid] = copied.get(uid, 0) + 1
                        targets.setdefault(uid, set()).add(nu)
                        lags.setdefault(uid, []).append(nts - ts)
                        break
                    k += 1

    def _cv(xs: list[int]) -> float:
        if len(xs) < 3:
            return 0.0
        diffs = [b - a for a, b in zip(xs, xs[1:]) if b > a]
        if not diffs:
            return 0.0
        mean = sum(diffs) / len(diffs)
        if mean <= 0:
            return 0.0
        var = sum((d - mean) ** 2 for d in diffs) / len(diffs)
        return round((var ** 0.5) / mean, 3)

    ranked = sorted(copied.items(), key=lambda kv: -kv[1])[:top]
    tops = []
    for uid, c in ranked:
        ms = total.get(uid, 0) or 1
        lg = sorted(lags.get(uid) or [])
        tops.append({
            "uid": uid,
            "copied": c,
            "msgs": ms,
            "ratio": round(c / ms, 3),
            "targets": len(targets.get(uid) or ()),
            "lag_med": lg[len(lg) // 2] if lg else None,
            "interval_cv": _cv(stamps.get(uid) or []),
        })
    copy_msgs = sum(copied.values())
    return {
        "version": BP_VERSION,
        "window_ms": BP_WINDOW_MS,
        "copy_msgs": copy_msgs,
        "copy_ratio": round(copy_msgs / max(1, len(ev)), 4),
        "users": len(copied),
        "top": tops,
    }

def _simhash64(txt: str) -> int:
    """文本 → 64 位 **simhash**（字符 3-gram 的加权位投票）。

    `mh` 只能判"完全相等"；「自动融入」这类脚本常做变体（加 emoji、空格、改写），
    那样 `mh` 判不出来。simhash 的**汉明距离**近似"文本相似度"，可用于事后做模糊匹配。

    - 用 `zlib.crc32`（C 实现、跨进程稳定）给 3-gram 打散，再拼成 64 位；
    - 空文本返回 0（与 `mh` 对齐，真实值不可能为 0）；
    - 每条消息 8 字节，压缩后代价约 +10%。
    """
    if not txt:
        return 0
    if len(txt) < 3:
        grams = [txt]
    else:
        grams = {txt[i:i + 3] for i in range(len(txt) - 2)}
    votes = [0] * 64
    for g in grams:
        b = g.encode("utf-8")
        h = (zlib.crc32(b) << 32) | zlib.crc32(b, 0x9E3779B1)
        for i in range(64):
            votes[i] += 1 if (h >> i) & 1 else -1
    out = 0
    for i in range(64):
        if votes[i] > 0:
            out |= (1 << i)
    return out

def aggregate(records: list[dict], *,
              span_ms: tuple[int, int] | None = None) -> tuple[dict[str, dict], dict[str, Any]]:
    """把一场的原始记录压成 `(raw, stats)`。

    **raw 的每个字段都由这里现算** —— 尤其 `sum_price`，它是 C1 恒等式的左端。
    """
    raw: dict[str, dict] = {}
    type_hist: dict[str, int] = {}
    sum_price = 0.0
    ts: list[int] = []
    #: 只收**弹幕**时间戳，用于算场次跨度。理由见下方 start_iso 处的注释。
    ts_chat: list[int] = []
    #: uid -> {归一化文本: 出现次数}；只在本函数内存在，**不落盘**
    _texts: dict[str, dict[str, int]] = {}

    #: 系统消息（uId <= 0）：只留 type + 时间戳，用于判定下播时刻（最多 200 条）
    sys_events: list[dict] = []
    # ── 有效窗口（2026-10-26）────────────────────────────────────────────
    # `live_id` 会被多场直播复用、平台 `start_at` 也可能早于真实开播。
    # 以后采集时**先算窗口再过滤记录**：优先 sys 的"直播开始/结束"，其次平台跨度，
    # 最后才回退到事件跨度。这样 raw/stats 天生就只含这一场的内容。
    sys_start = sys_end = None
    for rec in records:
        if str(rec.get("type")) in ("11", "12"):
            _ts = rec.get("ts") or rec.get("timestamp")
            if isinstance(_ts, (int, float)):
                if str(rec.get("type")) == "11":
                    sys_start = _ts if sys_start is None else min(sys_start, _ts)
                else:
                    sys_end = _ts if sys_end is None else max(sys_end, _ts)
    if sys_start and sys_end:
        eff_lo, eff_hi = sys_start, sys_end
    elif span_ms:
        eff_lo, eff_hi = span_ms[0], span_ms[1]
    else:
        eff_lo, eff_hi = None, None
    if eff_lo is not None and eff_hi is not None and eff_hi > eff_lo:
        pad = 60_000
        kept = [r for r in records
                if isinstance(r.get("ts"), (int, float))
                and eff_lo - pad <= r["ts"] <= eff_hi + pad]
        if kept:
            records = kept

    for rec in records:
        t = rec.get("type")
        type_hist[str(t)] = type_hist.get(str(t), 0) + 1
        uid = rec.get("uId")
        if not isinstance(uid, int) or uid <= 0:
            if len(sys_events) < 200:
                ms0 = rec.get("sendDate")
                if isinstance(ms0, (int, float)):
                    sys_events.append({"type": t, "ts": int(ms0)})
        ms = rec.get("sendDate")
        if isinstance(ms, (int, float)):
            ts.append(int(ms))
        uid = rec.get("uId")
        if not isinstance(uid, int) or uid <= 0:
            continue        # 系统消息（uId = -1 / 0）不建人
        u = raw.get(str(uid))
        if u is None:
            u = raw[str(uid)] = {"m": 0, "mt": [], "mh": [], "e": 0, "et": [],
                                 "p": 0.0, "pe": 0, "pt": [],
                                 "g": 0.0, "gd": 0.0, "sc": 0.0,
                                 "sc_cnt": 0, "gift_cnt": 0, "guard_cnt": 0,
                                 "guard_top": None,
                                #: 昵称（2026-10-24）：取该用户第一条非空 `uName`。
                                #: 只存展示用，不参与任何计算。
                                "n": "",
                                 # ── 文本指纹（2026-10-20）：只存**派生数字**，原文不落盘。
                                 # `m` 仍是原始条数，**永不删除**（下游按需选用）。
                                 # `uniq` = 去重后的不同文本条数；`maxrep` = 单条文本的
                                 # 最大重复次数。判定（是否独轮车）**不在这里做**，
                                 # 见 `spam.py` 的版本化入口。
                                 "uniq": 0, "maxrep": 0}
        if not u.get("n"):
            _nm = rec.get("uName")
            if isinstance(_nm, str) and _nm.strip():
                u["n"] = _nm.strip()[:40]
        if t == T_DANMAKU:
            u["m"] += 1
            if isinstance(ms, (int, float)):
                u["mt"].append(int(ms))
                ts_chat.append(int(ms))
            # 文本指纹：归一化后计入该用户的计数器，收尾时折算成 uniq / maxrep；
            # 同时把 64 位哈希写进 `mh`，与 `mt` 一一对齐 —— 将来换了去重规则，
            # 可以在哈希序列上离线重算，**不必重新采集**。
            txt = _norm_text(rec.get("message"))
            u["mh"].append(_hash_text(txt))
            u.setdefault("msh", []).append(_simhash64(txt))
            if txt:
                cnt = _texts.get(str(uid))
                if cnt is None:
                    cnt = _texts[str(uid)] = {}
                cnt[txt] = cnt.get(txt, 0) + 1
        elif t == T_ENTER:
            u["e"] += 1
            if isinstance(ms, (int, float)):
                u["et"].append(int(ms))
        elif t in (T_GIFT, T_GUARD, T_SC):
            price = rec.get("price")
            price = float(price) if isinstance(price, (int, float)) else 0.0
            u["p"] += price
            u["pe"] += 1
            if isinstance(ms, (int, float)):
                u["pt"].append(int(ms))
            if t == T_SC:
                u["sc"] += price
                u["sc_cnt"] += 1
            elif t == T_GIFT:
                u["g"] += price
                u["gift_cnt"] += 1
            else:
                u["gd"] += price
                u["guard_cnt"] += 1
                nm = str(rec.get("message") or "")
                if Guard_rank.get(nm, 0) > Guard_rank.get(u["guard_top"] or "", 0):
                    u["guard_top"] = nm

    # 把每人的文本计数器折算成两个派生量（原文马上丢弃）。
    # ⚠️ **判定不在这里做**：这里只提供原料，是否需要剔除/降权由下游
    # `app/services/fan/spam.py` 的版本化入口决定，便于以后更换算法而不动采集。
    for uid, u in raw.items():
        cnt = _texts.get(uid) or {}
        if cnt:
            u["uniq"] = len(cnt)
            u["maxrep"] = max(cnt.values())

    sum_price = round(sum(u["p"] for u in raw.values()), 2)
    start_iso = end_iso = ""
    trimmed = 0
    # 跨度优先用**弹幕**时间戳（2026-10-20）：入场事件可能散落在几天之后（镜像返回的
    # 迟到/重放事件），实测会把 11 小时的场次拉成 102 小时。弹幕才是"有内容的时间段"，
    # 且入场事件本来就不能单独说明直播在进行。没有弹幕时才回退到全部事件。
    # 首选**平台记录**的起止（`stopDate` 覆盖率 99.9%，是权威值）；没有才从事件推。
    # 从事件推时分两种：有弹幕用弹幕时间戳，否则回退到全部事件（见上）。
    duration_source = "danmaku"
    ts_span = ts_chat or ts
    if span_ms:
        lo, hi, trimmed = span_ms[0], span_ms[1], 0
        duration_source = "platform"
    elif ts_span:
        lo, hi, trimmed = _trim_span(ts_span)
    # ⚠️ 这两行**必须在分支外**：之前误缩进在 `elif` 里，导致"平台跨度"那条路
    # 的 start_at / end_at 全是空串（2026-10-21 新采的 96 场就是这样，覆盖率一度
    # 只有 72%，怀疑数据不全）。写 **UTC** 是另一条纪律（见 devlog 569）。
    if span_ms or ts_span:
        start_iso = _utc_iso(lo)
        end_iso = _utc_iso(hi)
    _danmaku_total = sum(int(u["m"]) for u in raw.values())
    _uniq_total = sum(int(u["uniq"]) for u in raw.values())
    stats = {
        "start_at": start_iso,
        #: sys 事件（type 11/12）标定的真实开播/结束（毫秒）；没有则为 None。
        #: 以后排查"start_at 记早了"直接看它，不用再翻 raw。
        "bp": _behaviour_profile(records),
        "sys_start_ms": sys_start,
        "sys_end_ms": sys_end,
        "end_at": end_iso,
        "records": len(records),
        "distinct_uids": len(raw),
        "named_uids": sum(1 for r in records
                          if isinstance(r.get("uId"), int) and r.get("uName")),
        "type_hist": type_hist,
        "sys_events": sys_events,
        # 全场口径的重复率（审计用）：1 - 去重条数 / 原始条数。
        # 老数据没有这些字段 ⇒ 缺省为 None，**不伪装成 0**。
        # 场次跨度被裁掉的事件数（>0 说明有离群时间戳；跨度为**裁剪后**的）
        "duration_trimmed": trimmed,
        # 跨度来源：platform = 上游 stopDate/startDate；danmaku = 由事件时间戳推
        "duration_source": duration_source,
        "danmaku_total": _danmaku_total,
        "uniq_total": _uniq_total,
        "dup_rate": (round(1 - _uniq_total / _danmaku_total, 6)
                     if _danmaku_total else None),
        "sum_price": sum_price,
        "gift": round(sum(u["g"] for u in raw.values()), 2),
        "guard": round(sum(u["gd"] for u in raw.values()), 2),
        "sc": round(sum(u["sc"] for u in raw.values()), 2),
        # 与 `_probe` 的产物同名，方便复用已有分析脚本
        "type0": type_hist.get("0", 0),
        "type4": type_hist.get("4", 0),
        "api": "v2/live",
        "page_size": COLLECT_PAGE_SIZE,
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
    }
    return raw, stats


# ── 采集主流程 ──────────────────────────────────────────────────────────────
def list_sessions_from_db(
    db: "object",
    v: VtuberRef,
    since: str,
    until: str,
) -> list[SessionPlan]:
    """从本地 `live_sessions` 枚举区间内的场次 —— **本地优先的唯一来源**。

    返回的 `live_id` 是 danmakus 的 uuid（`/api/v2/live?liveId=` 要的就是它）。
    没有 DB 或不认识这个主播时返回空列表（调用方再决定要不要打上游）。

    ⚠️ 为什么优先本地：已归档的场次不该再问上游一遍；而且
    `/api/v2/channel` 实测会 502（2026-10-18），把它当唯一入口会让整个功能挂在别人的可用性上。
    """
    from sqlalchemy import and_, select

    from app.models.vtuber import Account, LiveSession

    try:
        stmt = (
            select(LiveSession.live_id, LiveSession.start_at)
            .join(Account, Account.id == LiveSession.account_id)
            .where(
                and_(
                    Account.platform == "bilibili",
                    Account.platform_uid == str(v.mid),
                    LiveSession.live_id.isnot(None),
                )
            )
        )
        rows = db.execute(stmt).all()  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 —— 没 DB / 表不存在都按"查不到"处理
        return []

    out: list[SessionPlan] = []
    for live_id, start_at in rows:
        lid = str(live_id or "")
        if len(lid) <= 20:          # 过滤非 uuid（老数据里有别种形态）
            continue
        day = start_at.strftime("%Y-%m-%d") if start_at else ""
        if not day or day < since or day > until:
            continue
        out.append(SessionPlan(lid, start_at.strftime("%Y-%m-%d %H:%M:%S")))
    out.sort(key=lambda s: s.start_at)
    return out


async def collect(
    v: VtuberRef,
    since: str,
    until: str,
    *,
    root: Path | None = None,
    progress: CollectProgress | None = None,
    should_stop: Callable[[], bool] | None = None,
    concurrency: int = COLLECT_CONCURRENCY,
    sessions: list["SessionPlan"] | None = None,
) -> CollectProgress:
    """采集 `[since, until]` 内的全部场次。

    Args:
        v: 主播。
        since / until: `YYYY-MM-DD`，闭区间。
        root: 覆盖数据根（测试用）。
        progress: 复用同一个进度对象（路由层持有它，前端读它）。
        should_stop: 返回 True 时尽快收尾（用户点取消）。
        concurrency: 并发上限，**不要大于** `COLLECT_CONCURRENCY`。
        sessions: 已确定要采的场次（调用方从本地库或上游算好）。**不传则现查上游**。

    Returns:
        收尾后的 `CollectProgress`（`state` 为 done / failed / cancelled）。
    """
    p = progress or CollectProgress(v.name, since, until)
    p.state = STATE_RUNNING
    # `ensure_data_dir()` = `resolve_data_dir(create=True)`：全新安装时按需创建，
    # 否则 mkdir 之前就抛了（这是打包形态的第一个坑）。
    base = (root or ensure_data_dir()) / v.subdir
    (base / "stats").mkdir(parents=True, exist_ok=True)
    (base / "raw").mkdir(parents=True, exist_ok=True)

    limits = httpx.Limits(max_connections=max(2, concurrency))
    async with httpx.AsyncClient(timeout=COLLECT_TIMEOUT_S, limits=limits,
                                 trust_env=False) as client:
        if sessions is None:
            try:
                sessions = plan_range(await list_sessions(client, v), since, until)
            except CollectError as exc:
                p.state, p.message = STATE_FAILED, str(exc)
                p.finished_at = time.time()
                return p
        else:
            sessions = list(sessions)
        if not sessions:
            p.state = STATE_FAILED
            p.message = f"{v.name} 在 {since} ~ {until} 内没有场次"
            p.finished_at = time.time()
            return p

        p.total = len(sessions)
        sem = asyncio.Semaphore(concurrency)

        # 质量闸 L3：每个 V 只取一次 vtb.cat 的场次表（失败就返回空，不影响采集）
        try:
            vtb_lives = await fetch_lives(v.mid)
        except Exception:  # noqa: BLE001
            vtb_lives = []

        async def one(s: SessionPlan) -> None:
            nonlocal p
            async with sem:
                if should_stop and should_stop():
                    return
                sp = base / "stats" / f"{s.live_id}.json"
                rp = _raw_path(base, s.live_id)
                if sp.is_file() and rp.is_file():
                    p.skipped += 1
                    return
                p.current = s.start_at
                p.phase = "fetch"
                p.page = p.pages = 0
                p.sessions_detail.append({"live_id": s.live_id, "start_at": s.start_at,
                                          "state": "running", "records": 0, "reason": ""})
                _got = await fetch_records(client, s.live_id, with_extra=True)
                if _got is None:
                    recs, _extra = None, {}
                else:
                    recs, _extra = _got
                if recs is None:
                    p.failed += 1
                    _mark(p, s.live_id, "failed", 0, "上游没有返回该场的弹幕")
                    p.failures.append({"live_id": s.live_id, "start_at": s.start_at,
                                       "reason": "上游没有返回该场的弹幕（可能已下架或接口无数据）"})
                    return
                if len(recs) < MIN_RECORDS:
                    p.failed += 1
                    _mark(p, s.live_id, "failed", len(recs),
                          f"记录太少（{len(recs)} 条，低于下限 {MIN_RECORDS}）")
                    p.failures.append({"live_id": s.live_id, "start_at": s.start_at,
                                       "reason": f"记录太少（{len(recs)} 条，低于下限 {MIN_RECORDS}）"})
                    return
                # 平台给了 stopDate 就用它算时长（权威）；否则 aggregate 内部回退到弹幕跨度
                span_ms = None
                if s.stop_at:
                    try:
                        span_ms = (int(datetime.strptime(s.start_at, "%Y-%m-%d %H:%M:%S")
                                       .replace(tzinfo=timezone.utc).timestamp() * 1000),
                                   int(datetime.strptime(s.stop_at, "%Y-%m-%d %H:%M:%S")
                                       .replace(tzinfo=timezone.utc).timestamp() * 1000))
                    except ValueError:
                        span_ms = None
                p.records += len(recs)
                p.phase = "aggregate"
                raw, stats = aggregate(recs, span_ms=span_ms)
                # 上游偶尔把前段弹幕重录到末尾（实测 9/227 场）；按内容比对裁掉，
                # 否则场次会显得长得多，重复内容还会污染按场次/按小时的统计。
                apply_replay_cut(raw, stats)
                # 回放裁完再看"弹幕率是否在 5 小时后骤降" —— 平台 stopDate 可能偏长
                # （实测有一场 12.9h 实际只有 6h）。只允许把结束时间提前。
                apply_rate_end(raw, stats)
                # 系统消息（直播中止/录制结束）是更硬的下播依据；没有就保持上面的结果
                apply_sys_end(raw, stats)
                # 质量闸：L1 自洽 / L2 平台计数 / L3 vtb.cat（只标记，不丢弃）
                try:
                    start_ms = int(datetime.strptime(s.start_at, "%Y-%m-%d %H:%M:%S")
                                   .replace(tzinfo=timezone.utc).timestamp() * 1000)
                except ValueError:
                    start_ms = None
                vit = match_session(vtb_lives, start_ms) if start_ms else None
                stats["quality"] = quality_evaluate(
                    stats=stats,
                    platform={"danmakus_count": s.danmakus_count, "income": s.income},
                    vtb=vit,
                )
                # 平均同接（去头尾 10%）：danmakus 的 onlineRank 时间线
                _acv, _pts, _peak = acv_from_online_rank(_extra)
                stats["acv"] = round(_acv, 2) if _acv else None
                stats["acv_points"] = _pts
                stats["peak_online"] = _peak
                stats["live_id"] = s.live_id
                p.phase = "write"
                await asyncio.to_thread(_write, base, s.live_id, raw, stats)
                p.done += 1
                _mark(p, s.live_id, "ok", len(recs), "")

        try:
            await asyncio.gather(*(one(s) for s in sessions))
        except Exception as exc:  # noqa: BLE001
            logger.exception("fan 采集异常")
            p.state, p.message = STATE_FAILED, f"{type(exc).__name__}: {exc}"
            p.finished_at = time.time()
            return p

    p.current = ""
    if should_stop and should_stop():
        p.state, p.message = STATE_CANCELLED, "已取消"
    elif p.done == 0:
        p.state, p.message = STATE_FAILED, "没有任何一场采集成功（全部失败或已存在）"
    else:
        p.state, p.message = STATE_DONE, f"完成 {p.done} 场"
    p.finished_at = time.time()
    return p


def _raw_path(base: Path, live_id: str) -> Path:
    """raw 的真实路径：新数据是 `.json.gz`，老数据是 `.json`（两种共存）。"""
    gz = base / "raw" / f"{live_id}.json.gz"
    return gz if gz.is_file() else base / "raw" / f"{live_id}.json"

def _write(base: Path, live_id: str, raw: dict, stats: dict) -> None:
    """原子写两个文件。**先 raw 后 stats** —— stats 存在就代表这一场齐了。"""
    rp = base / "raw" / f"{live_id}.json.gz"
    sp = base / "stats" / f"{live_id}.json"
    tmp = rp.with_name(rp.name + ".tmp")
    # raw 用 gzip 存：实测 1,024 KB → 93 KB（9.1%），磁盘 -90%。
    # 读取侧（loader）先找 .json.gz 再回落 .json，老数据无需迁移。
    payload = json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(tmp, "wb", compresslevel=6) as fh:
        fh.write(payload)
    os.replace(tmp, rp)
    tmp2 = sp.with_suffix(".json.tmp")
    tmp2.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp2, sp)


__all__ = [
    "COLLECT_PAGE_SIZE", "COLLECT_MAX_PAGES", "COLLECT_CONCURRENCY", "COLLECT_TIMEOUT_S",
    "ENUM_TIMEOUT_S", "ENUM_ATTEMPTS",
    "STATE_RUNNING", "STATE_DONE", "STATE_FAILED", "STATE_CANCELLED",
    "SessionPlan", "CollectProgress", "CollectError",
    "list_sessions", "list_sessions_from_db", "plan_range", "aggregate", "collect",
]
