from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.models.vtuber import VTuber, Account, Post


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
            if v is not None:
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
            if v is not None:
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

    def all_for_fetch(self) -> list[Account]:
        """返回所有可用于抓取的 Account（有 platform_uid 的）"""
        return self.db.query(Account).filter(Account.platform_uid != None, Account.platform_uid != "").all()


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
                  is_archived: bool | None = None) -> tuple[int, list[Post]]:
        """服务端分页 + 过滤（前端列表用；旧 by_uid 保持兼容）。返回 (total, items)"""
        q = self.db.query(Post).filter(
            Post.platform == platform, Post.platform_uid == platform_uid
        )
        if post_type:
            q = q.filter(Post.type == post_type)
        if is_archived is not None:
            q = q.filter(Post.is_archived == is_archived)
        total = q.count()
        items = (
            q.order_by(Post.published_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return total, items

    def stats(self, platform: str, platform_uid: str) -> dict:
        """某账号帖子的统计概览：总数/归档数/类型分布/时间跨度"""
        q = self.db.query(Post).filter(
            Post.platform == platform, Post.platform_uid == platform_uid
        )
        total = q.count()
        archived = q.filter(Post.is_archived == True).count()  # noqa: E712
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

    def create(self, data: dict) -> Post:
        obj = Post(**data)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, id: int, data: dict) -> Post | None:
        obj = self.get(id)
        if not obj:
            return None
        for k, v in data.items():
            if v is not None:
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

    def delete_by_platform_uids(self, platform_uids: list[str]) -> int:
        """按账号组清空帖子（解订阅用：posts 表独立，无外键联删）。"""
        if not platform_uids:
            return 0
        n = self.db.query(Post).filter(Post.platform_uid.in_(platform_uids)).delete(
            synchronize_session=False
        )
        return n
