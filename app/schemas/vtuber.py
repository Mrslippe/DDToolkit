from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, field_serializer, field_validator


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
    # P8-B（v0.9.7）：平台徽章顺序 + 手动编辑锁定字段（逗号分隔）
    sort_order: int = 0
    locked_fields: str | None = None


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
    # P8-B（v0.9.7）：顺序与字段锁定（「档案设置」窗口用）
    sort_order: int | None = None
    locked_fields: str | None = None


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
    source: str = "self"     # P4：self=直采 / zeroroku=第三方回填

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
    note: str | None = None                    # P9-3：投稿动态的附言（并入 video 帖）
    is_archived: bool = False
    last_seen_at: datetime | None = None       # 最近一次确认仍在线（v0.5.1）
    deleted_detected_at: datetime | None = None  # 墓碑：判定已删除的时刻（v0.5.1）
    created_at: datetime | None = None

    @field_serializer("published_at")
    def _ser_published_at(self, v: datetime | None):
        # 库内 published_at 为 naive UTC（SQLite 存储抹掉 tz）；补 +00:00
        # 避免前端按本地时区解析导致时间偏移 8 小时
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v

    @field_serializer("last_seen_at", "deleted_detected_at")
    def _ser_tombstone_dt(self, v: datetime | None):
        # 同上：墓碑时间同为 naive UTC，序列化补时区
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
    note: str | None = None                    # P9-3：投稿动态附言（并入 video 帖）
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
    note: str | None = None                    # P9-3：投稿动态附言
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
    deleted: int = 0       # 墓碑数（v0.5.1）：deleted_detected_at 非空
    by_type: dict[str, int]
    earliest: datetime | None = None
    latest: datetime | None = None

    @field_serializer("earliest", "latest")
    def _ser_dt(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


# ── 外部第三方数据（P4） ─────────────────────────────────────────────

class LiveGiftDayOut(BaseModel):
    """直播礼物日聚合（zeroroku 等，金额为原始字符串保精度）。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    account_id: int
    source: str
    gift_date: str
    gift_amount: str | None = None
    guard_amount: str | None = None
    sc_amount: str | None = None
    total_amount: str | None = None
    room_id: str | None = None
    created_at: datetime | None = None

    @field_serializer("created_at")
    def _ser_created_at(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class ThirdpartyVtuberOut(BaseModel):
    """第三方 VTuber 索引条目（企划/公会/房间号，候选池增强用）。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    platform: str
    platform_uid: str
    name: str
    type: str | None = None
    room_id: str | None = None
    group_name: str | None = None
    source: str
    updated_at: datetime | None = None

    @field_serializer("updated_at")
    def _ser_updated_at(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class FanTrendPoint(BaseModel):
    """粉丝趋势点（P5）：date 按天分桶；source 区分数据来源线条。"""
    date: str
    fans: int
    source: str


class LiveSessionOut(BaseModel):
    """直播场次（v0.9.x 内容管道 M1：danmakus 主源 + self 快照合并）。

    旧字段（start_at/end_at/duration_minutes/live_title）语义不变；
    M1 新增：source（danmakus/feed/self/danmakus+self）、live_id/room_id、
    分区（parent_area_name/area_name）、收益（total_income）、峰值在线
    （max_online_count）、弹幕数（danmakus_count）、类型推断（category/
    category_from，服务端读取时计算不落库）。
    """
    account_id: int
    start_at: datetime
    end_at: datetime | None = None
    duration_minutes: int | None = None
    live_title: str | None = None   # P7：场次标题（场次内最后一条非空快照标题）

    # ── M1 内容管道（v0.9.x） ──
    source: str = "self"                        # danmakus / feed / self / danmakus+self
    live_id: str | None = None                  # danmakus uuid 或 B站 live_id
    room_id: str | None = None
    parent_area_name: str | None = None
    area_name: str | None = None
    total_income: float | None = None           # danmakus totalIncome（元）
    max_online_count: int | None = None
    danmakus_count: int | None = None
    cover_url: str | None = None                # 场次封面（详情弹窗左列封面图）
    segment_count: int = 1                      # 中断续播并段数（v2 合并，1=单场）
    category: str = "live"                      # game/chat/watch/upload/song/fitness/radio/collab/special/live
    category_from: str = "fallback"             # override/series/title/learned/area/date/fallback

    @field_serializer("start_at", "end_at")
    def _ser_session_dt(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class LiveCategoryOut(BaseModel):
    """直播分类校正结果（v0.9.x 类型引擎 v2：PUT/DELETE 响应用）。"""
    category: str
    category_from: str = "override"


class LiveWordOut(BaseModel):
    """词云词条（词 + 出现次数，气泡词云用）。"""
    text: str
    count: int


class LiveDanmakuInfo(BaseModel):
    """弹幕信息（danmakus /api/v2/live，2026-09-07 接入：总量 + 词云热词）。"""
    total: int | None = None
    top_keywords: list[str] = []
    top_words: list[LiveWordOut] = []          # 带次数的词条（气泡词云 + hover 次数）
    hot_segments: list[dict] = []              # 预留：[{start, end, count}] 高浓度片段


class LiveAnalysisInfo(BaseModel):
    """直播内容分析（预留接口：后续内容分析服务接入后填充）。"""
    summary: str | None = None
    tags: list[str] = []
    highlights: list[dict] = []       # 预留：高潮/名场面时间点


class LiveMetricsOut(BaseModel):
    """场次级补充指标（A 组：/api/v2/live 同响应，2026-09-07 接入）。

    观看/点赞/打赏人数/互动/在线排名 + 弹幕完整性标记 +
    在线时间线峰值（高光时刻）+ 录制版本/频道累计。
    """
    watch_count: int | None = None
    like_count: int | None = None
    pay_count: int | None = None
    interaction_count: int | None = None
    online_rank: int | None = None
    comment_count: int | None = None
    is_full: bool | None = None              # 弹幕是否全量录制
    is_merged: bool | None = None            # 是否多录制源合并
    peaks: list[dict] = []                   # [{ts, count}] 在线峰值 top5（高光时刻）
    versions: list[dict] = []                # [{user_name, is_official}] 录制版本
    channel: dict = {}                       # 频道累计：fans_count/total_danmakus_count/...


class LiveEventOut(BaseModel):
    """直播间事件（B 组：type 7=直播中止 8=直播继续，2026-09-07 接入）。"""
    type: int
    send_date: datetime | None = None

    @field_serializer("send_date")
    def _ser_event_dt(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class LiveSessionDetailOut(LiveSessionOut):
    """单场次详情（user 2026-09-07：点击日期格 → 独立详情弹窗）。

    与列表端同链路（merged + v2 信号栈）；附扩展字段：
    danmaku（弹幕总量/词云）/ metrics（A 组场次级指标）/ events（B 组
    直播间事件）——danmakus 公开端点免鉴权接入，失败降级为 None/[]；
    analysis（内容分析）仍为预留。
    """
    danmaku: LiveDanmakuInfo | None = None
    metrics: LiveMetricsOut | None = None
    events: list[LiveEventOut] = []
    analysis: LiveAnalysisInfo | None = None


# ── 重要日期·大型活动（P7，v0.7.0） ────────────────────────────────

class VtuberEventOut(BaseModel):
    """手动维护的重要日期/活动条目（vtuber_events 表）。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    vtuber_id: int
    title: str
    event_date: str        # "YYYY-MM-DD"
    created_at: datetime | None = None

    @field_serializer("created_at")
    def _ser_created_at(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class VtuberEventCreate(BaseModel):
    title: str
    event_date: str        # "YYYY-MM-DD"

    @field_validator("event_date")
    @classmethod
    def _validate_date(cls, v: str) -> str:
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("event_date 须为 YYYY-MM-DD")
        return v


class FutureReservationOut(BaseModel):
    """自动解析的未来直播预约（P7：来自 reservation 帖 desc1 文本）。

    start_at 为服务端按发布日推断的本地时刻（前端直接展示，勿再换算时区）。
    """
    post_id: int
    title: str
    start_at: datetime
    reserve_total: int = 0
    rid: str | None = None

    @field_serializer("start_at")
    def _ser_res_start(self, v: datetime | None):
        # 预约时间为北京本地 wall-clock（无时区语义），序列化保持 naive——
        # 不补 +00:00，前端 new Date("YYYY-MM-DDTHH:mm:ss") 按本地时区解析即正确
        return v