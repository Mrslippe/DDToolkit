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

    # ── L2/L3 联合判定 ──
    # 单独一层的"少"不足以定罪（2026-10-21 抽查：17 场里 13 场是单侧误报）。
    # 规则：平台与 vtb 都指出"我们少"才算 low_coverage；只有一边说，就标 *_suspect（不降级）。
    plat_ratio = None
    vtb_ratio = None
    plat_inc_ratio = None
    vtb_inc_ratio = None

    if platform:
        plat_m = int(platform.get("danmakus_count") or 0)
        if plat_m > 0:
            plat_ratio = _ratio(ours_m, plat_m)
            checks["platform_message_ratio"] = round(plat_ratio, 3) if plat_ratio else None
        plat_inc = float(platform.get("income") or 0.0)
        if plat_inc > 0:
            plat_inc_ratio = _ratio(ours_pay, plat_inc)
            checks["platform_income_ratio"] = round(plat_inc_ratio, 3) if plat_inc_ratio else None

    if vtb:
        vtb_m = int(vtb.get("Message") or 0)
        if vtb_m >= MIN_VTB_MESSAGES:
            vtb_ratio = _ratio(ours_m, vtb_m)
            checks["vtb_message_ratio"] = round(vtb_ratio, 3) if vtb_ratio else None
        vtb_inc = float(vtb.get("Money") or 0.0)
        if vtb_inc >= 1.0:
            vtb_inc_ratio = _ratio(ours_pay, vtb_inc)
            checks["vtb_income_ratio"] = round(vtb_inc_ratio, 3) if vtb_inc_ratio else None
        checks["vtb_matched"] = True
    else:
        checks["vtb_matched"] = False

    def _short(r):
        return r is not None and r < COVER_FLOOR

    if status != "ok":
        pass                                   # L1 已判不一致，最高优先级，不再被覆盖
    elif _short(plat_ratio):
        if _short(vtb_ratio):
            status = "low_coverage"        # 两边都说我们少 ⇒ 真截断
        elif vtb_ratio is None:
            status = "low_coverage"        # 只有平台可用，只能信它
        else:
            status = "platform_suspect"    # vtb 说我们够 ⇒ 平台的数偏大
    elif _short(vtb_ratio):
        status = "vtb_suspect"             # 平台说够、vtb 说少 ⇒ vtb 侧（合并/错配）
    elif _short(plat_inc_ratio) or _short(vtb_inc_ratio):
        status = "low_income"
    elif not vtb:
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
