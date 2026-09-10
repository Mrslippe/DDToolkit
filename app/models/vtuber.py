from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Boolean, Text, DateTime, Float,
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
    # 墓碑机制（v0.5.1）：帖子扫描上一轮的完成时间，两次缺席判定的比较基准
    posts_last_scan_at = Column(DateTime, nullable=True)

    vtuber = relationship("VTuber", back_populates="accounts")


class AccountStatSnapshot(Base):
    """账号统计快照历史：每次账号信息抓取成功后追加一行（P0，v0.5.0）。

    accounts.followers_count 只存最新值、每次抓取覆盖；此表记录时间序列，
    供涨粉趋势/直播状态历史回溯。简单优先：全量记录，不做无变化降噪。
    source 区分数据来源（P4）：self=本工具直采（默认）/ zeroroku=第三方回填。
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
    source = Column(String, nullable=False, default="self", server_default="self")


class LiveSession(Base):
    """直播场次（v0.9.x 内容管道 M1：danmakus 固定化场次为主源）。

    - source：danmakus（历史全量）/ feed（M3，B站 live_rcmd 场次）
    - self 快照推导场次**不落本表**（读取时合并，见 LiveSessionRepo.merged）
    - live_id：平台级场次唯一键（danmakus uuid / B站 live_id）
    - total_income：danmakus totalIncome（元，含礼物/SC/上舰口径为站点定义）
    - raw_json：原始场次数据保真（档案定位）
    """
    __tablename__ = "live_sessions"
    __table_args__ = (
        UniqueConstraint("account_id", "live_id", name="uq_live_sessions_account_live"),
        Index("ix_live_sessions_account_start", "account_id", "start_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    platform = Column(String, nullable=False, default="bilibili")
    source = Column(String, nullable=False, default="danmakus")
    live_id = Column(String, nullable=True)
    title = Column(String, nullable=True)
    room_id = Column(String, nullable=True)
    start_at = Column(DateTime, nullable=False)
    end_at = Column(DateTime, nullable=True)
    parent_area_name = Column(String, nullable=True)
    area_name = Column(String, nullable=True)
    cover_url = Column(String, nullable=True)
    total_income = Column(Float, nullable=True)
    max_online_count = Column(Integer, nullable=True)
    danmakus_count = Column(Integer, nullable=True)
    raw_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class LiveCategoryOverride(Base):
    """直播分类用户校正（v0.9.x 类型引擎 v2 第⑦信号）。

    - (account_id, live_id) 唯一定死分类（infer_category 最高优先级 override 源）；
    - 反哺：被校正场次标题的词条 → 该账号 learned 词库（其余场次同词条经
      learned 源生效，见 app/services/live_type.py）；
    - 仅表内场次可校正（self 快照推导虚拟场次无 live_id）。
    """
    __tablename__ = "live_category_overrides"
    __table_args__ = (
        UniqueConstraint("account_id", "live_id", name="uq_live_category_overrides_account_live"),
        Index("ix_live_category_overrides_account", "account_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    live_id = Column(String, nullable=False)
    category = Column(String, nullable=False)             # 9 类之一（不含 live 兜底）
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class LiveGiftDay(Base):
    """直播礼物日聚合（P4：第三方固定化数据）。

    来源：zeroroku live-paid-aggregations（公开，日粒度 bucket：礼物/大航海/SC 金额）。
    金额以原始字符串保存（站点返回 "1234.500" 这类小数字符串，保精度防浮点漂移）。
    单场次起止（直播日程记录）不在本表范围，留给 P5 用 live_status 快照推导。
    """
    __tablename__ = "live_gift_days"
    __table_args__ = (
        UniqueConstraint("account_id", "source", "gift_date", name="uq_live_gift_day"),
        Index("ix_live_gift_days_account_date", "account_id", "gift_date"),
    )

    id = Column(Integer, primary_key=True, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    source = Column(String, nullable=False, default="zeroroku")
    gift_date = Column(String, nullable=False)            # "2026-09-04"（ISO 日期）
    gift_amount = Column(String, nullable=True)
    guard_amount = Column(String, nullable=True)
    sc_amount = Column(String, nullable=True)
    total_amount = Column(String, nullable=True)
    room_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=_now)


class ThirdpartyVtuber(Base):
    """第三方 VTuber 索引（P4：danmakus vup-list，透传 laplace vup-slim.json）。

    提供 name/type/room_id/group_name（企划·公会），供候选池搜索增强与
    faction 自动打标候选；整表按 source 周级刷新。
    """
    __tablename__ = "thirdparty_vtubers"
    __table_args__ = (
        UniqueConstraint("source", "platform_uid", name="uq_thirdparty_vtuber"),
    )

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String, nullable=False, default="bilibili")
    platform_uid = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    type = Column(String, nullable=True)                  # vtuber / group / fan / unknown
    room_id = Column(String, nullable=True)
    group_name = Column(String, nullable=True)            # 企划/公会名（可为空）
    source = Column(String, nullable=False)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class VtuberEvent(Base):
    """重要日期·大型活动（P7，v0.7.0）：手动维护的纪念日/活动条目。

    与 birthday/debut_date（VTuber 字段，年循环纪念日）互补：
    本表记录一次性日期事件（演唱会/周年庆/线下活动等），卡片可增删。
    event_date 存 "YYYY-MM-DD"（ISO 日期字符串，与 posts.live日期口径一致）。
    """
    __tablename__ = "vtuber_events"
    __table_args__ = (
        Index("ix_vtuber_events_vtuber_date", "vtuber_id", "event_date"),
    )

    id = Column(Integer, primary_key=True, index=True)
    vtuber_id = Column(Integer, ForeignKey("vtubers.id"), nullable=False)
    title = Column(String, nullable=False)                # 活动名（如「生日歌回」）
    event_date = Column(String, nullable=False)           # "YYYY-MM-DD"
    created_at = Column(DateTime, default=_now)


class Post(Base):
    """动态 / 投稿 / 直播记录 — 独立于 account，按平台+UID+帖子ID去重（联合投稿会在每个V下各存一份）"""
    __tablename__ = "posts"
    __table_args__ = (
        UniqueConstraint("platform", "platform_uid", "platform_post_id", name="uq_post_platform_uid_pid"),
        # 热路径查询：按账号分页 + 时间倒序（vtuber_repo.paginated）
        Index("ix_posts_platform_uid_published", "platform", "platform_uid", "published_at"),
        # 归档规则：is_archived=0 AND published_at < cutoff
        Index("ix_posts_published_at", "published_at"),
        # 墓碑筛选（v0.5.1）：deleted_detected_at IS NOT NULL
        Index("ix_posts_deleted_detected", "deleted_detected_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String, nullable=False, index=True)         # bilibili / youtube / twitter
    platform_uid = Column(String, nullable=False, index=True)     # 账号在该平台的 UID
    platform_post_id = Column(String, nullable=False)             # 帖子在平台上的唯一 ID

    type = Column(String, nullable=False, default="text")         # video / video_dynamic / image / article / text / repost / live / music
    title = Column(String, nullable=True)
    summary = Column(Text, nullable=True)                         # 前 200 字，列表展示用
    body_text = Column(Text, nullable=True)                       # 正文纯文本（P2 全文搜索，提取逻辑见 post_text.py）
    cover_url = Column(String, nullable=True)
    permalink = Column(String, nullable=True)                     # 原始链接
    body_json = Column(Text, nullable=True)                       # 结构化类型差异数据
    stats_json = Column(Text, nullable=True)                      # {"view":N,"like":N,"comment":N,"forward":N}
    # P9-3（v0.9.6）：B 站「投稿」与「投稿动态」是同一条视频的两个来源，合并后只留
    # video 一条，动态里的附言文本存这里（前端以「UP 主附言」标注）
    note = Column(Text, nullable=True)
    published_at = Column(DateTime, nullable=True)
    raw_json = Column(Text, nullable=True)
    is_archived = Column(Boolean, default=False, server_default="0")    # 是否归档
    # 墓碑机制（v0.5.1）：最近一次确认仍在线的时间 / 连续两次缺席判定的删除时刻
    last_seen_at = Column(DateTime, nullable=True)
    deleted_detected_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)
