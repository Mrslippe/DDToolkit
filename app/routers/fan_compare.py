"""对比页 · 帖子评论模式的后端接线（2026-10-28，P3）。

三段式：

```
POST /fan/compare/scan          → {scan_id}            （后台跑，不阻塞）
GET  /fan/compare/scan/{id}     → 进度 + 目标元信息
GET  /fan/compare/scan/{id}/users → 评论名单（按评论数排序）
GET  /fan/compare/comment-overlap → 与某 V 的核心度名单做重叠度分析
```

存储：`<数据根>/_compare/scans/<scan_id>.json`（快照，不进数据库 —— 与 fan 的 raw/stats 同思路）。
"""

from __future__ import annotations

import asyncio
import logging
import math
import threading
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class ScanIn(BaseModel):
    input: str = Field(..., description="动态/视频链接、BV 号或 av 号")
    with_sub: bool = Field(True, description="是否抓楼中楼（更全，但请求数增加）")
    max_pages: int = Field(150, ge=1, le=1000, description="主楼最多抓多少页（20 条/页）")


def overlap_stats(tier: dict[str, str], strength: dict[str, float],
                  users: list[dict[str, Any]], *, top_n: int = 500) -> dict[str, Any]:
    """评论名单 × 核心度名单的**纯计算**（不碰网络/文件，便于单测）。

    Returns: `{overlap, tiers, shared}`。
    """
    from app.services.fan.cross_v import hypergeom_cdf, hypergeom_sf

    ranked = set(tier)
    picked = users[:top_n]
    comment = {str(u["uid"]): int(u.get("cnt") or 0) for u in picked}
    inter = ranked & set(comment)
    union = ranked | set(comment)
    pop, ka, kb = len(union), len(ranked), len(comment)
    expected = (ka * kb / pop) if pop else 0.0
    lift = (len(inter) / expected) if expected > 0 else 0.0
    p_up = hypergeom_sf(len(inter), pop, ka, kb) if pop else 0.0
    p_low = hypergeom_cdf(len(inter), pop, ka, kb) if pop else 0.0

    buckets: dict[str, dict[str, int]] = {}
    for uid in ranked:
        t = tier.get(uid, "外层")
        b = buckets.setdefault(t, {"hit": 0, "miss": 0})
        b["hit" if uid in comment else "miss"] += 1

    shared = [{
        "uid": uid, "name": u.get("name") or "",
        "cnt": int(u.get("cnt") or 0), "sub_cnt": int(u.get("sub_cnt") or 0),
        "tier": tier.get(uid, "外层"), "s": round(strength.get(uid, 0.0), 6),
    } for u in picked for uid in [str(u["uid"])] if uid in ranked]
    shared.sort(key=lambda x: -x["cnt"])

    return {
        "overlap": {
            "shared": len(inter),
            "jaccard": round(len(inter) / len(union), 6) if union else 0.0,
            "lift": round(lift, 4), "expected": round(expected, 3),
            "p_value": p_up, "p_value_lower": p_low,
            "is_enriched": p_up < 0.05 and lift > 1.0,
            "is_depleted": p_low < 0.05 and lift < 1.0,
        },
        "tiers": buckets,
        "shared": shared,
    }


def build_router(*, deps: dict[str, Any]) -> APIRouter:
    """用依赖注入的方式建路由，避免和 `fan.py` 里的私有状态互相 import。"""
    router = APIRouter()
    resolve_data_dir = deps["resolve_data_dir"]
    compute = deps["compute"]

    #: 正在跑的任务：scan_id → 状态对象
    tasks: dict[str, Any] = {}
    #: 取消标记
    stops: dict[str, bool] = {}

    def _start(payload: ScanIn) -> dict[str, Any]:
        from app.services import bili_replies as br

        root = resolve_data_dir()
        st = br.ScanState(scan_id=__import__("uuid").uuid4().hex[:12], input=payload.input)
        tasks[st.scan_id] = st
        stops[st.scan_id] = False
        br.save(st, root)  # 先落一份 queued 快照，前端一进来就能看到它

        def _run() -> None:
            import asyncio as _a

            try:
                logger.info("对比页：开始抓取评论 input=%r with_sub=%s max_pages=%s",
                            payload.input, payload.with_sub, payload.max_pages)
                _a.run(br.run_scan(
                    payload.input, root=root, with_sub=payload.with_sub, state=st,
                    should_stop=lambda: stops.get(st.scan_id, False),
                    max_pages=payload.max_pages,
                ))
            except Exception:  # noqa: BLE001 —— run_scan 内部已兜，这里只是最后一道
                logger.exception("评论抓取任务异常")
                st.state, st.error = "failed", "抓取任务异常（详见日志）"

        threading.Thread(target=_run, name=f"comment-scan-{st.scan_id}", daemon=True).start()
        return {"scan_id": st.scan_id, "state": st.state}

    @router.post("/fan/compare/scan")
    def start_scan(payload: ScanIn, _: None = Depends(deps["require_module"])) -> dict[str, Any]:
        """发起一次评论抓取（后台任务，立即返回 scan_id）。"""
        try:
            from app.services import bili_replies as br

            br.parse_target(payload.input)  # 先做一次本地校验，输入错就别起任务
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return _start(payload)

    @router.get("/fan/compare/scan/{scan_id}")
    def scan_status(scan_id: str, _: None = Depends(deps["require_module"])) -> dict[str, Any]:
        from app.services import bili_replies as br

        st = tasks.get(scan_id)
        if st is not None:
            return st.as_dict()
        snap = br.load(scan_id, resolve_data_dir())
        if not snap:
            raise HTTPException(404, f"没有这个抓取任务：{scan_id}")
        return {k: v for k, v in snap.items() if k != "users"}

    @router.post("/fan/compare/scan/{scan_id}/cancel")
    def cancel_scan(scan_id: str, _: None = Depends(deps["require_module"])) -> dict[str, Any]:
        if scan_id not in tasks:
            raise HTTPException(404, f"没有这个抓取任务：{scan_id}")
        stops[scan_id] = True
        return {"ok": True}

    @router.get("/fan/compare/scan/{scan_id}/users")
    def scan_users(
        scan_id: str,
        limit: int = Query(2000, ge=1, le=20000),
        _: None = Depends(deps["require_module"]),
    ) -> dict[str, Any]:
        from app.services import bili_replies as br

        st = tasks.get(scan_id)
        if st is not None and st.users:
            users = st.users
        else:
            snap = br.load(scan_id, resolve_data_dir())
            if not snap:
                raise HTTPException(404, f"没有这个抓取任务：{scan_id}")
            users = snap.get("users") or []
        return {"count": len(users), "items": users[:limit]}

    @router.get("/fan/compare/comment-overlap")
    def comment_overlap(
        scan_id: str = Query(..., description="抓取任务 id"),
        vtuber: str = Query(..., description="与之对比的主播（当前分析的那个）"),
        window: int = Query(deps["default_window"], ge=deps["min_window"], le=deps["max_window"]),
        since: str | None = Query(None),
        until: str | None = Query(None),
        top_n: int = Query(500, ge=10, le=5000, description="取评论名单的前 N 名做对比"),
        _: None = Depends(deps["require_module"]),
    ) -> dict[str, Any]:
        """评论名单 × 核心度名单：重叠 + 超几何零模型 + Top-N 覆盖曲线。"""
        from app.services import bili_replies as br
        from app.services.fan.cross_v import hypergeom_cdf, hypergeom_sf, profile as cross_profile

        st = tasks.get(scan_id)
        if st is not None and st.users:
            users = st.users
            meta = st.as_dict()
        else:
            snap = br.load(scan_id, resolve_data_dir())
            if not snap:
                raise HTTPException(404, f"没有这个抓取任务：{scan_id}")
            users = snap.get("users") or []
            meta = {k: v for k, v in snap.items() if k != "users"}

        if not users:
            raise HTTPException(409, "这次抓取没有拿到任何评论（可能被风控或帖子无评论）")

        try:
            payload = compute(vtuber, window, since, until)
        except Exception as exc:  # noqa: BLE001 —— 没采/没数据：给可读的 409，不是 500 堆栈
            logger.warning("对比失败：%s（vtuber=%s）", type(exc).__name__, vtuber)
            raise HTTPException(409, f"{vtuber} 还没有可用的分析结果：{exc}") from exc
        prof = cross_profile(payload["window"])
        stats = overlap_stats(prof.tier, prof.strength, users, top_n=top_n)

        # Top-N 覆盖：名单前 N 名里命中评论用户的比例
        comment = {str(u["uid"]) for u in users[:top_n]}
        # ⚠️ `_compute` 的返回值里**没有** `items`（那是 `/ranked` 追加的），
        # 这里必须直接用 `prof.strength`（uid → 强度）。2026-10-28 就是这行 KeyError
        # 让 `/fan/compare/comment-overlap` 整条 500。
        order = sorted(prof.strength.items(), key=lambda kv: -kv[1])
        cov: list[dict[str, Any]] = []
        hit = 0
        for i, (uid, _s) in enumerate(order[:1000], start=1):
            if uid in comment:
                hit += 1
            if i in (10, 25, 50, 100, 200, 500, 1000):
                cov.append({"n": i, "hit": round(hit / i, 4), "count": hit})

        return {
            "scan": meta,
            "ranked": {"vtuber": vtuber, "window": window, "pool": len(prof.tier)},
            "overlap": stats["overlap"],
            "coverage": cov,
            "tiers": stats["tiers"],
            "shared": stats["shared"][:500],
            "notes": [
                "只比层级与集合重叠，不比分数：跨来源的绝对阈值不可移植",
                f"评论名单取前 {top_n} 名；名单池 {len(prof.tier)} 人",
            ],
        }

    return router
