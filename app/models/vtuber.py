from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Boolean, Text, DateTime,
    ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship

from app.core.database import Base


def _now():
    return datetime.now(timezone.utc)


class VTuber(Base):
    """虚拟主播本体，平台无关"""
    __tablename__ = "vtubers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, nullable=False)
    faction = Column(String, nullable=True)            # 阵营（手动维护）
    birthday = Column(String, nullable=True)          # MM-DD
    debut_date = Column(String, nullable=True)         # YYYY-MM-DD 或仅 YYYY
    setting = Column(Text, nullable=True)              # 角色设定
    avatar = Column(String, nullable=True)             # 默认头像 URL
    background_path = Column(String, nullable=True)    # 卡片页自定义背景（static/ 相对路径）
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    accounts = relationship("Account", back_populates="vtuber", cascade="all, delete-orphan")


class Account(Base):
    """VTuber 在各平台的账号"""
    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("platform", "platform_uid", name="uq_account_platform_uid"),
        Index("ix_accounts_vtuber_id", "vtuber_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    vtuber_id = Column(Integer, ForeignKey("vtubers.id"), nullable=False)
    platform = Column(String, nullable=False)          # bilibili / youtube / twitter ...
    platform_uid = Column(String, nullable=False)      # 平台侧 UID
    display_name = Column(String, nullable=True)       # 该平台上的昵称
    avatar_url = Column(String, nullable=True)         # 该平台头像
    avatar_path = Column(String, nullable=True)        # 本地缓存路径
    sign = Column(String, nullable=True)
    url = Column(String, nullable=True)                # 主页链接
    followers_count = Column(Integer, default=0)
    room_id = Column(String, nullable=True)            # 直播间 ID
    live_status = Column(Integer, default=0)           # 0=离线 1=直播中
    live_title = Column(String, nullable=True)
    live_url = Column(String, nullable=True)
    last_fetched_at = Column(DateTime, nullable=True)

    vtuber = relationship("VTuber", back_populates="accounts")


class AccountStatSnapshot(Base):
    """账号统计快照历史：每次账号信息抓取成功后追加一行（P0，v0.5.0）。

    accounts.followers_count 只存最新值、每次抓取覆盖；此表记录时间序列，
    供涨粉趋势/直播状态历史回溯。简单优先：全量记录，不做无变化降噪。
    """
    __tablename__ = "account_stat_snapshots"
    __table_args__ = (
        Index("ix_account_stat_snapshots_account_id", "account_id"),
        Index("ix_account_stat_snapshots_captured_at", "captured_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    followers_count = Column(Integer, nullable=True)
    live_status = Column(Integer, nullable=True)          # 顺手记录：0=离线 1=直播中
    live_title = Column(String, nullable=True)            # 开播标题快照
    captured_at = Column(DateTime, nullable=False, default=_now)


class Post(Base):
    """动态 / 投稿 / 直播记录 — 独立于 account，按平台+UID+帖子ID去重（联合投稿会在每个V下各存一份）"""
    __tablename__ = "posts"
    __table_args__ = (
        UniqueConstraint("platform", "platform_uid", "platform_post_id", name="uq_post_platform_uid_pid"),
        # 热路径查询：按账号分页 + 时间倒序（vtuber_repo.paginated）
        Index("ix_posts_platform_uid_published", "platform", "platform_uid", "published_at"),
        # 归档规则：is_archived=0 AND published_at < cutoff
        Index("ix_posts_published_at", "published_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String, nullable=False, index=True)         # bilibili / youtube / twitter
    platform_uid = Column(String, nullable=False, index=True)     # 账号在该平台的 UID
    platform_post_id = Column(String, nullable=False)             # 帖子在平台上的唯一 ID

    type = Column(String, nullable=False, default="text")         # video / video_dynamic / image / article / text / repost / live / music
    title = Column(String, nullable=True)
    summary = Column(Text, nullable=True)                         # 前 200 字，列表展示用
    cover_url = Column(String, nullable=True)
    permalink = Column(String, nullable=True)                     # 原始链接
    body_json = Column(Text, nullable=True)                       # 结构化类型差异数据
    stats_json = Column(Text, nullable=True)                      # {"view":N,"like":N,"comment":N,"forward":N}
    published_at = Column(DateTime, nullable=True)
    raw_json = Column(Text, nullable=True)
    is_archived = Column(Boolean, default=False, server_default="0")    # 是否归档
    created_at = Column(DateTime, default=_now)
