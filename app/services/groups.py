"""企划归属（B3，需求 6，`devlog/457`）：把"这个 V 属于哪个企划"落到 **V** 上，供左栏徽章。

## 数据从哪来（两条，都**不出网**）

| 顺序 | 来源 | 说明 |
|---|---|---|
| ① | 随包候选池快照 `vtubers.csv`（vdb 派生的 `group_name` / `group_uuid`） | 权威（vdb 是唯一同时给企划 UUID 与名字的源），且**离线可查** |
| ② | `thirdparty_vtubers.group_name`（danmakus `vup-list` 周级索引） | 池快照之后新出现的 V 只有这里有；实测与 vdb 在已收录账号上**一致**（9/9） |

⚠️ **B 站官方没有"所属企划"结构化字段**（实测：`acc/info` 没有 `fans_medal`，`nameplate` 是等级
勋章；`room/get_info` 的 `studio_info.master_list` 实测为空）⇒ 不从平台侧猜。

## 纪律

- **只填空，不覆盖**：已经有企划的 V（含将来可能的用户手改）不被后来的源改写；
- **来源没有就什么都不做**（不许把空值写上去，那会把已有的企划抹掉）；
- **幂等**：可以随便重跑（adopt 时、索引刷新后、启动时各调一次）。
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.vtuber import VTuber
from app.repositories.vtuber_repo import ThirdpartyVtuberRepo
from app.services import pool

logger = logging.getLogger(__name__)


def group_for(platform: str, platform_uid: str, db: Session | None = None
              ) -> tuple[str, str] | None:
    """查这一位（平台 + uid）的企划归属；查不到 → None。返回 `(group_name, group_uuid)`。

    顺序：**随包池快照 → 第三方索引**。池快照按 `(platform, uid)` 精确命中（字典索引，O(1)），
    索引那一份只在池里没有这个人时兜底（它覆盖"池快照之后新出现的 V"）。
    """
    it = pool.find_in_pool(platform, str(platform_uid))
    if it and it.get("group"):
        # ⚠️ 取的是 **`group_uuid`**（企划的 uuid），不是 `uuid`（这个人的 uuid）
        return it["group"], it.get("group_uuid") or ""
    if db is not None and platform == "bilibili":
        # 索引那一份的 `platform_uid` 就是 B 站 uid（`by_uid` 的语义），多源时取第一个有企划的
        for row in ThirdpartyVtuberRepo(db).by_uid(str(platform_uid)):
            if (row.group_name or "").strip():
                # danmakus 那份**没有**企划 uuid（`group_name` 是二次派生）⇒ 第二项留空
                return row.group_name.strip(), ""
    return None


def fill_for_vtuber(db: Session, vtuber: VTuber) -> bool:
    """给一个 V 填企划（只填空）；返回**是否改了库**。"""
    if (vtuber.group_name or "").strip():
        return False
    for acc in vtuber.accounts or []:
        hit = group_for(acc.platform, str(acc.platform_uid), db)
        if hit:
            vtuber.group_name, vtuber.group_uuid = hit[0], (hit[1] or None)
            db.commit()
            logger.info("企划已落库：%s → %s（来自 %s:%s）",
                        vtuber.name, hit[0], acc.platform, acc.platform_uid)
            return True
    return False


def backfill_groups(db: Session) -> dict:
    """给所有还没有企划的 V 补一遍（幂等，**不出网**）。返回统计。"""
    rows = db.query(VTuber).all()
    filled = 0
    for v in rows:
        if fill_for_vtuber(db, v):
            filled += 1
    stats = {"scanned": len(rows), "filled": filled}
    if filled:
        logger.info("企划回填：%s", stats)
    return stats


__all__ = ["backfill_groups", "fill_for_vtuber", "group_for"]
