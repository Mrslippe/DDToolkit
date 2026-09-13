"""V 的字段「曾用值」记账（2026-09-13，devlog/074）。

## 为什么需要它

用户 2026-09-13 定：**字段锁定退役** —— 平台昵称/签名允许被抓取覆盖（锁定那套
"手改完别让抓取动它"的做法，与"平台签名只读 + 手改进 override"的新口径冲突）。
代价是旧值会被覆盖掉，所以改成**显式记账**：值真的变了就把旧值追加一行。

⚠️ **不能指望快照表兜底**：`account_stat_snapshots` 只存粉丝数 / 直播状态 / 开播标题，
**不含昵称与签名**。不记账 = 永久丢失。

## 记账规则（都是"宁少勿错"）

- 空值/相同值不记（每次抓取都写一行会把历史刷成噪声）；
- 与**最近一条**同类记录相同则不重复记（A→B→A 会留下两条：A、B —— 这就够了）；
- 只记 `display_name` / `sign` 两个字段（`FIELD_*` 常量），其它字段要记时再扩。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.vtuber import VtuberFieldHistory

logger = logging.getLogger(__name__)

FIELD_DISPLAY_NAME = "display_name"
FIELD_SIGN = "sign"
FIELDS = (FIELD_DISPLAY_NAME, FIELD_SIGN)

# 展示上限：曾用名/曾用签名各自最多回几条（前端只做标注，不做历史页）
FORMER_LIMIT = 5


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def record_field_change(db: Session, *, vtuber_id: int, account_id: int | None,
                        field: str, old_value: str | None) -> bool:
    """旧值真的变了 → 追加一行历史。返回是否写入。

    调用方负责**在写新值之前**调用（传进来的就是即将被覆盖的旧值）。
    """
    if field not in FIELDS:
        return False
    old = (old_value or "").strip()
    if not old:
        return False
    latest = (
        db.query(VtuberFieldHistory)
        .filter(VtuberFieldHistory.vtuber_id == vtuber_id,
                VtuberFieldHistory.account_id == account_id,
                VtuberFieldHistory.field == field)
        .order_by(VtuberFieldHistory.changed_at.desc(),
                  VtuberFieldHistory.id.desc())
        .first()
    )
    if latest is not None and (latest.value or "").strip() == old:
        return False          # A→B→A：B 已记过，别再记一条重复的
    db.add(VtuberFieldHistory(vtuber_id=vtuber_id, account_id=account_id,
                              field=field, value=old, changed_at=_now()))
    return True


def former_values(db: Session, vtuber_id: int,
                  limit: int = FORMER_LIMIT) -> dict[str, list[dict]]:
    """该 V 的曾用名 / 曾用签名（各取最近 `limit` 条，去重保序）。

    返回 `{"names": [{value, platform, account_id, changed_at}], "signs": [...]}`；
    `platform` 取自账号（账号被删则退化为 None，前端显示成"已移除账号"）。
    """
    from app.models.vtuber import Account  # 局部导入避免循环

    rows = (
        db.query(VtuberFieldHistory, Account.platform)
        .outerjoin(Account, Account.id == VtuberFieldHistory.account_id)
        .filter(VtuberFieldHistory.vtuber_id == vtuber_id)
        .order_by(VtuberFieldHistory.changed_at.desc(),
                  VtuberFieldHistory.id.desc())
        .all()
    )
    out: dict[str, list[dict]] = {"names": [], "signs": []}
    seen: dict[str, set[str]] = {"names": set(), "signs": set()}
    key_of = {FIELD_DISPLAY_NAME: "names", FIELD_SIGN: "signs"}
    for row, platform in rows:
        bucket = key_of.get(row.field)
        if bucket is None:
            continue
        value = (row.value or "").strip()
        if not value or value in seen[bucket]:
            continue
        if len(out[bucket]) >= limit:
            continue
        seen[bucket].add(value)
        out[bucket].append({
            "value": value,
            "platform": platform,
            "account_id": row.account_id,
            "changed_at": row.changed_at,
        })
    return out
