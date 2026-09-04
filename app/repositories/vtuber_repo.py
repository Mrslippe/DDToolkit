from datetime import datetime, timezone

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from app.models.vtuber import VTuber, Account, Post, AccountStatSnapshot, LiveGiftDay, ThirdpartyVtuber


# ── VTuber ─────────────────────────────────────────────────────────

class VTuberRepo:
    def __init__(self, db: Session):
        self.db = db

    def all(self) -> list[VTuber]:
        return self.db.query(VTuber).options(joinedload(VTuber.accounts)).all()

    def get(self, id: int) -> VTuber | None:
        return self.db.query(VTuber).options(joinedload(VTuber.accounts)).filter(VTuber.id == id).first()

    def create(self, data: dict) -> VTuber:
        obj = VTuber(**data)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, id: int, data: dict) -> VTuber | None:
        obj = self.get(id)
        if not obj:
            return None
        for k, v in data.items():
            setattr(obj, k, v)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, id: int) -> bool:
        obj = self.get(id)
        if not obj:
            return False
        self.db.delete(obj)
        self.db.commit()
        return True


# ── Account ────────────────────────────────────────────────────────

class AccountRepo:
    def __init__(self, db: Session):
        self.db = db

    def by_vtuber(self, vtuber_id: int) -> list[Account]:
        return self.db.query(Account).filter(Account.vtuber_id == vtuber_id).all()

    def get(self, id: int) -> Account | None:
        return self.db.query(Account).filter(Account.id == id).first()

    def create(self, vtuber_id: int, data: dict) -> Account:
        obj = Account(vtuber_id=vtuber_id, **data)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, id: int, data: dict) -> Account | None:
        obj = self.get(id)
        if not obj:
            return None
        for k, v in data.items():
            setattr(obj, k, v)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, id: int) -> bool:
        obj = self.get(id)
        if not obj:
            return False
        self.db.delete(obj)
        self.db.commit()
        return True

    def all_for_fetch(self, platform: str | None = None) -> list[Account]:
        """返回所有可用于抓取的 Account（有 platform_uid 的）；platform 可选过滤"""
        q = self.db.query(Account).filter(
            Account.platform_uid != None, Account.platform_uid != ""  # noqa: E711
        )
        if platform:
            q = q.filter(Account.platform == platform)
        return q.all()


# ── Account 统计快照（P0，v0.5.0） ─────────────────────────────────

class AccountStatSnapshotRepo:
    """账号统计快照历史：粉丝数/直播状态时间序列（涨粉趋势可视化地基）。

    只负责采集与读取，本期不做可视化（TODO P0 范围）。
    """

    def __init__(self, db: Session):
        self.db = db

    def add(self, account_id: int, followers_count: int | None,
            live_status: int | None = None, live_title: str | None = None,
            captured_at: datetime | None = None) -> AccountStatSnapshot:
        """追加一行快照（调用方随后 commit）。简单优先：全量记录，不降噪。"""
        obj = AccountStatSnapshot(
            account_id=account_id,
            followers_count=followers_count,
            live_status=live_status,
            live_title=live_title,
            captured_at=captured_at or datetime.now(timezone.utc),
        )
        self.db.add(obj)
        return obj

    def recent(self, account_id: int, limit: int = 100,
               source: str | None = None) -> list[AccountStatSnapshot]:
        """按时间倒序取最近 limit 条快照（只读端点备用）。

        source（P4）：None=全部来源；'self'=本工具直采；'zeroroku'=第三方回填。
        """
        q = self.db.query(AccountStatSnapshot).filter(
            AccountStatSnapshot.account_id == account_id
        )
        if source is not None:
            q = q.filter(AccountStatSnapshot.source == source)
        return (
            q.order_by(AccountStatSnapshot.captured_at.desc())
            .limit(limit)
            .all()
        )


# ── Post ───────────────────────────────────────────────────────────

class PostRepo:
    def __init__(self, db: Session):
        self.db = db

    def by_uid(self, platform: str, platform_uid: str) -> list[Post]:
        return (
            self.db.query(Post)
            .filter(Post.platform == platform, Post.platform_uid == platform_uid)
            .order_by(Post.published_at.desc())
            .all()
        )

    def paginated(self, platform: str, platform_uid: str, page: int = 1,
                  page_size: int = 50, post_type: str | None = None,
                  is_archived: bool | None = None,
                  q: str | None = None,
                  date_from: datetime | None = None,
                  date_to: datetime | None = None,
                  is_deleted: bool | None = None) -> tuple[int, list[Post]]:
        """服务端分页 + 过滤（前端列表用；旧 by_uid 保持兼容）。返回 (total, items)

        q        标题/摘要模糊匹配（OR 语义）
        post_type 逗号分隔多型（如 "video,video_dynamic"）；单值天然兼容
        date_from/date_to 发布时间范围：from 含当天零点起；to 为次日零点排他
                 （即包含结束日全天）；设范围时 published_at 为空的帖子被排除
        is_deleted 墓碑筛选（v0.5.1）：True=仅已删除 False=仅未删除 None=全部
        """
        query = self.db.query(Post).filter(
            Post.platform == platform, Post.platform_uid == platform_uid
        )
        if post_type:
            types = [t.strip() for t in post_type.split(',') if t.strip()]
            if types:
                query = query.filter(Post.type.in_(types))
        if is_archived is not None:
            query = query.filter(Post.is_archived == is_archived)
        if is_deleted is not None:
            query = query.filter(
                Post.deleted_detected_at.isnot(None)
                if is_deleted else Post.deleted_detected_at.is_(None)
            )
        q = (q or "").strip()
        if q:
            kw = f"%{q}%"
            # P2 全文搜索：正文纯文本列纳入 OR 匹配（NULL 列天然不匹配）
            query = query.filter(or_(
                Post.title.ilike(kw),
                Post.summary.ilike(kw),
                Post.body_text.ilike(kw),
            ))
        if date_from is not None:
            query = query.filter(Post.published_at >= date_from)
        if date_to is not None:
            query = query.filter(Post.published_at < date_to)
        total = query.count()
        items = (
            query.order_by(Post.published_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return total, items

    def stats(self, platform: str, platform_uid: str) -> dict:
        """某账号帖子的统计概览：总数/归档数/删除数/类型分布/时间跨度"""
        q = self.db.query(Post).filter(
            Post.platform == platform, Post.platform_uid == platform_uid
        )
        total = q.count()
        archived = q.filter(Post.is_archived == True).count()  # noqa: E712
        deleted = q.filter(Post.deleted_detected_at.isnot(None)).count()
        by_type = {
            t: n for t, n in q.with_entities(Post.type, func.count(Post.id))
            .group_by(Post.type).all()
        }
        earliest, latest = q.with_entities(
            func.min(Post.published_at), func.max(Post.published_at)
        ).one()
        return {
            "platform": platform,
            "platform_uid": platform_uid,
            "total": total,
            "archived": archived,
            "deleted": deleted,
            "by_type": by_type,
            "earliest": earliest,
            "latest": latest,
        }

    def archive_before(self, cutoff: datetime) -> int:
        """归档规则：published_at 早于 cutoff 的帖子 → is_archived=1（幂等）。返回归档条数。"""
        n = self.db.query(Post).filter(
            Post.is_archived == False,  # noqa: E712
            Post.published_at.isnot(None),
            Post.published_at < cutoff,
        ).update({Post.is_archived: True}, synchronize_session=False)
        self.db.commit()
        return n

    def get(self, id: int) -> Post | None:
        return self.db.query(Post).filter(Post.id == id).first()

    def create(self, data: dict, commit: bool = True) -> Post:
        """新增帖子。commit=False 时仅 add 不提交（批量入库用，见 scheduler._fetch_posts_core）。"""
        obj = Post(**data)
        self.db.add(obj)
        if commit:
            self.db.commit()
            self.db.refresh(obj)
        return obj

    def update(self, id: int, data: dict) -> Post | None:
        obj = self.get(id)
        if not obj:
            return None
        for k, v in data.items():
            setattr(obj, k, v)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, id: int) -> bool:
        obj = self.get(id)
        if not obj:
            return False
        self.db.delete(obj)
        self.db.commit()
        return True

    def delete_by_platform_uids(self, platform_uids: list[tuple[str, str]]) -> int:
        """按 (platform, platform_uid) 账号组清空帖子（解订阅用：posts 表独立，无外键联删）。

        修复：原先只按 platform_uid 过滤，同一 V 在 bilibili/youtube 上有相同 UID 时
        会误删另一个平台的帖子；改为平台+UID 组合匹配。
        """
        if not platform_uids:
            return 0
        cond = or_(*[
            (Post.platform == p) & (Post.platform_uid == uid)
            for p, uid in platform_uids
        ])
        n = self.db.query(Post).filter(cond).delete(synchronize_session=False)
        return n


# ── 外部第三方数据（P4） ────────────────────────────────────────────

class LiveGiftDayRepo:
    """直播礼物日聚合读取（写入走 externals 源适配器）。"""

    def __init__(self, db: Session):
        self.db = db

    def list_by_account(self, account_id: int, source: str | None = None,
                        limit: int = 0) -> list[LiveGiftDay]:
        """按日期倒序取某账号礼物聚合；limit=0 全量。"""
        q = self.db.query(LiveGiftDay).filter(LiveGiftDay.account_id == account_id)
        if source is not None:
            q = q.filter(LiveGiftDay.source == source)
        q = q.order_by(LiveGiftDay.gift_date.desc())
        if limit > 0:
            q = q.limit(limit)
        return q.all()


class ThirdpartyVtuberRepo:
    """第三方 VTuber 索引读取（候选池搜索增强 / 企划·公会数据）。"""

    def __init__(self, db: Session):
        self.db = db

    def search(self, kw: str, source: str | None = None, limit: int = 20) -> list[ThirdpartyVtuber]:
        """名称关键词 / uid 前缀匹配（候选池检索用）。"""
        kw = (kw or "").strip()
        if not kw:
            return []
        q = self.db.query(ThirdpartyVtuber).filter(or_(
            ThirdpartyVtuber.name.ilike(f"%{kw}%"),
            ThirdpartyVtuber.platform_uid.like(f"{kw}%"),
        ))
        if source is not None:
            q = q.filter(ThirdpartyVtuber.source == source)
        return q.limit(limit).all()

    def by_uid(self, platform_uid: str, source: str | None = None) -> list[ThirdpartyVtuber]:
        q = self.db.query(ThirdpartyVtuber).filter(
            ThirdpartyVtuber.platform_uid == platform_uid)
        if source is not None:
            q = q.filter(ThirdpartyVtuber.source == source)
        return q.all()
