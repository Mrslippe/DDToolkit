"""采集后的**质量闸**：把"静默失败"变成"明确标记"。

三层对账（对应 `plans/fan-model-plan.md` §质量闸）：

| 层 | 对账对象 | 抓什么 |
|---|---|---|
| L1 | 自己的 `type_hist` 求和 vs `records` | 聚合写错 |
| L2 | 平台 `danmakusCount` / `totalIncome` | 抓取截断、收入缺失 |
| L3 | vtb.cat 的 `Message` / `Money` | 我们漏采（**仅当 vtb 自己也收得够多**） |

## 处置口径（沿用 2026-10-17 的定案）

**只标记，不丢弃。** 外部源只是校验器：它比我们少是常态（danmakus 是严格超集），
只有"**我们比对方少 10% 以上**且对方收得足够多"才说明我们可能漏了。
"""

from __future__ import annotations

from app.services.externals.vtbcat import MIN_VTB_MESSAGES

#: 我们认为"覆盖够"的门槛
COVER_FLOOR = 0.90

#: 状态（按严重程度排序，取最严重的那个作为该场结论）
STATUS_ORDER = ("ok", "no_external", "low_coverage", "low_income", "inconsistent")


def _ratio(ours: float, other: float) -> float | None:
    if not other or other <= 0:
        return None
    return ours / other


def evaluate(*, stats: dict, platform: dict | None = None, vtb: dict | None = None) -> dict:
    """返回 `{"status": ..., "checks": {...}}`。

    - `platform`：本次采集同时拿到的平台聚合（`danmakus_count` / `income`）；
    - `vtb`：`externals.vtbcat.match_session()` 匹配到的那条。
    """
    checks: dict[str, object] = {}
    status = "ok"

    # ── L1 内部自洽 ──
    hist = stats.get("type_hist") or {}
    type_sum = sum(int(v or 0) for v in hist.values())
    records = int(stats.get("records") or 0)
    checks["type_sum"] = type_sum
    checks["type_sum_ok"] = (type_sum == records)
    if not checks["type_sum_ok"]:
        status = "inconsistent"

    ours_m = int(stats.get("type0") or 0)
    ours_pay = float(stats.get("sum_price") or 0.0)

    # ── L2 平台计数 ──
    if platform:
        plat_m = int(platform.get("danmakus_count") or 0)
        if plat_m > 0:
            r = _ratio(ours_m, plat_m)
            checks["platform_message_ratio"] = round(r, 3) if r is not None else None
            # 平台给的是"平台自己数的弹幕"，我们比它少说明抓取截断
            if r is not None and r < COVER_FLOOR and status == "ok":
                status = "low_coverage"
        plat_inc = float(platform.get("income") or 0.0)
        if plat_inc > 0:
            r = _ratio(ours_pay, plat_inc)
            checks["platform_income_ratio"] = round(r, 3) if r is not None else None
            if r is not None and r < COVER_FLOOR and status == "ok":
                status = "low_income"

    # ── L3 vtb.cat ──
    if vtb:
        vtb_m = int(vtb.get("Message") or 0)
        if vtb_m >= MIN_VTB_MESSAGES:
            r = _ratio(ours_m, vtb_m)
            checks["vtb_message_ratio"] = round(r, 3) if r is not None else None
            # 只有"我们更少"才可疑；我们更多是正常的（danmakus 是超集）
            if r is not None and r < COVER_FLOOR and status == "ok":
                status = "low_coverage"
        vtb_inc = float(vtb.get("Money") or 0.0)
        if vtb_inc >= 1.0:
            r = _ratio(ours_pay, vtb_inc)
            checks["vtb_income_ratio"] = round(r, 3) if r is not None else None
            if r is not None and r < COVER_FLOOR and status == "ok":
                status = "low_income"
        checks["vtb_matched"] = True
    else:
        checks["vtb_matched"] = False
        if status == "ok":
            status = "no_external"

    checks["ours_messages"] = ours_m
    checks["ours_income"] = round(ours_pay, 2)
    return {"status": status, "checks": checks}


def summary(qualities: list[dict]) -> dict[str, int]:
    """按状态汇总，便于采集结束时打印一行。"""
    out: dict[str, int] = {}
    for q in qualities:
        s = str(q.get("status") or "ok")
        out[s] = out.get(s, 0) + 1
    return out
