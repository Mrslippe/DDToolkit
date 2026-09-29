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
from app.services import assets

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

    - 已有**同一个稳定键**的行 ⇒ 只 touch `last_seen_at`（见下方 §归并）；
    - 没有 ⇒ 追加一行（`first_seen_at = last_seen_at = now`）；
    - 然后按 `limit` 淘汰最旧的若干行（跳过 `protect_url`）。

    返回落到的行（`url` 为空或 `vtuber_id` 无效时返回 None，调用方不必判空）。

    ## 归并按**稳定键**，不是完整 URL（L1，devlog/257）

    微博头像签名约 3 小时轮换一次（实测同一张图的两次抓取只差 `Expires`/`ssig`，
    盘上两个文件 sha256 逐字节相同）。按完整 URL 判存在 ⇒ 同一张脸每轮抓取都多一个"版本"，
    选择器被签名噪声刷满 —— 而用户要的是"历次**头像**"，不是"历次 URL"。
    ⇒ 判存在用 `assets.key_of(url)`（键相同即同一张图）。

    ⚠️ **`url` 只跟到最新，但当前选中的那条不动**：`vtubers.avatar`（用户的选择）与账本行的
    `avatar_url` 是"当前用的是哪张"的两侧真源，只有字符串相等才对得上；把行改成新签名会让
    选择器里"当前"这一项凭空消失（而卡片还在用它）。过期 URL 的渲染由 `avatar_local` 兜底。
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
    key = assets.key_of(u)
    rows = VtuberAvatarHistoryRepo(db).list_by_vtuber(vtuber_id)   # 新的在前
    # 判存在按**稳定键**（见上方 §归并）。⚠️ L1 之前可能已经存在"同一张图的两个签名各一行"
    # （R47 按完整 URL 记账，而微博每 3 小时换一次签名 ⇒ 这在老数据里是真实形态）：
    # 那样"改 URL"就会撞唯一键 `uq_vtuber_avatar_url`，而 `SessionLocal` 是 `autoflush=False`
    # ⇒ 到 commit 才炸、整批抓取回滚。所以下面有一道**不许写成别人已有的 URL**的硬保护
    # （判据 `test_preexisting_same_key_rows_do_not_break_the_merge`）；老数据本批不动。
    row = next((r for r in rows if assets.key_of((r.avatar_url or "").strip()) == key), None)
    if row is None:
        row = VtuberAvatarHistory(vtuber_id=vtuber_id, account_id=account_id,
                                  platform=platform, avatar_url=u, avatar_path=path,
                                  first_seen_at=stamp, last_seen_at=stamp)
        db.add(row)
        rows.insert(0, row)          # 刚记的这张就是最新的（它在列表最前）
    else:
        row.last_seen_at = stamp
        taken = any(r is not row and (r.avatar_url or "").strip() == u for r in rows)
        if not taken and (row.avatar_url or "").strip() != (protect_url or "").strip():
            row.avatar_url = u       # 跟到最近一次见到的 URL（选择器给得出活地址）
        if path and not _path_exists(row.avatar_path):
            row.avatar_path = path   # 延后下载/文件被删：URL 先落库，文件到位后再补路径
        if platform and not row.platform:
            row.platform = platform
        if account_id and not row.account_id:
            row.account_id = account_id

    dropped = _trim(db, rows, limit=limit, protect_url=protect_url)
    if dropped:
        logger.info(f"头像版本超过 {limit} 张，淘汰最旧 {dropped} 张（vtuber#{vtuber_id}）")
    return row


def _path_exists(path: str | None) -> bool:
    """账本里记的本地文件还在不在（相对 DATA_DIR，与 `assets.abs_path` 同口径）。"""
    rel = (path or "").strip()
    return bool(rel) and assets.abs_path(rel).exists()


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


def local_avatar_map(db: Session, vtubers: list[VTuber]) -> dict[int, str | None]:
    """**批量**求每个 V「当前选中那张头像」的本地路径（A0，devlog/255）。

    为什么需要它：`vtubers.avatar` 存的是**远端 URL 原文**，而远端会死 ——
    实测 2026-09-29：V#16 明前奶绿那张微博头像的签名 `Expires` 已过期 21 小时，
    当时**只靠 `/img-proxy` 的磁盘缓存续命**。有了这个派生值，渲染侧就能在
    "直连 / 代理都失败"之后回落到**盘上那份**（`ProxyImage` 的 `fallbackSrc`）。

    派生顺序（**L1 起第一级换成资产索引**，后两级是 A0 的兜底）：
    ⓪ `local_assets` 里稳定键命中的那份（`static/assets/avatar/…`）—— 最权威：
       抓取侧每次都会把"这份文件对应哪个远端资源"登记进去，且它是清理时受保护的那份；
    ① `vtuber_avatar_history` 里 `avatar_url == vtubers.avatar` 的行的 `avatar_path`
       （升级前的老数据：索引里还没有它，但账本记着）；
    ② 退一步：某账号的 `avatar_url == vtubers.avatar` ⇒ 该账号的 `avatar_path`
       （账本与索引都还不认识它时用，例如升级前就选好的那些）。

    ⚠️ **一次批量查，不许 N+1**：`/vtuber/list` 返回全部 V，逐 V 查就是 N 次往返
    （判据：语句计数那条用例 —— V 数翻倍而查询数不变）。三级各自**一次**查完。
    ⚠️ 只认**非空**结果：查不到返回 `None`（前端据此退回占位，而不是拿空串拼出一个假 URL）。
    """
    wanted: dict[int, str] = {}
    for v in vtubers:
        url = (getattr(v, "avatar", None) or "").strip()
        if url:
            wanted[v.id] = url
    if not wanted:
        return {}

    ids = list(wanted)
    urls = sorted(set(wanted.values()))
    out: dict[int, str | None] = {vid: None for vid in ids}

    # ⓪ 轻资产索引（L1）：键 = 去掉签名参数的 URL ⇒ 远端换了签名也认得本地那份
    keys = {vid: assets.key_of(url) for vid, url in wanted.items()}
    by_key = assets.lookup_keys(db, assets.KIND_AVATAR, keys.values())
    for vid, key in keys.items():
        row = by_key.get(key)
        if row is not None and (row.path or "").strip():
            out[vid] = row.path
    missing = [vid for vid in ids if out[vid] is None]
    if not missing:
        return out

    rows = (
        db.query(VtuberAvatarHistory.vtuber_id, VtuberAvatarHistory.avatar_url,
                 VtuberAvatarHistory.avatar_path)
        .filter(VtuberAvatarHistory.vtuber_id.in_(missing),
                VtuberAvatarHistory.avatar_url.in_(urls))
        .all()
    )
    for vid, _url, path in rows:
        if out.get(vid) is None and (path or "").strip():
            out[vid] = path
    missing = [vid for vid in missing if out[vid] is None]
    if not missing:
        return out

    rows = (
        db.query(Account.vtuber_id, Account.avatar_url, Account.avatar_path)
        .filter(Account.vtuber_id.in_(missing), Account.avatar_url.in_(urls))
        .all()
    )
    for vid, _url, path in rows:
        if out.get(vid) is None and (path or "").strip():
            out[vid] = path
    return out


# ── L4：把"同一张头像的多行"并成一行（devlog/262）────────────────────────

def _version_digest(db: Session, row: VtuberAvatarHistory) -> str | None:
    """这一行的**内容摘要**（优先取轻资产索引里那份；索引里没有就现读盘算一次）。

    为什么用内容摘要而不是只比 URL：R47 之前本地文件名是**固定**的，同一张图会先落到
    `{platform}_{uid}.jpg`、之后又落到 `{platform}_{uid}_{摘要}.jpg` —— 两个文件名、同一张脸。
    """
    row_asset = assets.lookup(db, assets.KIND_AVATAR, (row.avatar_url or "").strip())
    if row_asset is not None and row_asset.sha256:
        return row_asset.sha256
    rel = (row.avatar_path or "").strip()
    if not rel:
        return None
    path = assets.abs_path(rel)
    if not path.exists():
        return None
    return assets._sha256_file(path)


def _pick_keeper(rows: list[VtuberAvatarHistory], selected: str) -> VtuberAvatarHistory:
    """保留哪一行：**用户当前选中的那张优先**（否则"当前"标记会丢），再按最新的。

    与 `_trim` 的 `protect_url` 同一条纪律：用户的选择不许被"整理"掉。
    """
    if selected:
        for r in rows:
            if (r.avatar_url or "").strip() == selected:
                return r
    return max(rows, key=lambda r: (r.first_seen_at or _now(), r.id or 0))


def merge_duplicate_versions(db: Session, *, vtuber_id: int | None = None,
                             dry_run: bool = True) -> dict:
    """把**同一张图的多行**并成一行（L4，devlog/262）。**不提交**，由调用方收口。

    两条判同路径（命中任一即算同一张脸）：
    ① **稳定键**相同（`assets.key_of`）：微博每轮抓取换签名 ⇒ R47 的账本按 URL 记账会各留一行；
    ② **内容摘要**相同（`local_assets.sha256` 或现读盘）：R47 前后两个文件名指向同一张图。

    ⚠️ **只删行、绝不删文件**（方案 §4 S-1）：旧文件名/旧副本留在盘上，选择器里那几张图
    仍然画得出来（`avatar_path` 只在保留行上，被合并掉的行本来就指向同一张图）。
    ⚠️ `dry_run=True`（默认）⇒ 一个行都不删，只回报告；调用方拿它先给用户看。
    """
    from app.repositories.vtuber_repo import VtuberAvatarHistoryRepo

    vids = [vtuber_id] if vtuber_id else [
        row[0] for row in db.query(VtuberAvatarHistory.vtuber_id).distinct().all()
    ]
    report: dict = {"dry_run": bool(dry_run), "groups": 0, "merged": 0,
                    "kept": [], "dropped": [], "vtubers": len(vids)}
    for vid in vids:
        rows = VtuberAvatarHistoryRepo(db).list_by_vtuber(vid)
        if len(rows) < 2:
            continue
        selected = (db.query(VTuber.avatar).filter(VTuber.id == vid).scalar() or "").strip()
        buckets: dict[str, list[VtuberAvatarHistory]] = {}
        for r in rows:
            url = (r.avatar_url or "").strip()
            key = assets.key_of(url)
            digest = _version_digest(db, r)
            # 两个键都试：先按内容摘要归（最准），没有再按稳定键
            for tag in ([f"sha:{digest}"] if digest else []) + ([f"key:{key}"] if key else []):
                buckets.setdefault(tag, []).append(r)
        # 一个组可能被两条路径同时命中 ⇒ 用并查集式的合并（取并集后去重）
        merged_groups: list[list[VtuberAvatarHistory]] = []
        for group in buckets.values():
            if len(group) < 2:
                continue
            ids = {id(x) for x in group}
            for existing in merged_groups:
                if ids & {id(x) for x in existing}:
                    existing.extend([x for x in group if id(x) not in {id(y) for y in existing}])
                    break
            else:
                merged_groups.append(list(group))
        for group in merged_groups:
            if len(group) < 2:
                continue
            keeper = _pick_keeper(group, selected)
            report["groups"] += 1
            report["kept"].append({"vtuber_id": vid, "url": keeper.avatar_url,
                                   "path": keeper.avatar_path, "rows": len(group)})
            for r in group:
                if r is keeper:
                    continue
                report["dropped"].append({"vtuber_id": vid, "id": r.id,
                                          "url": r.avatar_url, "path": r.avatar_path})
                report["merged"] += 1
                if dry_run:
                    continue
                # 合并"曾见过"的时间窗：最早的那次留着，最近的那次也留着
                if r.first_seen_at and (keeper.first_seen_at is None
                                        or r.first_seen_at < keeper.first_seen_at):
                    keeper.first_seen_at = r.first_seen_at
                if r.last_seen_at and (keeper.last_seen_at is None
                                       or r.last_seen_at > keeper.last_seen_at):
                    keeper.last_seen_at = r.last_seen_at
                if not (keeper.avatar_path or "").strip() and (r.avatar_path or "").strip():
                    keeper.avatar_path = r.avatar_path
                if not keeper.platform and r.platform:
                    keeper.platform = r.platform
                if not keeper.account_id and r.account_id:
                    keeper.account_id = r.account_id
                db.delete(r)
    db.flush()
    return report


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
