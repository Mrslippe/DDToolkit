from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, field_serializer


# ── Account ────────────────────────────────────────────────────────

class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    vtuber_id: int
    platform: str
    platform_uid: str
    display_name: str | None = None
    avatar_url: str | None = None
    avatar_path: str | None = None
    sign: str | None = None
    url: str | None = None
    followers_count: int = 0
    room_id: str | None = None
    live_status: int = 0
    live_title: str | None = None
    live_url: str | None = None
    last_fetched_at: datetime | None = None


class AccountCreate(BaseModel):
    platform: str
    platform_uid: str
    display_name: str | None = None
    avatar_url: str | None = None
    sign: str | None = None
    url: str | None = None
    room_id: str | None = None


class AccountUpdate(BaseModel):
    platform: str | None = None
    platform_uid: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    sign: str | None = None
    url: str | None = None
    room_id: str | None = None


# ── Account 统计快照（P0，v0.5.0） ─────────────────────────────────

class AccountStatSnapshotOut(BaseModel):
    """粉丝数/直播状态时间序列点；captured_at 与 PostOut 同样处理 naive UTC。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    account_id: int
    followers_count: int | None = None
    live_status: int | None = None
    live_title: str | None = None
    captured_at: datetime

    @field_serializer("captured_at")
    def _ser_captured_at(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


# ── VTuber ─────────────────────────────────────────────────────────

class VTuberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    faction: str | None = None
    birthday: str | None = None
    debut_date: str | None = None
    setting: str | None = None
    avatar: str | None = None
    background_path: str | None = None
    notes: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    accounts: list[AccountOut] = []


class VTuberCreate(BaseModel):
    name: str
    faction: str | None = None
    birthday: str | None = None
    debut_date: str | None = None
    setting: str | None = None
    avatar: str | None = None
    notes: str | None = None


class VTuberUpdate(BaseModel):
    faction: str | None = None
    name: str | None = None
    birthday: str | None = None
    debut_date: str | None = None
    setting: str | None = None
    avatar: str | None = None
    notes: str | None = None


# ── Post ───────────────────────────────────────────────────────────

class PostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    platform: str
    platform_uid: str
    platform_post_id: str
    type: str = "text"
    title: str | None = None
    summary: str | None = None
    cover_url: str | None = None
    permalink: str | None = None
    body_json: str | None = None
    stats_json: str | None = None
    published_at: datetime | None = None
    raw_json: str | None = None
    is_archived: bool = False
    created_at: datetime | None = None

    @field_serializer("published_at")
    def _ser_published_at(self, v: datetime | None):
        # 库内 published_at 为 naive UTC（SQLite 存储抹掉 tz）；补 +00:00
        # 避免前端按本地时区解析导致时间偏移 8 小时
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class PostCreate(BaseModel):
    platform: str
    platform_uid: str
    platform_post_id: str
    type: str = "text"
    title: str | None = None
    summary: str | None = None
    cover_url: str | None = None
    permalink: str | None = None
    body_json: str | None = None
    stats_json: str | None = None
    published_at: datetime | None = None
    raw_json: str | None = None
    is_archived: bool = False


class PostUpdate(BaseModel):
    """Post 部分更新 — 仅提交需要变更的字段"""
    type: str | None = None
    title: str | None = None
    summary: str | None = None
    cover_url: str | None = None
    permalink: str | None = None
    body_json: str | None = None
    stats_json: str | None = None
    published_at: datetime | None = None
    raw_json: str | None = None
    is_archived: bool | None = None


# ── 分页 / 统计（前端帖子列表用） ────────────────────────────────────

class PostPage(BaseModel):
    """服务端分页响应"""
    items: list[PostOut]
    total: int
    page: int
    page_size: int


class PostStats(BaseModel):
    """某账号帖子统计概览"""
    platform: str
    platform_uid: str
    total: int
    archived: int
    by_type: dict[str, int]
    earliest: datetime | None = None
    latest: datetime | None = None

    @field_serializer("earliest", "latest")
    def _ser_dt(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v