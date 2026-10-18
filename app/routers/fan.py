"""数据分析工作台端点（P3/P4 + 采集，2026-10-18）。

只读分析部分全部从数据根的 JSON 事实表现算，**不写库**；采集部分只写数据根。
模型定义见 `docs/plans/fan-model-spec.md`；施工阶段见 `docs/plans/fan-model-execution.md`。

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
import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.routers.settings import PREFS_PREFIX
from app.services.fan import (
    AXES,
    PURITY_THRESHOLD,
    FanDataError,
    FanDataNotFound,
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
from app.services.fan.criterion import CRITERIA, fit as fit_criterion, score as score_criterion
from app.services.fan.loader import resolve_data_dir
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
SORT_BY = (SORT_BY_STRENGTH,) + CRITERIA

DEFAULT_LIMIT = 100
MAX_LIMIT = 5000
MIN_WINDOW = 5
MAX_WINDOW = 200
DEFAULT_WINDOW = 75
#: 滑杆取最近多少场（用户口径：总量上限 150 场，2026-10-18）
ACTIVITY_LIMIT = 150
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
    """按名字/简称/mid 取 V。清单是**动态的**（来自库里的 B 站账号），不是硬编码三个样本。"""
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
def _compute(vtuber_name: str, window: int, since: str | None = None,
             until: str | None = None) -> dict[str, Any]:
    """加载并算出三轴 + 强度 + 类型 + 标签。按 `(主播, 窗口, 区间)` 记忆化。"""
    v = _resolve(vtuber_name, _LAST_DB.get("db"))
    key = (v.subdir, window, since, until)
    hit = _CACHE.get(key)
    if hit is not None:
        return hit

    try:
        win = load_window(v, window, since=since, until=until)
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
    table = build_axis_table(win)
    if len(table) == 0:
        raise HTTPException(404, f"{v.name} 在所选条件下没有达到入选门槛的观众")

    payload = {
        "window": win, "table": table,
        "strength": participation_strength(table),
        "labels": type_label(table),
        "tags": tag_all(win, table),
        "since": since, "until": until,
    }
    _CACHE[key] = payload
    logger.info("fan: 已计算 %s（%s 场 · 区间 %s~%s）→ %s 人入池",
                v.name, win.n, since or "…", until or "…", len(table))
    return payload


def clear_cache() -> None:
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
@router.get("/fan/{vtuber}/ranked")
def ranked(
    vtuber: str,
    by: str | None = Query(None, description="排序口径：strength / retention / income（**必填**）"),
    window: int = Query(DEFAULT_WINDOW, ge=MIN_WINDOW, le=MAX_WINDOW),
    since: str | None = Query(None, description="YYYY-MM-DD"),
    until: str | None = Query(None, description="YYYY-MM-DD"),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    _: None = Depends(require_module),
) -> dict[str, Any]:
    """名单。`by` 是**必填**的 —— 不提供默认口径。"""
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
    payload = _compute(vtuber, window, since, until)
    order = rank(payload["table"], _primary(payload, by))

    table, tags, labels, win = (payload["table"], payload["tags"],
                                payload["labels"], payload["window"])
    rows = []
    for pos, uid in enumerate(order[:limit], 1):
        p = table.pct[uid]
        u = win.users.get(uid)
        rows.append({
            "rank": pos, "uid": uid, "type": labels[uid],
            "strength": round(payload["strength"][uid], 6),
            "axis_percentiles": {a: round(p[a], 6) for a in AXES},
            "att_sessions": u.att_n if u else 0,
            "att_rate": round(u.att_n / max(1, win.n), 6) if u else 0.0,
            "pay_total": round(table.tie[uid]["pay"], 2),
            "msg_total": int(table.tie[uid]["msg"]),
            "tags": tags.get(uid, []),
        })

    return {
        "vtuber": table.vtuber, "window": window, "sessions": win.n,
        "since": since, "until": until, "by": by,
        "purity_threshold": PURITY_THRESHOLD,
        "total_in_pool": len(table), "count": len(rows), "items": rows,
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
                day = str(d.get("start_at") or "")[:10]
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


# ── 热力图 + 场次滑杆的数据源（V3/V4）─────────────────────────────────────
@router.get("/fan/{vtuber}/activity")
def fan_activity(
    vtuber: str,
    limit: int = Query(ACTIVITY_LIMIT, ge=25, le=500,
                       description="滑杆取最近多少场（用户口径上限 150）"),
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
            "select date(s.start_at) d, count(*) n "
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
            "order by s.start_at desc limit :lim"
        ),
        {"vid": row.id, "lim": limit},
    ).all()

    recent = []
    for lid, at in reversed(rows):
        iso = str(at or "")[:19]
        if not iso:
            continue
        n = collected.get(str(lid), 0) if lid else 0
        has = bool(lid) and str(lid) in collected
        recent.append({"at": iso, "c": has, "n": n})
        day = iso[:10]
        if has and day in days:
            days[day]["c"] += 1

    return {
        "vtuber": v.name,
        "today": date.today().isoformat(),
        "years": sorted({int(k[:4]) for k in days}),
        "days": days,
        "recent": recent,
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
            "select count(*), min(date(s.start_at)), max(date(s.start_at)) "
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
