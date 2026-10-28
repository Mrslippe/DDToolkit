"""数据分析工作台端点（P3/P4 + 采集，2026-10-18）。

只读分析部分全部从数据根的 JSON 事实表现算，**不写库**；采集部分只写数据根。
模型定义见 `docs/analysis-model/README.md`；施工阶段见 `docs/analysis-model/README.md`。

## 端点

| 端点 | 说明 |
|---|---|
| `GET /fan/vtubers` | 已注册的主播与数据可用性（含模块是否启用） |
| `GET /fan/{vtuber}/sessions?since=&until=` | 区间内有多少场可采（**采集前的预估**） |
| `POST /fan/{vtuber}/collect` | 启动采集（选 V + 区间） |
| `GET /fan/collect/status?vtuber=` | 采集进度 |
| `POST /fan/collect/cancel` | 取消采集 |
| `GET /fan/{vtuber}/ranked?by=` | 名单（**`by` 必填**） |
| `GET /fan/{vtuber}/tags` | 标签说明与占比 |
| `GET /fan/{vtuber}/health` | 完整性判据汇总 |
| `GET /fan/cross?vtubers=a,b` | 两 V 名单重叠 + 超几何零模型 |

## 三条口径

1. **整个模块由偏好 `fan_workbench` 控制**。未启用时**所有** `/fan` 端点返回 **404** 并说明
   原因 —— 这是"模块可选"的落点：关掉之后连数据都不该被算，也不该启动任何采集。
2. **`by` 必填、无默认值**（规格 §4.1）。缺了返回 **400**，不是 422。
3. **窗口由用户选的时间区间决定**（`since`/`until`，`YYYY-MM-DD` 闭区间）。
   不传则退化为"最近 `window` 场"。⚠️ 两个区间选得不同 ⇒ 分位参照总体不同 ⇒
   **跨区间比绝对分位不合法**（与 §5.5 同一条纪律）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import UTC, date, datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from urllib.parse import quote

from fastapi.responses import Response

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.routers.settings import PREFS_PREFIX
from app.core.timecn import CN_TZ, cn_day, cn_text, sql_day
from app.services.fan import (
    AXES,
    PURITY_THRESHOLD,
    FanDataError,
    FanDataNotFound,
    AXIS_ATTENDANCE,
    AXIS_INTERACTION,
    AXIS_PAYMENT,
    build_axis_table,
    get_vtuber,
    list_vtubers,
    load_window,
    participation_strength,
    rank,
    tag_all,
    type_label,
)
from app.services.fan.checks import check_window, summarize as summarize_checks
from app.services.fan.collector import (
    STATE_CANCELLED,
    STATE_RUNNING,
    CollectProgress,
    collect,
    list_sessions,
    list_sessions_from_db,
    plan_range,
)
from app.services.fan.avatars import fetch_avatar, prefetch
from app.services.fan import member_index
from app.services.fan.criterion import CRITERIA, fit as fit_criterion, score as score_criterion
from app.services.fan.loader import resolve_data_dir
from app.services.fan.pool import (POOL_MULT as POOL_SIZE_MULT, core_size_for,
                                   pool_size_for, tier_sizes_for, window_acv)
from app.services.fan.tags import explain as explain_tags
from app.services.fan.timeline import (
    MAX_LAG,
    TIERS_WITH_UNSEEN,
    TIER_CORE,
    TimelineError,
    build_windows,
    summarize as summarize_timeline,
    survival,
    transition,
)
from app.services.fan.tags import prevalence

logger = logging.getLogger(__name__)

router = APIRouter()

PREF_KEY = "fan_workbench"
SORT_BY_STRENGTH = "strength"
SORT_BY_AXES = ("attendance", "interaction", "payment")
SORT_BY = (SORT_BY_STRENGTH,) + SORT_BY_AXES + CRITERIA

DEFAULT_LIMIT = 100
MAX_LIMIT = 5000
MIN_WINDOW = 5
MAX_WINDOW = 5000   # 用户 2026-10-25：取消场次上限，可到全部历史
DEFAULT_WINDOW = 75
#: 滑杆取最近多少场（用户口径：总量上限 400 场，2026-10-18）
ACTIVITY_LIMIT = 2000  # 滑轨可取到的历史场次上限（配合“不设限”）
#: L6 滑动窗的默认参数（与 `timeline` 模块的常量同源）
TIMELINE_SIZE = 25
TIMELINE_STEP = 10

_CACHE: dict[tuple, dict[str, Any]] = {}
#: 采集任务：`v.subdir` → 进度对象。**同一主播同时只允许一个任务。**
_TASKS: dict[str, CollectProgress] = {}
_STOP: dict[str, bool] = {}
#: 区间预估的短期缓存（避免每敲一个日期就打一次上游）
_PLAN_CACHE: dict[tuple[str, str, str], tuple[float, Any]] = {}
PLAN_TTL_S = 300.0


#: 当前请求的 DB 会话（由 `require_module` 写入）。
_LAST_DB: dict[str, object] = {}


# ── 模块开关 ────────────────────────────────────────────────────────────────
def _module_enabled(db: Session) -> bool:
    """读 `fan_workbench`。

    ⚠️ `AppMetaRepo.all_with_prefix()` 返回的是**去掉前缀的键**（见它的 docstring），
    所以这里用裸键 `fan_workbench`，不是 `prefs.fan_workbench` —— 拼错了永远读不到、
    症状是"开关怎么点都不生效"。
    """
    from app.repositories.vtuber_repo import AppMetaRepo
    stored = AppMetaRepo(db).all_with_prefix(PREFS_PREFIX)
    return stored.get(PREF_KEY) == "on"


def require_module(db: Session = Depends(get_db)) -> None:
    """未启用时**所有** `/fan` 端点一律 404 —— 这是"模块可选"的落点。"""
    # `_compute` 是纯函数式调用的，为免到处传参，借这个所有分析端点都依赖的依赖项
    # 记一下当前请求的 DB 会话（同一次请求内有效）。
    _LAST_DB["db"] = db
    if not _module_enabled(db):
        raise HTTPException(
            404,
            "数据分析工作台未启用。请在「设置 → 功能」里打开它；"
            "关闭状态下本模块的接口一律不可用（也不会启动任何采集）。",
        )


def _resolve(vtuber_name: str, db: Session | None = None):
    """按名字/简称/mid 取 V。清单是**动态的**（来自库里的 B 站账号），不是硬编码三个样本。

    ⚠️ `db` 缺省时必须回落到**当前请求**的会话（`require_module` 写进 `_LAST_DB`）：
    否则 `get_vtuber` 只看三个开发样本，症状是「未知的主播：'七海Nana7mi'；
    可用：['弥月Mizuki','明前奶绿','星瞳_Official']」—— 库里有这个 V 却报不认识。
    """
    db = db or _LAST_DB.get("db")
    try:
        return get_vtuber(vtuber_name, db)
    except FanDataError as exc:
        raise HTTPException(404, str(exc)) from exc


def _range_or_none(since: str | None, until: str | None) -> tuple[str | None, str | None]:
    """校验并归一化区间。只给一端也允许（另一端视为无界）。"""
    if since and until and since > until:
        raise HTTPException(400, f"起止日期反了：{since} > {until}")
    return (since or None, until or None)


# ── 数据计算 ────────────────────────────────────────────────────────────────
#: 滑动窗口：每 5 场一格
POOL_TREND_STEP = 5


def _chart_data(win, table, payload: dict) -> dict[str, Any]:
    """三张新图表所需的数据（2026-10-26）。

    - `pool_trend`：每 5 场为一个窗口，算该窗口的**入选池**（3×ACV），
      与上一个窗口比较得到「新进 / 出池 / 未变」；
    - `lag_hist`：每个用户「场均入场时滞」的分段人数；
    - `msg_hist`：每个用户「场均弹幕」的分段人数；
    - `spam_split`：池内 确定/疑似/未命中 独轮车的人数。

    口径：滑动窗口的池用**同一套三维分位 + 3×ACV**规则，只是把统计范围换成那 5 场；
    因此它和"整窗名单"不完全一致（会略小），图表要标注这一点。
    """
    ids = [sr.live_id for sr in win.sessions]
    pos = {lid: i for i, lid in enumerate(ids)}
    n = len(ids)
    users = win.users

    # 每个用户的逐场三元组：出席场次数 / 弹幕 / 付费
    # 只统计**入选池**的人：图表讲的是池的变化，把 17 万观测用户都算进去
    # 会慢 30 倍且没有意义（2026-10-26 实测 49s → 优化后个位数秒）。
    per_user: dict[str, list[tuple[int, int, float]]] = {}
    for uid in table.uids:
        rows = win.slices.get(uid)
        if not rows:
            continue
        arr = [(0, 0, 0.0)] * n
        for sl in rows:
            i = pos.get(sl[0])
            if i is None:
                continue
            arr[i] = (1, int(sl[2]), float(sl[3]))
        per_user[uid] = arr

    trend: list[dict[str, Any]] = []
    prev: set[str] | None = None
    for start in range(0, n - POOL_TREND_STEP + 1, POOL_TREND_STEP):
        blk = range(start, start + POOL_TREND_STEP)
        stats = []
        for uid, arr in per_user.items():
            att = sum(arr[i][0] for i in blk)
            if not att:
                continue
            msg = sum(arr[i][1] for i in blk)
            pay = sum(arr[i][2] for i in blk)
            stats.append((uid, att, msg, pay))
        if not stats:
            continue
        # 三轴各自取分位，S = 均值；池大小按该窗口 ACV 的 3 倍（与主口径一致）
        def _pct(vals: list[float]) -> list[float]:
            order_ = sorted(range(len(vals)), key=lambda i: vals[i])
            out = [0.0] * len(vals)
            for rank, i in enumerate(order_):
                out[i] = rank / max(1, len(vals) - 1)
            return out

        pa = _pct([float(x[1]) for x in stats])
        pm = _pct([math.log1p(x[2]) for x in stats])
        pp = _pct([math.log1p(x[3]) for x in stats])
        scored = sorted(
            ((0.5 * pa[i] + 0.3 * pm[i] + 0.2 * pp[i]), stats[i][0])
            for i in range(len(stats))
        )
        acv_blk = [float((getattr(sr, "stats", None) or {}).get("acv") or 0)
                   for sr in win.sessions[start:start + POOL_TREND_STEP]]
        acv_blk = [a for a in acv_blk if a > 0]
        size = int(sum(acv_blk) / len(acv_blk) * POOL_SIZE_MULT) if acv_blk else len(scored) // 3
        cur = {uid for _, uid in scored[-size:]} if size > 0 else set()
        if prev is None:
            trend.append({"end": start + POOL_TREND_STEP, "size": len(cur),
                          "new": len(cur), "left": 0, "same": 0})
        else:
            trend.append({"end": start + POOL_TREND_STEP, "size": len(cur),
                          "new": len(cur - prev), "left": len(prev - cur),
                          "same": len(cur & prev)})
        prev = cur

    def _hist(vals: list[float], edges: list[float]) -> dict[str, Any]:
        counts = [0] * (len(edges) + 1)
        for v in vals:
            for i, e in enumerate(edges):
                if v < e:
                    counts[i] += 1
                    break
            else:
                counts[-1] += 1
        labels = [f"<{edges[0]:g}"] + [f"{edges[i]:g}–{edges[i+1]:g}"
                                       for i in range(len(edges) - 1)] + [f"≥{edges[-1]:g}"]
        return {"labels": labels, "counts": counts}

    # ⚠️ `set(table.uids)` 必须提到推导式外：写在条件里会**每个用户重建一次集合**，
    # 复杂度从 O(n) 变 O(n×池)，实测把 _compute 拖到 50 秒（2026-10-26）。
    pool_set = set(table.uids)
    lag_vals = [users[uid].mean_lag for uid in pool_set
                if users[uid].mean_lag is not None]
    msg_vals = [users[uid].m / max(1, users[uid].att_n) for uid in pool_set]
    spam = {"confirmed": 0, "suspected": 0, "none": 0}
    for uid in table.uids:
        lv = win.spam_levels.get(uid, "none")
        spam[lv if lv in spam else "none"] += 1

    # ── 贡献榜（2026-10-26 用户口径：把"鲸鱼"单独展示，其余合并）──────────
    def _top_split(vals: dict[str, float], top: int = 8) -> dict[str, Any]:
        items = [(uid, v) for uid, v in vals.items() if v > 0]
        items.sort(key=lambda x: -x[1])
        head = items[:top]
        tail = sum(v for _, v in items[top:])
        # ⚠️ 不要在这里截断：图例的截断交给前端 CSS（可换行）。
        # 之前 `[:8]` 把 "AoineKo青猫" 截成 "AoineKo青"，看起来像"昵称被裁"（2026-10-27）。
        labels = [f"{(users[u].name or u)}" for u, _ in head]
        # `uids` 与 `labels` **等长同序**（2026-10-28）：前端在设置里开了「隐藏昵称」时
        # 直接拿它替换图例/饼图上的文字。`其他 N 人` 那条没有对应的人 ⇒ 补 `None`，
        # 保持下标对齐（前端按下标取，错一位就会张冠李戴）。
        uids: list[str | None] = [u for u, _ in head]
        values = [round(v, 2) for _, v in head]
        if tail > 0:
            labels.append(f"其他 {len(items) - top} 人")
            uids.append(None)
            values.append(round(tail, 2))
        return {"labels": labels, "values": values, "uids": uids}

    pay_split_top = _top_split({uid: float(users[uid].pay) for uid in pool_set})
    msg_split_top = _top_split({uid: float(users[uid].m) for uid in pool_set})

    # 场均弹幕 vs 分位（折线）：**尾部加密**的分位点，配合前端 log 横轴，
    # 才能把"最活跃的那 1%"展开（等距 20 桶时最右一档只有 70 条，看不出尾巴）。
    msgs_sorted = sorted(users[uid].m / max(1, users[uid].att_n) for uid in pool_set)
    n_msg = len(msgs_sorted)
    dense = [i / 20 for i in range(1, 20)]
    dense += [0.95, 0.97, 0.98, 0.99, 0.995, 0.998, 0.999, 1.0]
    means = []
    pcts = []
    for p in dense:
        if n_msg == 0:
            break
        hi = max(1, min(n_msg, int(round(n_msg * p))))
        # 窗口宽度按分位分段：常规区间取前 5%，**尾部取前 0.5%** ——
        # 否则最右一档的均值被大量普通用户稀释（实测只有 36 条，而真正的头部是 200+）
        w = 0.005 if p >= 0.95 else 0.05
        lo = max(0, hi - max(1, int(round(n_msg * w))))
        chunk = msgs_sorted[lo:hi]
        if not chunk:
            continue
        pcts.append(round(p, 3))
        means.append(round(sum(chunk) / len(chunk), 1))

    return {
        "pool_trend": trend,
        "pay_split_top": pay_split_top,
        "msg_split_top": msg_split_top,
        "msg_pct": {"pcts": pcts, "means": means},
        "lag_hist": _hist([float(x) for x in lag_vals], [5, 10, 20, 30, 45, 60, 90, 120, 180]),
        "msg_hist": _hist([float(x) for x in msg_vals], [5, 10, 20, 50, 100, 200, 500, 1000]),
        "spam_split": spam,
    }


def _compute(vtuber_name: str, window: int, since: str | None = None,
             until: str | None = None,
             live_ids: list[str] | None = None) -> dict[str, Any]:
    """加载并算出三轴 + 强度 + 类型 + 标签。按 `(主播, 窗口, 区间)` 记忆化。"""
    v = _resolve(vtuber_name, _LAST_DB.get("db"))
    #: 清单进缓存键：同一区间但不同窗口切片是不同的分析（用元组，可哈希）
    key = (v.subdir, window, since, until, tuple(sorted(live_ids)) if live_ids else None)
    hit = _CACHE.get(key)
    if hit is not None:
        return hit

    try:
        win = load_window(v, window, since=since, until=until, live_ids=live_ids)
    except FanDataNotFound as exc:
        raise HTTPException(
            404,
            "还没有任何分析数据。请在工作台里选一个主播和时间区间，点「开始采集」；"
            f"首采需要几分钟。（{exc}）",
        ) from exc
    if not win.sessions:
        extra = ""
        if win.warnings:
            extra = "：" + "；".join(win.warnings[:3])
        raise HTTPException(
            404,
            f"{v.name} 在所选条件下没有可用场次（窗口 {window}"
            + (f" · 区间 {since or '-'}~{until or '-'}" if since or until else "")
            + "）" + extra,
        )
    # 池子规模由**平均同接（ACV）**决定（2026-10-23 用户定案 B 方案）：
    #   核心 = 0.75×ACV，次核心 = 1.25×ACV ⇒ 池 = 2×ACV，其余"分流走"。
    # ACV 取窗口内各场 `stats["acv"]` 的中位数；缺失时回退到 INCLUSION_FLOOR 老口径。
    acv = window_acv(win)
    pool_size = pool_size_for(win)
    core_n = core_size_for(win)

    table = build_axis_table(win, pool_size=pool_size)
    if len(table) == 0:
        raise HTTPException(404, f"{v.name} 在所选条件下没有达到入选门槛的观众")

    payload = {
        "window": win, "table": table,
        "strength": participation_strength(table),
        "labels": type_label(table),
        "tags": tag_all(win, table),
        "since": since, "until": until,
        "acv": acv, "pool_size": pool_size, "core_n": core_n,
        "tier_sizes": tier_sizes_for(win),
    }
    # 收入贡献占比（2026-10-25）：某人付费 / **池内总收入**。
    # 比"付费分位"更能区分尾部 —— 分位是排名，¥300 与 ¥20,000 只差 0.14；
    # 占比是量级，二者差 75 倍（0.03% vs 2.2%）。
    _pool_pay = sum(win.users[u].pay for u in table.uids)
    payload["pay_total_pool"] = _pool_pay
    # 出席位图（2026-10-25）：窗口内逐场是否出现（以"有入场事件"为准）
    _session_ids = [sr.live_id for sr in win.sessions]
    _pos = {lid: i for i, lid in enumerate(_session_ids)}
    # 出席明细：`None` = 没出席；数字 = 该场首次出场时滞（分钟）。
    # 口径必须与 `att_n` 一致：loader 里**只要出现在 raw 就算出席**（不看入场事件 e）。
    # 前端据此上色：时滞越长颜色越淡（2026-10-25 用户口径）。
    payload["att_bits"] = {}
    for _uid in table.uids:
        lags: list[float | None] = [None] * len(_session_ids)
        for sl in win.slices.get(_uid, []):
            i = _pos.get(sl[0])
            if i is None:
                continue
            lag = sl[6] if len(sl) > 6 else None
            lags[i] = float(lag) if lag is not None else 0.0
        payload["att_bits"][_uid] = lags

    # ── 新增图表数据（2026-10-26）──────────────────────────────────────────
    # 全部从 `win.slices` 推导，**不额外读文件**（否则 15 个滑动窗口要扫 15 遍 raw）。
    payload["charts"] = _chart_data(win, table, payload)

    # 每场的时滞参照（p90）：颜色要**按场归一**，否则长场次里所有人都是"最淡"。
    # 实测七海这个 V 的场次中位时长 6 小时（最长 11.6h），时滞中位数 137 分钟；
    # 用固定 30 分钟做上限，整列会被裁成同一个浅色（2026-10-25 用户报"9-22 那场大家都差很多"）。
    _lag_by_session: list[list[float]] = [[] for _ in _session_ids]
    for _uid in table.uids:
        for sl in win.slices.get(_uid, []):
            i = _pos.get(sl[0])
            lag = sl[6] if len(sl) > 6 else None
            if i is not None and lag is not None:
                _lag_by_session[i].append(float(lag))
    payload["att_lag_ref"] = [
        (sorted(v)[min(len(v) - 1, int(len(v) * 0.9))] if v else 0.0)
        for v in _lag_by_session
    ]

    payload["pay_share"] = {
        u: (win.users[u].pay / _pool_pay if _pool_pay > 0 else 0.0) for u in table.uids
    }
    _by_pay = sorted(table.uids, key=lambda x: -win.users[x].pay)
    payload["pay_rank"] = {u: i for i, u in enumerate(_by_pay, 1)}

    # 标签占比：分母是**入选池**（名单里看到的比例），不是全体观测用户
    _pool_tags: dict[str, int] = {}
    for _uid in table.uids:
        for _t in payload["tags"].get(_uid, []):
            _pool_tags[_t] = _pool_tags.get(_t, 0) + 1
    payload["tag_prev"] = {k: v / max(1, len(table.uids)) for k, v in _pool_tags.items()}

    # 成员详情索引（2026-10-24 用户定案）：**在分析阶段同步建**，让用户显式等待一次。
    # 放在这里而不是后台预热，是因为"分析完成"应当意味着"详情可秒开" ——
    # 后台建的索引会在用户点开详情时还没好，表现为"有时快有时慢"，比固定等待更难预期。
    # 切片由 `load_window` 在读 raw 的同一遍里产出 ⇒ 这里只是登记，不再扫第二遍
    member_index.put(win.vtuber.subdir, [sr.live_id for sr in win.sessions], win.slices)

    _CACHE[key] = payload
    logger.info("fan: 已计算 %s（%s 场 · 区间 %s~%s）→ %s 人入池",
                v.name, win.n, since or "…", until or "…", len(table))
    return payload


def clear_cache() -> None:
    member_index.clear()
    """数据变了就失效（采集完成后由任务自己调用）。"""
    _CACHE.clear()
    _PLAN_CACHE.clear()


def reset_state() -> None:
    """给用例用：连同任务表一起清空。"""
    clear_cache()
    _TASKS.clear()
    _STOP.clear()


def _primary(payload: dict[str, Any], by: str) -> dict[str, float]:
    if by == SORT_BY_STRENGTH:
        return payload["strength"]  # type: ignore[no-any-return]
    if by in SORT_BY_AXES:
        # 单轴排序：用该轴的分位（与强度同量纲，0~1）
        axis = {"attendance": AXIS_ATTENDANCE, "interaction": AXIS_INTERACTION,
                "payment": AXIS_PAYMENT}[by]
        table = payload["table"]
        return {u: float(table.pct[u][axis]) for u in table.uids}
    fitted = fit_criterion(payload["window"], by)
    return score_criterion(payload["table"], fitted.fit)


# ── 主播列表 ────────────────────────────────────────────────────────────────
@router.get("/fan/vtubers")
def list_fan_vtubers(db: Session = Depends(get_db)) -> dict[str, Any]:
    """已注册的主播 + 数据是否就位 + 模块是否启用。**不加载事实表**（秒回）。"""
    enabled = _module_enabled(db)
    try:
        root = resolve_data_dir()
        root_error = None
    except FanDataError as exc:
        root, root_error = None, str(exc)
    items = []
    for v in list_vtubers(db, root=root):
        stats_dir = (root / v.subdir / "stats") if root else None
        n = len(list(stats_dir.glob("*.json"))) if stats_dir and stats_dir.is_dir() else 0
        items.append({"name": v.name, "short": v.short, "mid": v.mid,
                      "subdir": v.subdir, "has_data": n > 0, "sessions": n})
    return {"items": items, "count": len(items), "enabled": enabled,
            "data_root": str(root) if root else None, "error": root_error}


async def _resolve_sessions(v, since: str, until: str, db: Session | None = None):
    """**本地优先**枚举区间内的场次。

    顺序：本地 `live_sessions`（已归档的、离线可用）→ 上游 `/api/v2/channel`。
    ⚠️ 上游实测会 502（2026-10-18），所以它只能是兜底，不能是唯一入口。

    Returns:
        `(sessions, source)`，`source` 为 `"local"` / `"upstream"` / `"none"`。
    """
    local = []
    if db is not None:
        local = list_sessions_from_db(db, v, since, until)
    if local:
        return local, "local"

    import httpx

    from app.services.fan.collector import COLLECT_TIMEOUT_S
    try:
        async with httpx.AsyncClient(timeout=COLLECT_TIMEOUT_S, trust_env=False) as client:
            all_sessions = await list_sessions(client, v)
    except Exception:  # noqa: BLE001 —— 上游不可用不该让整页炸
        return [], "none"
    return plan_range(all_sessions, since, until), "upstream"


# ── 采集 ────────────────────────────────────────────────────────────────────
class CollectRequest(BaseModel):
    since: str = Field(..., description="起始日期 YYYY-MM-DD（含）")
    until: str = Field(..., description="结束日期 YYYY-MM-DD（含）")
    #: 显式场次清单（2026-10-19）：给了就**按这批 live_id 采**，忽略日期枚举。
    #: 界面上的"窗口"是 75 场，而日期区间可能含 78 场（边界日外溢）——
    #: 传这个清单才能保证"采的就是窗口里那 75 场"。
    sessions: list[dict[str, str]] | None = None


@router.get("/fan/{vtuber}/sessions")
async def session_preview(
    vtuber: str,
    since: str = Query(..., description="YYYY-MM-DD"),
    until: str = Query(..., description="YYYY-MM-DD"),
    _: None = Depends(require_module),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """区间内有多少场、已采过几场。**采集前的预估**，用户据此决定要不要执行。"""
    # ⚠️ 必须传 `db`：不传时 `get_vtuber` 只能查硬编码的 `LEGACY_VTUBERS`，
    # 库里的账号 mid 与常量不一致时本地枚举返回空 ⇒ 落到**上游兜底**（实测 502）
    # ⇒ 请求挂到超时，前端只看到 `Failed to fetch`（2026-10-18 用户截图复现）。
    v = _resolve(vtuber, db)
    since, until = _range_or_none(since, until)
    if not since or not until:
        raise HTTPException(400, "预估必须同时给起止日期")
    key = (v.subdir, since, until)
    now = time.time()
    cached = _PLAN_CACHE.get(key)
    if cached and now - cached[0] < PLAN_TTL_S:
        sessions, source = cached[1], cached[2]
    else:
        sessions, source = await _resolve_sessions(v, since, until, db)
        _PLAN_CACHE[key] = (now, sessions, source)

    # 数据根可能还不存在（dev 数据目录里没有 fan-structure 就是这样）。不兜住会 500，
    # 前端只看到 `Failed to fetch` —— 2026-10-18 用户截图正是这条。
    try:
        root = resolve_data_dir() / v.subdir
    except FanDataNotFound as exc:
        raise HTTPException(
            409,
            "还没有任何分析数据根。请在工作台里选一个区间后点「开始采集」建立它；"
            f"开发时也可以设 DDTOOLKIT_FAN_DATA_DIR 指向已有的数据集。（{exc}）",
        ) from exc
    have = ({p.stem for p in (root / "stats").glob("*.json")}
            if (root / "stats").is_dir() else set())
    todo = [s for s in sessions if s.live_id not in have]
    return {
        "vtuber": v.name, "since": since, "until": until,
        "total": len(sessions), "already": len(sessions) - len(todo),
        "to_collect": len(todo),
        "source": source,
        "first": sessions[0].start_at if sessions else None,
        "last": sessions[-1].start_at if sessions else None,
    }


@router.post("/fan/{vtuber}/collect")
async def start_collect(
    vtuber: str,
    payload: CollectRequest,
    _: None = Depends(require_module),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """启动采集。**同一主播同时只允许一个任务。**"""
    v = _resolve(vtuber)
    since, until = _range_or_none(payload.since, payload.until)
    if not since or not until:
        raise HTTPException(400, "采集必须同时给起止日期")
    cur = _TASKS.get(v.subdir)
    if cur and cur.state == STATE_RUNNING:
        raise HTTPException(409, f"{v.name} 已有采集任务在跑（{cur.done}/{cur.total}）")

    prog = CollectProgress(v.name, since, until)
    _TASKS[v.subdir] = prog
    _STOP[v.subdir] = False

    # 场次列表在**开始前**就定下来（本地优先）；不然采集中途上游挂了会采一半
    explicit = payload.sessions
    if explicit:
        from app.services.fan.collector import SessionPlan
        plans = [SessionPlan(live_id=str(x.get("live_id") or ""),
                             start_at=str(x.get("start_at") or ""))
                 for x in explicit if x.get("live_id")]
        sessions, source = plans, "window"
    else:
        sessions, source = await _resolve_sessions(v, since, until, db)

    async def run() -> None:
        try:
            await collect(v, since, until, progress=prog, sessions=sessions,
                          should_stop=lambda: _STOP.get(v.subdir, False))
        except Exception as exc:  # noqa: BLE001
            logger.exception("fan 采集任务异常")
            prog.state, prog.message = "failed", f"{type(exc).__name__}: {exc}"
            prog.finished_at = time.time()
        finally:
            clear_cache()   # 数据变了，分析缓存必须失效

    asyncio.create_task(run())
    return {"ok": True, "vtuber": v.name, "since": since, "until": until,
            "state": prog.state, "planned": len(sessions), "source": source}


def tasks_snapshot() -> dict[str, Any] | None:
    """给顶栏 `notices` 用：当前**运行中**的 fan 任务一行摘要（2026-10-28，D 批）。

    没有运行中的任务 ⇒ `None`（**不占顶栏**：顶栏只放"现在正在发生的事"）。
    ⚠️ 为什么不复用 `/fan/collect/status` 端点：那个要过 `require_module` 与 token，
    而 notices 是**服务端内部**合成，走函数调用更直接、也不需要再绕一次 HTTP。
    """
    for prog in list(_TASKS.values()):
        if getattr(prog, "state", "") != "running":
            continue
        total = int(getattr(prog, "total", 0) or 0)
        done = int(getattr(prog, "done", 0) or 0)
        tail = f"{done}/{total} 场" if total > 0 else (getattr(prog, "current", "") or "")
        return {
            "label": "采集弹幕",
            "who": f"{prog.vtuber} {tail}".strip(),
            "started_at": float(getattr(prog, "started_at", 0) or 0),
        }
    return None


@router.get("/fan/collect/status")
def collect_status(
    vtuber: str | None = Query(None),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """采集进度。不传 `vtuber` 时返回全部任务。"""
    if vtuber:
        v = _resolve(vtuber)
        prog = _TASKS.get(v.subdir)
        if prog is None:
            return {"items": [], "count": 0}
        return {"items": [prog.as_dict()], "count": 1}
    return {"items": [p.as_dict() for p in _TASKS.values()], "count": len(_TASKS)}


@router.post("/fan/collect/cancel")
def cancel_collect(
    vtuber: str = Query(...),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """取消采集。**已写盘的场次保留**（它们是有效数据，删掉要重采）。"""
    v = _resolve(vtuber)
    prog = _TASKS.get(v.subdir)
    if prog is None or prog.state != STATE_RUNNING:
        raise HTTPException(409, f"{v.name} 没有正在进行的采集任务")
    _STOP[v.subdir] = True
    prog.state = STATE_CANCELLED
    prog.message = "已请求取消"
    return {"ok": True, "vtuber": v.name}


# ── 名单 ────────────────────────────────────────────────────────────────────
@router.get("/fan/avatar/{uid}")
async def fan_avatar(uid: str) -> Response:
    """按 uid 代理 B 站头像，落盘缓存。

    **公开路径**（`<img>` 带不了 token）：只接受纯数字 uid，且只打 B 站接口，不转发任意 URL。

    性能（2026-10-24 优化，实测）：**缓存命中 5 ms/个，冷启动 466–726 ms/个**。
    冷启动的三段开销分别用**全局连接池**、**uid→face 磁盘缓存**消除，配合 `/ranked` 的后台预热，
    用户滚到名单时通常已就绪。响应带 `Cache-Control: immutable`，WebView 二次打开不再请求。
    """
    if not uid.isdigit() or len(uid) > 20:
        raise HTTPException(400, "uid 必须是纯数字")

    got = await fetch_avatar(uid, resolve_data_dir())
    if got is None:
        raise HTTPException(404, "头像取不到")
    body, media = got
    return Response(
        body,
        media_type=media,
        headers={"Cache-Control": "public, max-age=2592000, immutable"},
    )


#: CSV 列顺序（**固定**，便于用户做二次分析；新增列只能追加在末尾）
CSV_COLUMNS = ("排名", "uid", "昵称", "强度", "出勤分位", "互动分位", "付费分位",
               "出勤场次", "出席率", "弹幕数", "去重弹幕", "付费金额",
               "舰长", "SC", "礼物", "类型", "标签")

_BY_LABEL = {"strength": "综合", "attendance": "出席", "interaction": "互动",
             "payment": "付费", "retention": "留存", "income": "收入"}


def _csv_cell(v: Any) -> str:
    """CSV 单元格：统一成字符串并转义（含逗号/引号/换行都包引号）。"""
    if v is None:
        return ""
    text = str(v)
    if any(ch in text for ch in (",", '"', "\n", "\r")):
        return '"' + text.replace('"', '""') + '"'
    return text


def ranked_csv_bytes(items: list[dict[str, Any]]) -> bytes:
    """名单 → CSV 字节（**带 UTF-8 BOM**，Excel 双击不乱码；CRLF 换行）。

    单独抽成纯函数：不给数据也能测列序与转义，CI 里不必有数据集。
    """
    lines = [",".join(CSV_COLUMNS)]
    for r in items:
        pct = r.get("axis_percentiles") or {}
        lines.append(",".join(_csv_cell(x) for x in (
            r.get("rank"), r.get("uid"), r.get("name") or "", r.get("strength"),
            pct.get("attendance"), pct.get("interaction"), pct.get("payment"),
            r.get("att_sessions"), r.get("att_rate"),
            r.get("msg_total"), r.get("msg_unique"), r.get("pay_total"),
            r.get("guard_amt"), r.get("sc_amt"), r.get("gift_amt"),
            r.get("type"), ";".join(r.get("tags") or ()),
        )))
    return ("\ufeff" + "\r\n".join(lines) + "\r\n").encode("utf-8")


@router.get("/fan/{vtuber}/ranked")
def ranked(
    vtuber: str,
    by: str | None = Query(None,
                        description="排序口径：strength / attendance / interaction / payment / retention / income（**必填**）"),
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None, description="YYYY-MM-DD"),
    until: str | None = Query(None, description="YYYY-MM-DD"),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0, description="名单分页偏移（0 起）；全池可翻"),
    ids: str | None = Query(None, description="窗口的场次清单（逗号分隔的 live_id）；给了就只算这几场"),
    tags: str | None = Query(None, description="标签过滤（逗号分隔，**与**语义）"),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """名单。`by` 是**必填**的 —— 不提供默认口径。

    `ids` = 界面上那个窗口的场次清单：给了就**只算这几场**，不再按"区间内最后 N 场"取
    —— 否则"滑杆窗口 / 采集对象 / 分析样本"会是三套口径（2026-10-19 用户要求全做）。
    """
    if not by:
        raise HTTPException(
            400,
            "缺少排序口径 `by`。可选：" + " / ".join(SORT_BY)
            + " —— 不设默认值：参与强度是目标中立的，效标加权必须由调用方显式声明效标。",
        )
    by = by.strip().lower()
    if by not in SORT_BY:
        raise HTTPException(400, f"未知排序口径 {by!r}；可选：{' / '.join(SORT_BY)}")

    since, until = _range_or_none(since, until)
    wanted = [x for x in (ids or "").split(",") if x]
    payload = _compute(vtuber, window, since, until, live_ids=wanted or None)
    order = rank(payload["table"], _primary(payload, by))
    # 标签过滤（2026-10-24）：多标签是**与**语义 —— 选「舰长+老头」= 既是舰长又是老头
    if tags:
        want = {t.strip() for t in tags.split(",") if t.strip()}
        tag_map = payload["tags"]
        if want:
            order = [u for u in order if want <= set(tag_map.get(u, []))]

    table, tags, labels, win = (payload["table"], payload["tags"],
                                payload["labels"], payload["window"])
    rows = []
    page = order[offset:offset + limit]
    for pos, uid in enumerate(page, offset + 1):
        p = table.pct[uid]
        u = win.users.get(uid)
        rows.append({
            "rank": pos, "uid": uid, "type": labels[uid],
            # 展示用：昵称（采集时落的 uName）与头像代理地址
            "name": (u.name if u else "") or "",
            # ⚠️ 只给本地代理路径（2026-10-24）：danmakus 的 CDN（workers.vrp.moe）
            # 在我们这儿一律 403，前端先试它只会让每个头像都先失败一次、并刷满错误上报。
            "avatar": f"/fan/avatar/{uid}",
            "strength": round(payload["strength"][uid], 6),
            "axis_percentiles": {a: round(p[a], 6) for a in AXES},
            "att_sessions": u.att_n if u else 0,
            "att_rate": round(u.att_n / max(1, win.n), 6) if u else 0.0,
            "pay_total": round(table.tie[uid]["pay"], 2),
            # ── 各页签专用（2026-10-25）──
            #: 出席明细：窗口内逐场是否出席（1=出席，顺序同 win.sessions）
            "att_bits": payload["att_bits"].get(uid, []),
            "mean_lag_minutes": (round(u.mean_lag, 2) if u and u.mean_lag is not None else None),
            "msg_per_session": round(u.m / max(1, u.att_n), 2) if u else 0.0,
            "msg_unique": int(u.uniq) if u else 0,
            "gift_cnt": int(u.gift_cnt) if u else 0,
            "guard_cnt": int(u.guard_cnt) if u else 0,
            "sc_cnt": int(u.sc_cnt) if u else 0,
            "gift_amt": round(u.gift_amt, 2) if u else 0.0,
            "guard_amt": round(u.guard_amt, 2) if u else 0.0,
            "sc_amt": round(u.sc_amt, 2) if u else 0.0,
            #: 收入贡献占比（该用户付费 / 池内总收入）
            "pay_share": round(payload["pay_share"].get(uid, 0.0), 8),
            #: 池内付费名次（1 = 最高）
            "pay_rank": payload["pay_rank"].get(uid),
            "msg_total": int(table.tie[uid]["msg"]),
            # 独轮车标记（v1 重复率 ∪ v2 时间分布）；None = 不是
            "spam": win.spam.get(uid),
        #: 独轮车三档：none / suspected / confirmed（2026-10-25）
        "spam_level": win.spam_levels.get(uid, "none"),
            "tags": tags.get(uid, []),
        })

    # 全池聚合（2026-10-21）：两张图要覆盖"通过 10% 门槛的全部人"，而不是 limit 条名单。
    # 分层沿用前端原来那套分位切法（前 20% 核心、20–50% 次核心、其余外层）
    # 与 `cross_v.assign_tiers` 同一组阈值，避免前后端算出两种口径。
    _vals = [payload["strength"][u] for u in table.uids]
    _n = len(_vals)
    # 分层按 ACV（2026-10-23 用户定案）：核心 = 0.75×ACV，次核心 = 1.25×ACV；
    # 池子本身已经是 2×ACV，所以"外层"取消，多出来的人记在 `excluded`（分流走）。
    # 三层按 ACV 人数切（2026-10-24 用户定案）：核心 0.75×、次核心 1.25×、外层 1.0×。
    # 名单已按核心度排过序（build_axis_table 里），这里按**强度**再排一次保证层级单调。
    _tier_want = payload.get("tier_sizes") or {}
    _ranked = sorted(table.uids, key=lambda u: (-payload["strength"][u], u))
    _pool_tiers: dict[str, int] = {}
    _cursor = 0
    for _name in ("核心", "次核心", "外层"):
        _want = int(_tier_want.get(_name) or 0)
        _take = min(_want, max(0, _n - _cursor)) if _want else 0
        _pool_tiers[_name] = _take
        _cursor += _take
    if _cursor < _n:                      # 没配三层时（无 ACV）退回对半切
        _pool_tiers["次核心"] += _n - _cursor
    # 三轴分位分布（每个 Tab 的图用它）
    _axes: dict[str, dict[str, Any]] = {}
    for _name, _axis in (("attendance", AXIS_ATTENDANCE), ("interaction", AXIS_INTERACTION),
                         ("payment", AXIS_PAYMENT)):
        _xs = [float(table.pct[u][_axis]) for u in table.uids
               if table.pct.get(u, {}).get(_axis) is not None]
        _alo = min(_xs) if _xs else 0.0
        _ahi = max(_xs) if _xs else 1.0
        _aspan = (_ahi - _alo) or 1.0
        _acounts = [0] * 20
        for _x in _xs:
            _acounts[min(19, max(0, int((_x - _alo) / _aspan * 20)))] += 1
        _axes[_name] = {"lo": round(_alo, 6), "hi": round(_ahi, 6), "counts": _acounts}

    # 付费构成（从场次 stats 取，单位元）
    _gift = _guard = _sc = 0.0
    for _sr in win.sessions:
        _st = getattr(_sr, "stats", None) or {}
        _gift += float(_st.get("gift") or 0.0)
        _guard += float(_st.get("guard") or 0.0)
        _sc += float(_st.get("sc") or 0.0)

    _type_counts: dict[str, int] = {}
    for _lab in payload["labels"].values():
        _type_counts[_lab] = _type_counts.get(_lab, 0) + 1

    # 出席场次数分布（2026-10-25）：分位天生均匀，直方图看不出东西；
    # 改成分「来了几场」的人数分布，才能看到满勤/低频的形态。
    _att_bins = [0] * (win.n + 1)
    for _u in table.uids:
        _att_bins[min(win.n, max(0, win.users[_u].att_n))] += 1

    # 没进样本的场次：给出**时间与标题**（不再显示 live_id）
    _skipped: list[dict[str, Any]] = []
    for _w in win.warnings:
        _lid = _w.split("live_id=")[-1].split("：")[0].split("；")[0].strip() if "live_id=" in _w else ""
        if not _lid:
            continue
        # 时间取 stats 的 start_at（UTC → 东八区）；标题取库里的 live_sessions
        _st_at = ""
        try:
            _raw = json.loads((resolve_data_dir() / win.vtuber.subdir / "stats"
                               / f"{_lid}.json").read_text(encoding="utf-8"))
            _st_at = cn_text(str(_raw.get("start_at") or ""))
        except (OSError, ValueError):
            pass
        _title = ""
        try:
            from sqlalchemy import text as _sql_text
            _db = _LAST_DB.get("db")
            if _db is not None:
                _row = _db.execute(
                    _sql_text("select title from live_sessions where live_id = :lid"),
                    {"lid": _lid}).first()
                _title = str(_row[0] or "") if _row else ""
        except Exception:  # noqa: BLE001 —— 标题取不到不影响提示本身
            _title = ""
        # 原因就在警告文案里（"跳过 live_id=xxx：无入场事件，出勤不可测"），带上它
        _reason = _w.split("：", 1)[1].strip() if "：" in _w else _w.strip()
        _skipped.append({"live_id": _lid, "start_at": _st_at,
                         "title": _title, "reason": _reason})

    _lo = min(_vals) if _vals else 0.0
    _hi = max(_vals) if _vals else 1.0
    _span = (_hi - _lo) or 1.0
    _bins = [0] * 20
    for _v in _vals:
        _i = min(19, max(0, int((_v - _lo) / _span * 20)))
        _bins[_i] += 1

    # 后台预热第一页头像：用户滚到名单时基本已就绪（失败静默，不阻塞响应）
    if offset == 0:
        prefetch([r["uid"] for r in rows[:40]], resolve_data_dir())

    return {
        "vtuber": table.vtuber, "window": window, "sessions": win.n,
        #: 窗口**请求**的场次数（滑杆选的）与实际**计入**的场次数（过了质量判据的）
        "requested_sessions": len(wanted) if wanted else window,
        #: `load_window` 跳过了哪些场、为什么 —— 之前只写进日志，界面上看不到
        "warnings": list(win.warnings),
        #: 没进样本的场次（时间 + 标题；标题取不到的留空）
        "skipped": _skipped,
        #: 出席场次数分布（下标 = 出席场次，值 = 人数）
        "att_bins": {"max": win.n, "counts": _att_bins},
        #: 每场的时滞参照（p90，分钟）：前端按它归一上色，跨场次可比
        "att_lag_ref": payload["att_lag_ref"],
        "since": since, "until": until, "by": by,
        "purity_threshold": PURITY_THRESHOLD,
        "total_in_pool": len(table), "count": len(rows),
        #: 过滤后的名单总数（标签筛选时前端用它当分母）
        "list_total": len(order),
        #: 池里被判为独轮车的人数（前端可据此提示"Top N 里有 X 人"）
        "spam_in_pool": sum(1 for u in table.uids if u in win.spam),
        #: 全池（过门槛后的所有人）的分层与强度分布 —— 两张图用它，不用 items
        # 标签目录随名单一起返回（2026-10-25）：筛选器不必再发一次请求，
        # 也就没有"分析刚完成、点开筛选还在算"的十几秒等待。
        #: 三张新图表的数据（滑动池趋势 / 时滞分布 / 场均弹幕分布 / 独轮车占比）
        "charts": payload.get("charts") or {},
        "tag_catalog": [
            {"name": name, "prevalence": round(prev, 6)}
            for name, prev in sorted(payload["tag_prev"].items(),
                                     key=lambda kv: -kv[1])
        ],
        "pool": {
            "size": _n,
            "tiers": _pool_tiers,
            "bins": {"lo": round(_lo, 6), "hi": round(_hi, 6), "counts": _bins},
            "axes": _axes,
            #: 平均同接（去头尾 10%）与"被分流走"的人数 —— 让池子为什么变小可见
            "acv": payload.get("acv"),
            "excluded": max(0, len(win.users) - _n),
            "pool_rule": "2×ACV" if payload.get("acv") else "attendance_floor",
            "pay_split": {"gift": round(_gift, 2), "guard": round(_guard, 2),
                          "sc": round(_sc, 2)},
            "type_counts": _type_counts,
        },
        "items": rows,
    }


@router.get("/fan/{vtuber}/search")
def search_member(
    vtuber: str,
    q: str = Query(..., min_length=1, description="uid 或昵称的模糊串"),
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None, description="YYYY-MM-DD"),
    until: str | None = Query(None, description="YYYY-MM-DD"),
    limit: int = Query(20, ge=1, le=100),
    ids: str | None = Query(None, description="窗口的场次清单（逗号分隔）"),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """在**当前窗口的池子里**按 uid / 昵称模糊搜索（2026-10-24）。

    只搜池内的人 —— 被分流走的人不在名单里，搜到也没法看详情，反而误导。
    """
    since, until = _range_or_none(since, until)
    wanted = [x for x in (ids or "").split(",") if x]
    payload = _compute(vtuber, window, since, until, live_ids=wanted or None)
    table, win = payload["table"], payload["window"]
    strength = payload["strength"]
    labels = payload["labels"]
    needle = q.strip().lower()

    hits = []
    for uid in table.uids:
        name = win.users[uid].name or ""
        if needle in uid.lower() or needle in name.lower():
            hits.append(uid)
    hits.sort(key=lambda u: (-strength[u], u))
    items = [{
        "uid": u, "name": win.users[u].name or "", "type": labels[u],
        "strength": round(strength[u], 6),
        "avatar": f"/fan/avatar/{u}",
    } for u in hits[:limit]]
    return {"q": q, "count": len(items), "total_match": len(hits), "items": items}


@router.get("/fan/{vtuber}/member/{uid}")
def member_detail(
    vtuber: str,
    uid: str,
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None, description="YYYY-MM-DD"),
    until: str | None = Query(None, description="YYYY-MM-DD"),
    ids: str | None = Query(None, description="窗口的场次清单（逗号分隔）"),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """单个池内用户的全部明细（2026-10-24）。

    含：总量（出席/弹幕/去重/付费/礼物/舰长/SC）、三轴分位、标签，
    以及**逐场序列**（该场弹幕数、付费、是否入场）—— 详情页的曲线用它。
    """
    since, until = _range_or_none(since, until)
    wanted = [x for x in (ids or "").split(",") if x]
    payload = _compute(vtuber, window, since, until, live_ids=wanted or None)
    table, win = payload["table"], payload["window"]
    if uid not in table.uids:
        raise HTTPException(404, "该用户不在当前名单里")

    u = win.users[uid]
    # 逐场切片走**窗口级索引**（2026-10-24）：原来每次都重读 75 个 raw，实测 5.9 s/次；
    # 现在每个窗口只扫一遍，之后任意用户 O(1)。
    _ids = [sr.live_id for sr in win.sessions]
    idx = member_index.get(win.vtuber.subdir, _ids)
    if idx is None:            # 兜底：老缓存或索引被清掉时再扫一遍
        idx = member_index.build(
            resolve_data_dir(), win.vtuber.subdir,
            [(sr.live_id, str(sr.start_at)) for sr in win.sessions],
        )
    series = [{
        "live_id": lid, "start_at": cn_text(start_at),
        "m": m, "p": p_, "e": e, "uniq": uq,
    } for row in idx.get(uid, [])
        # ⚠️ 切片已经多了一列时滞（第 7 位），这里必须按下标取前 6 个 ——
        # 直接 6 元解包会 ValueError，表现为"点开用户详情报错"（2026-10-25）
        for lid, start_at, m, p_, e, uq in (row[:6],)]

    return {
        "uid": uid,
        "name": u.name or "",
        "avatar": f"/fan/avatar/{uid}",
        "type": payload["labels"][uid],
        "strength": round(payload["strength"][uid], 6),
        "axis_percentiles": {a: round(table.pct[uid][a], 6) for a in AXES},
        "totals": {
            "att_sessions": u.att_n,
            "att_rate": round(u.att_n / max(1, win.n), 6),
            "msg_total": u.m,
            "msg_unique": u.uniq,
            "pay_total": round(u.pay, 2),
            "pay_share": round(payload["pay_share"].get(uid, 0.0), 8),
            "pay_rank": payload["pay_rank"].get(uid),
            "gift_cnt": u.gift_cnt,
            "guard_cnt": u.guard_cnt,
            "sc_cnt": u.sc_cnt,
            "sessions_with_pay": u.sc_sess,
            # ── 2026-10-24 用户要求补的字段 ──
            #: 总场次（分母）与场均弹幕（出席场次为分母）
            "window_sessions": win.n,
            "msg_per_session": round(u.m / max(1, u.att_n), 2),
            #: 场均入场时滞（分钟）：该用户最早事件 − 本场最早事件，按出席场次平均
            "mean_lag_minutes": round(u.mean_lag, 2) if u.mean_lag is not None else None,
            #: 付费拆解与每笔均值
            "gift_amt": round(u.gift_amt, 2),
            "guard_amt": round(u.guard_amt, 2),
            "sc_amt": round(u.sc_amt, 2),
            "pay_events": u.pay_events,
            "pay_per_event": round(u.pay / u.pay_events, 2) if u.pay_events else 0.0,
            #: 独轮车判定的证据强度：不同文本率（越低越像）、单条最大重复、是否够样本
            "variety": round(u.uniq / max(1, u.m), 4) if u.text_tracked else None,
            "maxrep": u.maxrep,
            "spam_rule": win.spam.get(uid),
            "first_seen": round(u.first_pos, 4),
            "last_seen": round(u.last_pos, 4),
            "max_repeat": u.maxrep,
        },
        "tags": payload["tags"].get(uid, []),
        "spam": win.spam.get(uid),
        #: 独轮车三档：none / suspected / confirmed（2026-10-25）
        "spam_level": win.spam_levels.get(uid, "none"),
        "window_sessions": win.n,
        "series": series,
    }


@router.get("/fan/{vtuber}/tags")
def tag_catalog(
    vtuber: str,
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None),
    until: str | None = Query(None),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """标签说明 + 占比。**标签不进排序**，这里只是给界面写说明。

    ⚠️ `prevalence` 的分母是**本窗口观测到的全部用户**，而 `ranked` 里的人数只算
    **入选池** —— 同一标签两处占比会不同。响应里两个分母都给了，界面上要说清用的哪个。
    """
    since, until = _range_or_none(since, until)
    payload = _compute(vtuber, window, since, until)
    prev = prevalence(payload["tags"])
    items = [{"name": name, "desc": desc, "prevalence": round(prev.get(name, 0.0), 6)}
             for name, desc in explain_tags()]
    return {"vtuber": payload["table"].vtuber, "window": window,
            "since": since, "until": until,
            "observed_users": len(payload["tags"]),
            "pool_users": len(payload["table"]),
            "denominator": "observed_users",
            "count": len(items), "items": items}


@router.get("/fan/{vtuber}/health")
def health(
    vtuber: str,
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None),
    until: str | None = Query(None),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """完整性判据汇总（C1–C4）。**没有外部源时全部标 unverified。**"""
    v = _resolve(vtuber)
    since, until = _range_or_none(since, until)
    win = load_window(v, window, since=since, until=until)
    if not win.sessions:
        raise HTTPException(404, f"{v.name} 在所选条件下没有可用场次")
    verdicts = check_window(win)
    return {
        "vtuber": v.name, "window": window, "since": since, "until": until,
        "checks": summarize_checks(verdicts),
        "notes": [
            "C1 内部恒等式不通过才会弃用场次（唯一弃用理由）",
            "C2~C4 与外部源的不一致只降级，绝不弃用",
            "没有接入外部源时 C3/C4 一律标 unverified —— 那不是本模型的问题",
        ],
        "warnings": win.warnings[:10],
    }


# ── 删除已采集数据（2026-10-19）────────────────────────────────────────────
class FanPurgeIn(BaseModel):
    """删除请求。**`dry_run` 默认 true** —— 与 `settings` 的 prune 端点同一口径：
    界面先拿一份"将要删什么"给用户看，确认后才带 `dry_run=false` 再来一次。
    """

    dry_run: bool = True
    #: `all` = 该 V 的全部已采数据；`window` = 只删 `since`~`until` 之间的
    scope: str = "all"
    since: str | None = None
    until: str | None = None


@router.post("/fan/{vtuber}/purge")
def fan_purge(
    vtuber: str,
    body: FanPurgeIn,
    db: Session = Depends(get_db),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """删除**已采集**的弹幕数据（不可恢复）。

    ⚠️ 三条安全约束：
    1. **只删该 V 子目录下 `raw/` `stats/` `names/` 里的文件**（按 live_id 逐个 unlink），
       不做任何 `rmtree` —— 目录结构、`meta.json`、其它 V 的数据都不动。
    2. `dry_run` 默认 **true**：不传就只算不删。
    3. `scope="window"` 时必须同时给 `since`/`until`，按 `stats` 里的 `start_at` 判断
       —— 与"窗口"的口径一致。

    删除后清进程内缓存（`_CACHE` / `_PLAN_CACHE`），否则界面还会显示已删掉的结果。
    """
    from app.models.vtuber import VTuber

    if body.scope not in ("all", "window"):
        raise HTTPException(400, f"未知范围 {body.scope!r}；可用：all / window")
    if body.scope == "window" and not (body.since and body.until):
        raise HTTPException(400, "scope=window 时必须同时给 since 与 until")
    if body.scope == "window" and str(body.since) > str(body.until):
        raise HTTPException(400, "起止日期反了")

    v = _resolve(vtuber, db)
    row = db.query(VTuber).filter(VTuber.name == v.name).first()
    if row is None:
        raise HTTPException(404, f"库里找不到主播：{v.name}")

    try:
        root = resolve_data_dir() / v.subdir
    except FanDataNotFound as exc:
        raise HTTPException(409, f"还没有任何分析数据根（{exc}）") from exc
    if not root.is_dir():
        raise HTTPException(409, f"该主播还没有已采集的数据：{v.subdir}")

    stats_dir = root / "stats"
    live_ids: list[str] = []
    if stats_dir.is_dir():
        for p in sorted(stats_dir.glob("*.json")):
            lid = p.stem
            if body.scope == "window":
                try:
                    d = json.loads(p.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                # 东八区日（与 /activity 的 days 键一致），否则跨零点的场次会落错一天
                day = cn_day(str(d.get("start_at") or ""))
                if not day or not (str(body.since) <= day <= str(body.until)):
                    continue
            live_ids.append(lid)

    by_dir: dict[str, dict[str, int]] = {}
    for sub in ("raw", "stats", "names"):
        d = root / sub
        if not d.is_dir():
            continue
        files = 0
        nbytes = 0
        targets = (d.glob("*.json") if body.scope == "all"
                   else (d / f"{lid}.json" for lid in live_ids))
        for p in targets:
            if not p.is_file():
                continue
            size = p.stat().st_size
            if not body.dry_run:
                try:
                    p.unlink()
                except OSError:
                    continue
            files += 1
            nbytes += size
        by_dir[sub] = {"files": files, "bytes": nbytes}

    total_files = sum(x["files"] for x in by_dir.values())
    total_bytes = sum(x["bytes"] for x in by_dir.values())

    if not body.dry_run:
        _CACHE.clear()
        _PLAN_CACHE.clear()
        logger.info("fan: 已删除 %s 的已采数据（%s）· %d 文件 / %.1f MB",
                    v.name, body.scope, total_files, total_bytes / 1048576)

    return {
        "vtuber": v.name,
        "dry_run": body.dry_run,
        "scope": body.scope,
        "root": str(root),
        "sessions": len(live_ids),
        "files": total_files,
        "bytes": total_bytes,
        "by_dir": by_dir,
        "deleted": not body.dry_run,
    }


def _as_utc(v: object) -> datetime | None:
    """SQLite 原生 SQL 拿回来的是字符串；按 **UTC** 解析成 `datetime`（带时区）。

    ⚠️ 必须显式给她 tz：库里存的是 UTC，直接 `astimezone()` 会按本地时区解释 —— 差 8 小时。
    """
    if v is None:
        return None
    s = str(v).strip().replace(" ", "T", 1)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


# ── 热力图 + 场次滑杆的数据源（V3/V4）─────────────────────────────────────
@router.get("/fan/{vtuber}/activity")
def fan_activity(
    vtuber: str,
    limit: int = Query(ACTIVITY_LIMIT, ge=25, le=5000,
                       description="滑杆取最近多少场（用户口径上限 150）"),
    since: str | None = Query(None, description="滑轨区间的起点 YYYY-MM-DD（含）"),
    until: str | None = Query(None, description="滑轨区间的终点 YYYY-MM-DD（含）"),
    db: Session = Depends(get_db),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """热力图与滑杆的**同一个**数据源。

    - `days`：全部历史按天聚合 —— `{"2026-07-05": {"n": 2, "c": 1}}`。
      `n` 是当天场次数（**热力图深浅只编码它**），`c` 是其中**弹幕已落盘**的场次数。
    - `recent`：最近 `limit` 场，时间正序 —— 滑杆逐场用。`c` 表示已采，
      `n` 是已采时的弹幕总量（未采为 0，前端画矮桩）。
    - `today`：服务器当天（`YYYY-MM-DD`）—— 灰格判定必须与后端同一天，不能各用各的。

    ⚠️ `c` 数的是**数据根里真有事实表**的场次，不是"库里有场次"。两者差得很远
    （试点只采了一批），这正是界面要告诉用户的。
    """
    from app.models.vtuber import VTuber

    v = _resolve(vtuber, db)
    row = db.query(VTuber).filter(VTuber.name == v.name).first()
    if row is None:
        raise HTTPException(404, f"库里找不到主播：{v.name}")

    # 已落盘的场次：live_id → 弹幕总量
    collected: dict[str, int] = {}
    try:
        stats_dir = resolve_data_dir() / v.subdir / "stats"
        if stats_dir.is_dir():
            for f in stats_dir.glob("*.json"):
                try:
                    d = json.loads(f.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                lid = d.get("live_id")
                if lid:
                    collected[str(lid)] = int(d.get("type0") or 0)
    except FanDataNotFound:
        pass

    # 全部历史：按天聚合场次数
    days: dict[str, dict[str, int]] = {}
    for d, n in db.execute(
        text(
            f"select {sql_day('s.start_at')} d, count(*) n "
            "from live_sessions s join accounts a on a.id = s.account_id "
            "where a.vtuber_id = :vid and a.platform = 'bilibili' "
            "  and s.start_at is not null "
            "  and s.session_key is not null and s.session_key != '' "
            "group by d order by d"
        ),
        {"vid": row.id},
    ):
        if d:
            days[str(d)] = {"n": int(n), "c": 0}

    # 最近 limit 场（倒序取，再翻正）
    #: 滑轨的**时间跨度**由界面选（2026-10-19 用户口径：区间 = 整条滑轨）；
    #: 值一律走绑定参数，不拼字符串。
    span = ""
    params: dict[str, Any] = {"vid": row.id, "lim": limit}
    if since:
        span += f" and {sql_day('s.start_at')} >= :since"
        params["since"] = since
    if until:
        span += f" and {sql_day('s.start_at')} <= :until"
        params["until"] = until
    rows = db.execute(
        text(
            # ⚠️ **只取采集器真能采的场次**：`live_id` 必须是 uuid 形态（`length > 20`），
            # 与 `loader.list_sessions_from_db` 的过滤一致。不加这一条，滑杆会把
            # 「库里有的场次」算进待采，而 `fanSessions` 只认可采的 ⇒ 界面自相矛盾
            # （实测：区间 75 场里 14 场 live_id 不是 uuid 形态，待采一个说 14、一个说 0）。
            "select s.live_id, s.start_at from live_sessions s "
            "join accounts a on a.id = s.account_id "
            "where a.vtuber_id = :vid and a.platform = 'bilibili' "
            "  and s.start_at is not null "
            "  and s.live_id is not null and length(s.live_id) > 20 "
            "  and s.session_key is not null and s.session_key != '' "
            + span +
            " order by s.start_at desc limit :lim"
        ),
        params,
    ).all()

    recent = []
    for lid, at in reversed(rows):
        iso = str(at or "")[:19]
        if not iso:
            continue
        n = collected.get(str(lid), 0) if lid else 0
        has = bool(lid) and str(lid) in collected
        # `d` = **东八区日**，由后端给出。前端原来用 `at.slice(0,10)`（UTC 日），
        # 跨零点的场次会差一天 —— 口径只在这里算一次。
        recent.append({"at": iso, "d": cn_day(iso), "c": has, "n": n,
                       "live_id": str(lid or "")})
        day = cn_day(iso)          # 角标也必须落在**同一天**的格子上（见上）
        if has and day in days:
            days[day]["c"] += 1

    # 逐场明细（2026-10-19）：热力图浮窗要显示**场次名称 / 时长 / 弹幕量 / 收益 / 峰值**。
    # ⚠️ 两个坑都在这儿踩过：
    #   ① 原生 SQL 返回的是**字符串**，`end_at - start_at` 会抛 TypeError —— 我第一版把它
    #      吞成 None，于是"明明有 end_at 却显示不出时长"（用户拿日历卡片对出来的）。
    #   ② 库里存的是 **UTC**，而日历卡片显示本地时间（18:59 而非 10:59）。这里统一转本地。
    detail: dict[str, list[dict[str, Any]]] = {}
    for d, title, start_at, end_at, cnt, income, peak, area, parent in db.execute(
        text(
            f"select {sql_day('s.start_at')} d, s.title, s.start_at, s.end_at, s.danmakus_count, "
            "       s.total_income, s.max_online_count, s.area_name, s.parent_area_name "
            "from live_sessions s join accounts a on a.id = s.account_id "
            "where a.vtuber_id = :vid and a.platform = 'bilibili' "
            "  and s.start_at is not null "
            "  and s.session_key is not null and s.session_key != '' "
            "order by s.start_at"
        ),
        {"vid": row.id},
    ):
        if not d:
            continue
        st = _as_utc(start_at)
        en = _as_utc(end_at)
        dur = int((en - st).total_seconds() // 60) if (st and en and en >= st) else None
        detail.setdefault(str(d), []).append({
            "title": str(title or ""),
            # 展示一律按**业务时区**（东八区），不用 `astimezone()` 的机器时区 ——
            # 服务端换个时区跑，浮现的时间就不该变。
            "at": st.astimezone(CN_TZ).strftime("%Y-%m-%d %H:%M") if st
                   else cn_day(str(start_at)) + " " + str(start_at)[11:16],
            "end": en.astimezone(CN_TZ).strftime("%H:%M") if en else "",
            # 时长（分钟）；拿不到就是 None —— **不猜**
            "dur": dur,
            "m": int(cnt or 0),
            "income": round(float(income), 1) if income is not None else None,
            "peak": int(peak) if peak is not None else None,
            "area": " / ".join(x for x in (str(parent or ""), str(area or "")) if x),
        })

    return {
        "vtuber": v.name,
        "today": datetime.now(CN_TZ).date().isoformat(),   # 业务时区的"今天"，与分天口径一致
        "years": sorted({int(k[:4]) for k in days}),
        "days": days,
        "recent": recent,
        "detail": detail,
        "limit": limit,
    }


# ── 档案卡（V2）────────────────────────────────────────────────────────────
@router.get("/fan/{vtuber}/profile")
def fan_profile(
    vtuber: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """工作台档案卡要的那一份：**V 的身份 + 分析可用性**。

    `vtuber` 直接复用 `app.routers.vtuber._vtuber_out`（头像 / 本地副本 / 背景 / 取景 /
    企划 / 签名都在里面）—— 不另造序列化，否则"工作台的头像"和"左栏的头像"会分叉。

    `stats` 是**算出来的**，不落库：

    | 字段 | 定义 |
    |---|---|
    | `followers` | 最新一条 `account_stat_snapshots.followers_count`（多账号取最大） |
    | `total_sessions` | `live_sessions` 里该 V 的 B 站场次数（有 `start_at` 的） |
    | `collected` | 数据根里**已落盘**的场次数（`stats/*.json`） |
    | `first` / `last` | 场次日期的首末 |
    | `coverage` | `collected / total_sessions`（0~1） |

    ⚠️ `collected` 数的是**数据根里真有的事实表**，不是"库里有场次" ——
    两者差得很远（试点只采了一批），这正是卡片要告诉用户的。
    """
    from app.models.vtuber import VTuber
    from app.routers.vtuber import _vtuber_out

    v = _resolve(vtuber, db)
    row = db.query(VTuber).filter(VTuber.name == v.name).first()
    if row is None:
        raise HTTPException(404, f"库里找不到主播：{v.name}")

    base = _vtuber_out(db, row)

    # 场次总数与首末日期（只算 B 站账号；跨平台场次不是一回事）
    row_data = db.execute(
        text(
            f"select count(*), min({sql_day('s.start_at')}), max({sql_day('s.start_at')}) "
            "from live_sessions s join accounts a on a.id = s.account_id "
            "where a.vtuber_id = :vid and a.platform = 'bilibili' "
            "  and s.start_at is not null "
            "  and s.session_key is not null and s.session_key != ''"
        ),
        {"vid": row.id},
    ).one()
    total = int(row_data[0] or 0)

    fans = db.execute(
        text(
            "select max(s.followers_count) from account_stat_snapshots s "
            "join accounts a on a.id = s.account_id "
            "where a.vtuber_id = :vid and a.platform = 'bilibili' "
            "  and s.followers_count is not null"
        ),
        {"vid": row.id},
    ).scalar()

    # 已落盘：数据根里该 V 的 stats 文件数（= 真能算分析的场次数）
    collected = 0
    try:
        stats_dir = resolve_data_dir() / v.subdir / "stats"
        if stats_dir.is_dir():
            collected = len(list(stats_dir.glob("*.json")))
    except FanDataNotFound:
        collected = 0

    # 头像的解析链要 `accounts`（`resolveAvatarSources` 的第 ②~⑤ 级全在账号上）。
    # 不带上它，前端只能读 `vtubers.avatar` 这个**覆盖**字段 —— 它本来就多半是空的。
    from app.schemas.vtuber import AccountOut

    accounts = [AccountOut.model_validate(a) for a in (row.accounts or [])]
    return {
        "vtuber": base.model_dump(),
        "accounts": [a.model_dump() for a in accounts],
        "stats": {
            "followers": int(fans) if fans else None,
            "total_sessions": total,
            "collected": collected,
            "first": row_data[1],
            "last": row_data[2],
            "coverage": round(collected / total, 4) if total else 0.0,
        },
    }


# ── 时间动态（L6）──────────────────────────────────────────────────────────
@router.get("/fan/{vtuber}/timeline")
def timeline(
    vtuber: str,
    n: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    size: int = Query(TIMELINE_SIZE, ge=5, le=100, description="滑动窗的场次数"),
    step: int = Query(TIMELINE_STEP, ge=1, le=100, description="相邻窗的步长（场）"),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """滑动窗 → 分层序列 → 迁移矩阵 → 换血率/半衰期（L6）。

    ⚠️ **三个必须一起读的东西**（少一个就会误读）：

    1. **层级在窗内按分位切** ⇒ 每层规模是固定比例（核心 20%）。所以"核心层 80% 下一窗还在
       核心"**不能直接读成强留存** —— 独立假设下也有约 20% 落在对角线。判据是 `lift`。
    2. **第 4 个状态「未观测」**：在 t 窗入池、t+1 窗没入池。它**不等于"降到外层"**
       —— 把两者混起来会把"停止观看"和"看得少了"当成一件事。
    3. **半衰期只在指数衰减成立时才可信**。实测三条曲线全都先掉后平，所以同时给 `r2`
       与 `plateau`；`r2 < 0.9` 时半衰期只是粗估。

    代价：每个窗口都要重读一遍 raw ⇒ 单次约 10~30 秒（结果进进程内缓存）。
    """
    from itertools import pairwise

    v = _resolve(vtuber, _LAST_DB.get("db"))
    key = ("timeline", v.subdir, n, size, step)
    hit = _CACHE.get(key)
    if hit is not None:
        return hit

    try:
        snaps, full = build_windows(v, n, size=size, step=step)
    except TimelineError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FanDataNotFound as exc:
        raise HTTPException(
            404,
            "还没有任何分析数据。请在工作台里选一个主播和时间区间，点「开始采集」；"
            f"首采需要几分钟。（{exc}）",
        ) from exc

    trans = [transition(a, b) for a, b in pairwise(snaps)]
    summary = summarize_timeline(snaps)

    payload = {
        "vtuber": v.name,
        "spec": {"size": size, "step": step, "total_sessions": full.n,
                 "tiers": list(TIERS_WITH_UNSEEN), "max_lag": MAX_LAG},
        "coverage": {"first_date": snaps[0].first_date, "last_date": snaps[-1].last_date},
        "windows": [s.meta() for s in snaps],
        "transitions": [
            {
                "from": t.from_index, "to": t.to_index,
                "union": t.union,
                "counts": t.counts,
                "expected": {ra: {cb: round(x, 2) for cb, x in row.items()}
                             for ra, row in t.expected.items()},
                "lift": {ra: {cb: round(x, 3) for cb, x in row.items()}
                         for ra, row in t.lift.items()},
                "core": {
                    "retention_raw": round(t.retention(TIER_CORE), 4),
                    "lift": round(t.diagonal_lift(TIER_CORE), 3),
                    "churn": round(t.churn(TIER_CORE), 4),
                },
            }
            for t in trans
        ],
        "summary": summary,
        "tails": {tier: survival(snaps, tier).meta() for tier in TIERS_WITH_UNSEEN[:3]},
        "notes": [
            "层级在窗内按分位切 ⇒ 每层规模固定；判据看 lift，不看对角线",
            "「未观测」= 下一窗没入池，不等于降到外层",
            "半衰期只在指数衰减成立时才可信；看 r2 与 plateau",
            "窗口有重叠（step < size）⇒ 相邻迁移不是独立观测",
        ],
    }
    _CACHE[key] = payload
    logger.info("fan: 已算 %s 的 L6（%s 窗，size=%s step=%s）", v.name, len(snaps), size, step)
    return payload


# ── 跨 V ────────────────────────────────────────────────────────────────────
@router.get("/fan/{vtuber}/ranked.csv")
def ranked_csv(
    vtuber: str,
    by: str = Query(..., description="排序口径（与 /ranked 一致）"),
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None),
    until: str | None = Query(None),
    ids: str | None = Query(None, description="窗口的场次清单（逗号分隔）"),
    tags: str | None = Query(None, description="标签过滤（逗号分隔，与语义）"),
    _: None = Depends(require_module),
) -> Response:
    """导出当前口径的**完整名单**为 CSV（2026-10-28）。

    为什么在后端出而不是前端拼：口径、排序、标签过滤、`ids` 窗口都要与页面**完全一致**，
    前端只有分页加载的那 20 行；后端能一次给全量（上限 `MAX_LIMIT`）。
    """
    payload = ranked(vtuber=vtuber, by=by, window=window, since=since, until=until,
                     limit=MAX_LIMIT, offset=0, ids=ids, tags=tags, _=None)
    items = list(payload.get("items") or ())
    body = ranked_csv_bytes(items)
    label = _BY_LABEL.get(by, by)
    day = datetime.now(CN_TZ).strftime("%Y%m%d")
    name = f"{payload.get('short') or vtuber}-{day}-{label}.csv"
    return Response(
        content=body, media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"},
    )


@router.get("/fan/compare/multi")
def compare_multi(
    vtubers: str = Query(..., description="逗号分隔的 2–6 个主播（显示名或简称）"),
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None),
    until: str | None = Query(None),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """多个 V 的**两两名单重叠**（对比页 · 多主播模式，2026-10-28）。

    与 `/fan/cross` 同口径，只是扩到 N 个：N(N-1)/2 个配对，p 值做 **BH 校正**。
    ⚠️ 仍然**不返回分数比较**（跨 V 测量不变性已否证），只给层级与重叠。
    """
    from app.services.fan.cross_v import (bh_adjust, describe, overlap,
                                          profile as cross_profile, tier_moves)

    names = [x.strip() for x in (vtubers or "").split(",") if x.strip()]
    if not 2 <= len(names) <= 6:
        raise HTTPException(400, f"需要 2–6 个主播（收到 {len(names)} 个）：{names}")
    if len(set(names)) != len(names):
        raise HTTPException(400, "主播重复了，请去掉重复项")

    since, until = _range_or_none(since, until)
    profs = []
    info: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for n in names:
        try:
            payload = _compute(n, window, since, until)
        except Exception as exc:  # noqa: BLE001 —— 该 V 还没采/没数据：**逐 V 标注**，不拖垮整次请求
            missing.append({"name": n, "reason": str(exc)[:120]})
            continue
        prof = cross_profile(payload["window"])
        profs.append(prof)
        info.append({"name": prof.name, "short": prof.short, "pool": len(prof.pool),
                     "sessions": prof.n_sessions, "tiers": prof.counts()})

    if len(profs) < 2:
        return {"window": window, "since": since, "until": until,
                "vtubers": info, "matrix": [], "pairs": [], "missing": missing,
                "needs_analysis": [m["name"] for m in missing],
                "notes": ["可分析的不足两个主播：先采集并分析缺失的主播，再来对比"]}

    pairs: list[dict[str, Any]] = []
    raw_p: list[float] = []
    for i in range(len(profs)):
        for j in range(i + 1, len(profs)):
            ov = overlap(profs[i], profs[j])
            raw_p.append(ov.p_value)
            pairs.append({"i": i, "j": j, "ov": ov})
    adj = bh_adjust(raw_p)

    out_pairs = []
    for idx, item in enumerate(pairs):
        i, j, ov = item["i"], item["j"], item["ov"]
        out_pairs.append({
            "a": profs[i].short, "b": profs[j].short,
            "a_name": profs[i].name, "b_name": profs[j].name,
            "size_a": ov.size_a, "size_b": ov.size_b,
            "intersection": ov.intersection,
            "jaccard": round(ov.jaccard, 6),
            "lift": round(ov.lift, 4),
            "p_value": ov.p_value, "p_adjusted": adj[idx],
            "p_value_lower": ov.p_value_lower,
            "is_enriched": ov.is_enriched and adj[idx] < 0.05,
            "is_depleted": ov.is_depleted,
            "tier_table": ov.tiers,
            "tier_moves": tier_moves(profs[i], profs[j]),
            "reading": describe(ov),
        })

    # 方阵（对称）：非对角放该配对在 `pairs` 里的下标，前端点格子下钻
    n = len(profs)
    matrix = [[None] * n for _ in range(n)]
    for idx, item in enumerate(pairs):
        i, j = item["i"], item["j"]
        cell = {"pair": idx, "jaccard": out_pairs[idx]["jaccard"],
                "lift": out_pairs[idx]["lift"], "shared": out_pairs[idx]["intersection"]}
        matrix[i][j] = cell
        matrix[j][i] = cell

    return {
        "window": window, "since": since, "until": until,
        "vtubers": info,
        "missing": missing,
        "needs_analysis": [m["name"] for m in missing],
        "matrix": matrix,
        "pairs": out_pairs,
        "notes": [
            "只比层级，不比分数：跨 V 的绝对阈值不可移植",
            f"共 {len(out_pairs)} 个配对，p 值已做 BH 校正（FDR）",
        ],
    }


@router.get("/fan/cross")
def cross(
    vtubers: str = Query(..., description="逗号分隔的两个主播（显示名或简称）"),
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None),
    until: str | None = Query(None),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """两个 V 的名单重叠 + **超几何零模型**。

    ⚠️ **不返回分数比较** —— 跨 V 的测量不变性已被否证（§5.5），本接口只给层级与重叠。
    ⚠️ **零模型是必选的**：判读要看 `lift` 与**两个方向**的尾概率
    （`p_value` 上尾 = 富集 / `p_value_lower` 下尾 = 贫化）。
    """
    from app.services.fan.cross_v import describe, overlap, profile as cross_profile, tier_moves

    names = [x.strip() for x in (vtubers or "").split(",") if x.strip()]
    if len(names) != 2:
        raise HTTPException(400, f"需要正好两个主播（收到 {len(names)} 个）：{names}")
    since, until = _range_or_none(since, until)
    profs = []
    for n in names:
        payload = _compute(n, window, since, until)
        profs.append(cross_profile(payload["window"]))
    ov = overlap(profs[0], profs[1])
    return {
        "window": window, "since": since, "until": until,
        "a": {"name": ov.a, "pool": ov.size_a, "tiers": profs[0].counts()},
        "b": {"name": ov.b, "pool": ov.size_b, "tiers": profs[1].counts()},
        "overlap": {
            "intersection": ov.intersection, "population": ov.population,
            "expected": round(ov.expected, 3), "lift": round(ov.lift, 4),
            "p_value": ov.p_value, "p_value_lower": ov.p_value_lower,
            "share_of_a": round(ov.share_of_a, 6), "share_of_b": round(ov.share_of_b, 6),
            "jaccard": round(ov.jaccard, 6),
            "is_enriched": ov.is_enriched, "is_depleted": ov.is_depleted,
        },
        "tier_table": ov.tiers,
        "tier_moves": tier_moves(profs[0], profs[1]),
        "reading": describe(ov),
        "notes": [
            "只比层级，不比分数：跨 V 的绝对阈值不可移植（三轴 75 分位最多差 4.2 倍）",
            "population 取两 V 入选者的并集 —— 不用全库，因为全库会随库增长而漂移",
            "同企划 / 常联动的 V 之间重叠天然更高，那不是粉丝结构的发现",
        ],
    }
