"""V 的历次头像账本（R47，devlog/249）。

## 为什么需要它

用户 2026-09-28：「发现账号更换了头像，新抓取下来的**不要直接覆盖以前的**，
而是把这些都**作为可选项保留下来，标记当前用的是哪个**就行」。

动机是两类真实损失：

1. `accounts.avatar_url` 每次抓取**直接覆盖** ⇒ 平台换图后旧图**再也找不回来**；
2. 更彻底的一层：本地缓存文件名是**固定**的（`static/avatars/{platform}_{uid}{ext}`）⇒
   新图**把旧文件覆盖掉**。所以只记 URL 是不够的，下载侧也必须版本化
   （见 `services/scheduler.py::_download_avatar` 的摘要后缀）。

这跟 `vtuber_field_history`（曾用名/曾用签名，devlog/074）是同一个套路：
平台字段允许被覆盖，**旧值显式记账**。

## 三条口径

- **幂等 upsert**：键是 `(vtuber_id, avatar_url)`。每次抓取都记一遍（而不是只在
  URL 变化时记）—— 这样升级后**第一次抓取就能自愈**：库里已有头像的老数据也会补上
  一行，不会出现"这个 V 从来没有过头像"的空列表；
- **封顶淘汰**：每个 V 最多 `AVATAR_VERSION_LIMIT` 张，超出丢**最旧**的；
  ⚠️ 但**不丢用户当前选中的那张**（`protect_url`）—— 它被挤掉的话，选择器里就
  没有"当前"这一项了，而卡片还在用它，看着像丢数据；
- **"当前用的是哪张"不落库**：由 `vtubers.avatar`（用户显式选过）与账号的
  `avatar_url`（没选过时跟随平台最新）**推导**（`current_avatar_url`）。
  存一个 `is_selected` 列就是第二份真源，选举与账号写岔了没人发现。

## 淘汰只删行、**不删文件**

被淘汰的行指向的本地文件留在磁盘上（几十 KB 量级）。理由：用户可能正用着那张图
（`vtubers.avatar` 指向它），删文件会让卡片直接破图。要回收空间是另一件事
（属于"孤儿文件清理"，需要先穷举所有引用点），不在本批范围。
"""
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.vtuber import Account, VTuber, VtuberAvatarHistory
from app.repositories.vtuber_repo import VtuberAvatarHistoryRepo

logger = logging.getLogger(__name__)

# 每个 V 保留几张（用户口径没定数量，按"足够回看、不至于刷屏"取 20）
AVATAR_VERSION_LIMIT = 20


def _now() -> datetime:
    """naive UTC（库内 datetime 一律 naive，见 schemas 的 field_serializer 注释）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def record_avatar_version(db: Session, *, vtuber_id: int, account_id: int | None,
                          platform: str | None, url: str | None,
                          path: str | None = None,
                          protect_url: str | None = None,
                          limit: int = AVATAR_VERSION_LIMIT) -> VtuberAvatarHistory | None:
    """把"抓取到这张头像"记进账本（幂等）。**不提交**，由调用方随外层事务一起 commit。

    - 已有同 `(vtuber_id, url)` 行 ⇒ 只 touch `last_seen_at`，并把**空着的**
      `avatar_path` / `platform` / `account_id` 补上（延后下载那条路会用到）；
    - 没有 ⇒ 追加一行（`first_seen_at = last_seen_at = now`）；
    - 然后按 `limit` 淘汰最旧的若干行（跳过 `protect_url`）。

    返回落到的行（`url` 为空或 `vtuber_id` 无效时返回 None，调用方不必判空）。
    """
    u = (url or "").strip()
    if not vtuber_id or not u:
        return None

    # ⚠️ 先 flush：`SessionLocal` 是 `autoflush=False`（app/core/database.py），
    # 不 flush 的话**本会话里刚刚记下的行对下面的查询不可见** ⇒ 同一个 URL 会被记两次、
    # 撞唯一键 `uq_vtuber_avatar_url` 让整批抓取的 commit 抛 IntegrityError；
    # 而且上一步 trim 掉的删除也还没下发，反过来又会被当成"还在"。
    # 由 tests/test_vtuber_avatars.py 的封顶用例看住（第一版就是这么红的）。
    db.flush()

    stamp = _now()
    rows = VtuberAvatarHistoryRepo(db).list_by_vtuber(vtuber_id)   # 新的在前
    row = next((r for r in rows if (r.avatar_url or "").strip() == u), None)
    if row is None:
        row = VtuberAvatarHistory(vtuber_id=vtuber_id, account_id=account_id,
                                  platform=platform, avatar_url=u, avatar_path=path,
                                  first_seen_at=stamp, last_seen_at=stamp)
        db.add(row)
        rows.insert(0, row)          # 刚记的这张就是最新的（它在列表最前）
    else:
        row.last_seen_at = stamp
        if path:
            row.avatar_path = path   # 延后下载：URL 先落库，文件到位后再补路径
        if platform and not row.platform:
            row.platform = platform
        if account_id and not row.account_id:
            row.account_id = account_id

    dropped = _trim(db, rows, limit=limit, protect_url=protect_url)
    if dropped:
        logger.info(f"头像版本超过 {limit} 张，淘汰最旧 {dropped} 张（vtuber#{vtuber_id}）")
    return row


def _trim(db: Session, rows_newest_first: list[VtuberAvatarHistory], *,
          limit: int, protect_url: str | None) -> int:
    """`rows_newest_first` 超过 `limit` 时，从**最旧**那头删掉多出来的行。返回删除数。

    未 flush 的新行（`id is None`）永不删 —— 它就是刚记下来的那张。
    `protect_url` 命中的行同样跳过：宁可少删一条，也不要让"当前用的那张"从列表里消失。
    """
    excess = len(rows_newest_first) - limit
    if excess <= 0:
        return 0
    protected = (protect_url or "").strip()
    dropped = 0
    for row in reversed(rows_newest_first):        # 最旧 → 最新
        if dropped >= excess:
            break
        if row.id is None:
            continue
        if protected and (row.avatar_url or "").strip() == protected:
            continue
        db.delete(row)
        dropped += 1
    return dropped


def current_avatar_url(vtuber: VTuber | None) -> str | None:
    """当前**实际显示**的那张头像（远端 URL），口径与前端 `resolveAvatar` 的 URL 侧一致：

    `vtubers.avatar`（档案设置里点选的）→ B 站账号 `avatar_url` → 首个账号 `avatar_url`。

    ⚠️ 前端那条链中间还有"本地缓存 `avatar_path`"两级（离线兜底）；那两级对应的
    **是同一个账号**，所以"用的是哪张"用 URL 表达就够了。前端拿 `current_url`
    跟历史行比 `url` 来打"当前"标记，不需要知道本地文件。
    """
    if vtuber is None:
        return None
    custom = (getattr(vtuber, "avatar", None) or "").strip()
    if custom:
        return custom
    accounts = list(getattr(vtuber, "accounts", None) or [])

    def _url(acc: Account) -> str | None:
        return (getattr(acc, "avatar_url", None) or "").strip() or None

    bili = next((a for a in accounts if a.platform == "bilibili"), None)
    if bili is not None and _url(bili):
        return _url(bili)
    first = next((a for a in accounts if _url(a)), None)
    return _url(first) if first is not None else None


def avatar_versions(db: Session, vtuber: VTuber,
                    limit: int = AVATAR_VERSION_LIMIT) -> dict:
    """该 V 的**可选项**列表（新的在前）+ 当前用的那张。

    账本 + **账号现值兜底**：账号头上那枚如果还不在账本里（升级后尚未抓取过，
    或者用户刚手工加了账号），也当成一个可选项返回（`first_seen_at=None`）。
    没有这层兜底，选择器在"账本还空着"时会比旧版**更差**（旧版列的就是账号现值）。
    """
    rows = VtuberAvatarHistoryRepo(db).list_by_vtuber(vtuber.id, limit)
    versions: list[dict] = [
        {"id": r.id, "url": r.avatar_url, "path": r.avatar_path,
         "platform": r.platform, "account_id": r.account_id,
         "first_seen_at": r.first_seen_at, "last_seen_at": r.last_seen_at}
        for r in rows
    ]
    known = {(v["url"] or "").strip() for v in versions}
    for acc in list(getattr(vtuber, "accounts", None) or []):
        url = (getattr(acc, "avatar_url", None) or "").strip()
        if not url or url in known:
            continue
        known.add(url)
        versions.append({"id": None, "url": url, "path": acc.avatar_path,
                         "platform": acc.platform, "account_id": acc.id,
                         "first_seen_at": None, "last_seen_at": None})
    return {"current_url": current_avatar_url(vtuber), "versions": versions}
