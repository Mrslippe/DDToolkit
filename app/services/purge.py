"""解除订阅 / 删除账号的连带清理（v0.9.3 修复）。

背景：`accounts` / `vtubers` 之下还有 5 张子表挂着外键，而 ORM 只给
`VTuber.accounts` 配了级联；SQLite 侧 `PRAGMA foreign_keys=ON` 是开着的
（app/core/database.py），于是删除 V 时只要该账号还有直播场次/统计快照/
礼物日/分类校正，`DELETE FROM accounts` 就会被外键挡下 → 整次删除回滚 →
接口 500（现象：解除订阅一直失败、V 删不掉，日志里只有"连带清除帖子 N 条"）。

把「删干净」的清单收在一处，两个入口（解订阅 / 删单个账号）共用：

| 表 | 清理键 | 备注 |
|---|---|---|
| posts | (platform, platform_uid) | 无外键，需显式清（跨平台同 UID 不误删） |
| account_stat_snapshots | account_id | 粉丝/直播状态时间序列 |
| live_sessions | account_id | 直播场次（一次订阅动辄上千条） |
| live_gift_days | account_id | 礼物日聚合 |
| live_category_overrides | account_id | 分类校正 |
| vtuber_events | vtuber_id | 手动活动条目 |

**不提交**：由调用方在同一事务里 commit（失败可整体回滚，避免删一半）。
"""
from sqlalchemy.orm import Session

from app.models.vtuber import Account, VTuber
from app.repositories.vtuber_repo import (
    AccountStatSnapshotRepo,
    LiveCategoryOverrideRepo,
    LiveGiftDayRepo,
    LiveSessionRepo,
    PostRepo,
    VtuberEventRepo,
)


def purge_account(db: Session, account: Account) -> dict[str, int]:
    """清空单个账号的全部从属数据（帖子 + 4 张子表），不提交。"""
    counts: dict[str, int] = {}
    if account.platform_uid:
        counts["posts"] = PostRepo(db).delete_by_platform_uids(
            [(account.platform, account.platform_uid)]
        )
    counts["snapshots"] = AccountStatSnapshotRepo(db).delete_by_account(account.id)
    counts["live_sessions"] = LiveSessionRepo(db).delete_by_account(account.id)
    counts["gift_days"] = LiveGiftDayRepo(db).delete_by_account(account.id)
    counts["category_overrides"] = LiveCategoryOverrideRepo(db).delete_by_account(account.id)
    return counts


def purge_vtuber(db: Session, vtuber: VTuber) -> dict[str, int]:
    """清空一个 V 的全部从属数据（其各账号 + 活动条目），不提交。

    账号行本身交给 `VTuberRepo.delete` 的 ORM 级联删除——前提是子表先清空。
    """
    counts: dict[str, int] = {
        "events": VtuberEventRepo(db).delete_by_vtuber(vtuber.id),
    }
    for acc in list(vtuber.accounts):
        for key, n in purge_account(db, acc).items():
            counts[key] = counts.get(key, 0) + n
    return counts
