"""删除检测（墓碑机制）— v0.5.1

问题：动态从平台消失后，库里只是"数据不再更新"，没有任何标记证明它被删了、
何时发现被删。本模块实现「连续两次缺席 + 已验证窗口」判定，挂载在每账号
帖子扫描（_fetch_posts_for_account）结束时调用，见 scheduler.py。

判定规则（与 docs/TODO.md v0.5.1 一致，细化三个实现要点）：

1. 已验证窗口（防误判的关键）：增量模式遇第一条已入库帖即停（v0.4.7），
   「比停止帖更早的帖子」本轮根本未被翻页扫描——它们不在窗口内，永不判定。
   窗口下界取两者之一：
   - 有增量停止帖（stop_existing_pid）→ 该帖的 published_at（停止即边界）；
   - 自然走到流尾（natural_end，has_more=false / 空页 / 归档边界）→
     本轮所见最旧帖的 published_at（整段流已被连续翻过）。
   窗口无上界：流首即新帖位置，比本轮最新所见还新的缺席帖 = 已从流中消失。
   page_limit / 网络失败 / 风控中断 三者皆非 → 窗口不可信，本轮跳过判定。

2. 两击规则：缺席帖（未归档且不在本轮所见集合中）的 last_seen_at 严格早于
   上一轮扫描完成时间（accounts.posts_last_scan_at）→ 已连续两轮缺席，
   写 deleted_detected_at = 本轮时间；否则保持现状，等下一轮。
   本轮所见帖一律刷新 last_seen_at = 本轮时间（无论判定是否生效）。

3. 防护：
   - 已归档帖不参与判定（归档语义即"不再追新"）；
   - 已墓碑（deleted_detected_at 非空）不重复判定、不逆转——若重新被见，
     只刷新 last_seen_at（复活保留墓碑，复活时间暂不记录，TODO 可选字段）；
   - last_seen_at 为空（迁移前旧库无基线）→ 不判，待首次被见建立基线；
   - 判定失败只记日志，不影响已完成的抓取结果。
"""
import logging
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.vtuber import Account, Post

logger = logging.getLogger(__name__)


def apply_tombstone_scan(
    db: Session,
    account: Account,
    *,
    seen_pids: list[str],
    natural_end: bool,
    stop_existing_pid: str | None,
    round_ts: datetime,
    exclude_types: set[str] | None = None,
) -> list[Post]:
    """对单个账号执行墓碑判定，返回本轮新判定的删除 Post 列表（已提交事务）。

    seen_pids          本轮观察到的帖子 ID（新入库 + 已存在，含 pinned 等），
                       判定与 last_seen 刷新都以它为准
    natural_end        本轮扫描自然走到流尾（has_more=false/空页/归档边界）
    stop_existing_pid  增量模式触发停止的那条已入库帖 ID（无则 None）
    round_ts           本轮扫描时间（naive UTC，与库内约定一致）
    exclude_types      本轮未扫描的类型（如增量流不抓视频 → {"video"}），
                       这些类型的帖子即使缺席也不判定
    """
    seen = set(seen_pids)

    q = db.query(Post).filter(
        Post.platform == account.platform,
        Post.platform_uid == account.platform_uid,
        Post.is_archived == False,  # noqa: E712
        Post.deleted_detected_at.is_(None),
    )
    if exclude_types:
        q = q.filter(~Post.type.in_(exclude_types))
    posts = q.all()

    # 扫描标记推进：无论是否判定成功，本轮记账
    prev_ts = account.posts_last_scan_at

    # ── 本轮所见刷新活在线时间（先于判定早退执行：帖子全墓碑时也要刷新） ──
    if seen:
        db.query(Post).filter(
            Post.platform == account.platform,
            Post.platform_uid == account.platform_uid,
            Post.is_archived == False,  # noqa: E712
            Post.platform_post_id.in_(seen),
        ).update({Post.last_seen_at: round_ts}, synchronize_session=False)
    account.posts_last_scan_at = round_ts

    if not posts:
        db.commit()
        return []

    # ── 已验证窗口下界 ──
    by_pid = {p.platform_post_id: p for p in posts}
    lower: datetime | None = None
    if (
        stop_existing_pid
        and stop_existing_pid in by_pid
        and by_pid[stop_existing_pid].published_at is not None
    ):
        lower = by_pid[stop_existing_pid].published_at
    else:
        pubs = [
            p.published_at
            for p in posts
            if p.platform_post_id in seen and p.published_at is not None
        ]
        if pubs:
            lower = min(pubs)

    # ── 两击判定 ──
    tombstoned: list[Post] = []
    window_trustworthy = natural_end or stop_existing_pid is not None
    if prev_ts is not None and lower is not None and window_trustworthy:
        for p in posts:
            if p.platform_post_id in seen:
                continue
            if p.published_at is None:
                continue  # 无法定位到流序，不判
            if p.published_at < lower:
                continue  # 窗口外：本轮未覆盖，缺席不代表被删
            if p.last_seen_at is None:
                continue  # 无基线（迁移前旧库），待首次被见
            if p.last_seen_at < prev_ts:
                p.deleted_detected_at = round_ts
                tombstoned.append(p)

    db.commit()
    return tombstoned
