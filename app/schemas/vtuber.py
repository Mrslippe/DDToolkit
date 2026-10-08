from datetime import datetime, timezone

from app.models.vtuber import EVENT_KIND_EVENT, EVENT_KINDS

from pydantic import (BaseModel, ConfigDict, Field, field_serializer, field_validator,
                      model_validator)


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
    # P8-B（v0.9.7）：平台徽章顺序
    sort_order: int = 0


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
    # P8-B（v0.9.7）：顺序（「档案设置」窗口用）。
    # 注：`locked_fields` 已于 2026-09-13 退役（devlog/074）—— 平台昵称/签名允许被抓取
    # 覆盖，旧值改由 `vtuber_field_history` 记账（曾用名/曾用签名）。
    sort_order: int | None = None


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


# ── B 站检索（R11，devlog/083）─────────────────────────────────────

class BiliSearchItemOut(BaseModel):
    """一条 B 站检索结果（`/vtuber/bili-search`）：搜索接口字段归一化后的形状。"""
    platform: str = "bilibili"
    platform_uid: str
    name: str
    sign: str = ""
    followers: int = 0
    avatar: str = ""
    verified: str = ""          # 认证说明（如"bilibili 知名游戏UP主"）；空串=无认证
    is_live: bool = False
    room_id: str | None = None
    videos: int = 0
    level: int = 0
    exact: bool = False         # true = 按 UID 精确查到的单条（不是搜索命中）
    in_library: bool = False    # true = 该 (platform, uid) 已在库里


class BiliSearchOut(BaseModel):
    """检索响应：`error` 非空时 `items` 必为空，`hint` 是给用户看的人话说明。"""
    items: list[BiliSearchItemOut] = []
    page: int = 1
    total_pages: int = 0
    has_more: bool = False
    error: str | None = None
    hint: str | None = None
    exact: bool = False
    cached: bool = False


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
    # A0（devlog/255）：**只读派生**字段 —— 当前选中那张头像在**本地**的副本路径。
    # `avatar` 仍是远端 URL 原文（语义不动）；这个字段让渲染侧能在直连/代理都失败后
    # 回落到盘上那份（`ProxyImage.fallbackSrc`）。**不加库列**：由 `local_avatar_map()` 现查。
    avatar_local: str | None = None
    background_path: str | None = None
    #: 背景**取景**（需求 7，f011）：**JSON 原文**（`{"x":0..1,"y":0..1,"scale":1..3}`），
    #: 前端自己解析 —— 同 `profile_cards.config_json` 的口径，这一层不做二次建模。
    #: ⚠️ 前端遇到坏 JSON 必须退回"原样铺满"，不许白屏（这一格是可以被手工改坏的）。
    background_focus: str | None = None
    #: 背景**视频**（需求 9，f011）：`static/custom_bg/` 相对路径，NULL = 只有静态图。
    background_video_path: str | None = None
    #: **视频**的取景（需求 9 补丁，f012，`devlog/426`）：**JSON 原文**，形状与 `background_focus`
    #: 逐字相同（图片锚点 + 1..3 倍）。前端同样要能容忍坏值（退回"原样铺"）。
    background_video_focus: str | None = None
    notes: str | None = None
    # 签名来源与覆盖（2026-09-13，devlog/074）：卡片签名 = override → 来源账号 → 主账号
    sign_override: str | None = None
    sign_source_account_id: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    # 需求 4/5（f010）：左栏自定义顺序。前端"自定义"那一档直接读它；
    # 其余五档（名称/粉丝数/…）是**前端纯函数**排序，与这个字段无关。
    sort_order: int = 0
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
    # 签名来源与覆盖（2026-09-13，devlog/074）——档案设置窗口写这两个
    sign_override: str | None = None
    sign_source_account_id: int | None = None


class FormerValueOut(BaseModel):
    """一条「曾用值」（曾用名 / 曾用签名）。"""
    value: str
    platform: str | None = None      # 账号被删时为 None
    account_id: int | None = None
    changed_at: datetime | None = None


class VTuberFormerValuesOut(BaseModel):
    """V 的曾用名 / 曾用签名（各最多 5 条，最近优先）。

    单独一个端点而不是塞进 `VTuberOut`：`/vtuber/list` 会返回**全部** V，
    每 V 再查一次历史就是 N+1；这个数据只在「档案设置」窗口里用。
    """
    names: list[FormerValueOut] = []
    signs: list[FormerValueOut] = []


# ── 历次头像（R47，devlog/249）────────────────────────────────────────

class VtuberAvatarVersionOut(BaseModel):
    """一张可选的历次头像。

    - `id` / `first_seen_at` 为 None = 这一项只来自**账号现值**（账本里还没有它）：
      升级后尚未抓取过、或用户刚手工加了账号。前端照常展示，只是标不出"首次见到"；
    - `path` 是 `static/` 相对路径（前端用 `resolveAsset` 拼；拿不到本地文件时为 None，
      此时用 `url` 直连/走代理 —— 与头像取值链同一条兜底逻辑）。
    """
    id: int | None = None
    url: str
    path: str | None = None
    platform: str | None = None
    account_id: int | None = None
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None

    @field_serializer("first_seen_at", "last_seen_at")
    def _ser_avatar_dt(self, v: datetime | None):
        # 库内为 naive UTC（SQLite 抹掉 tz）；不补时区前端会按本地时区解析、差 8 小时
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class VTuberAvatarsOut(BaseModel):
    """历次头像可选项 + **当前用的是哪张**（R47）。

    `current_url` 是**推导**出来的（`vtubers.avatar` → B 站账号 → 首个账号），
    不是库里的一列：选中标记只有一份真源，选举与账号两条路写岔了谁也发现不了
    （口径见 `services/vtuber_avatars.py::current_avatar_url`）。
    """
    current_url: str | None = None
    versions: list[VtuberAvatarVersionOut] = []


# ── 通知汇总（M5-1，devlog/253）────────────────────────────────────────

class NoticeOut(BaseModel):
    """一条通知（目标架构 §2.1 的契约）。

    字段与前端 `utils/notificationHub.ts::Notice` **逐字对齐** —— 少一个键前端就画不出来，
    所以 `tests/test_notices.py` 有一条**键集合**契约用例盯着（反向验证：删字段 ⇒ 当场红）。
    `value` 是 M5 新增的"活数据"槽位（倒计时/进度独立成槽，自己刷新而不重排文案）。

    L1（`docs/design/notices/channel-and-layering.md`，2026-10-05）再加两个字段：

    - `form`（三形态）：`state` 现在有什么在发生 · `notice` 刚发生了什么（会自动已读）·
      `action` 需要用户决定。**持续时间与已读方式都由它推导**（不再手写五种时长）；
    - `createdAt`：条目**创建时刻**（服务端毫秒口径）—— 面板要显示"3 分钟前"，
      而 `expiresAt` 只能表达"什么时候没了"。老后端没有它 ⇒ 前端不显示相对时间（不猜）。
    - `read`（L4）：**已读方式**，`auto` = 到点自己消失（不需要用户确认）·
      `confirm` = 只能用户确认（落 `app_meta` 的已读集合）。
      ⚠️ 它与 `form` 的关系**不是推导出来的，是显式写下的**（见 `services/notices` 里
      `_read_mode` 的注释）：状态类是"事实变了"（既不是自动已读、也不该被用户 ack 掉），
      处置类是"用户看过了"。把两件事塞进一个字段，下一个平台接入时一定有人推错。
    """
    id: str
    kind: str                     # alert | progress | report | message（**视觉**：字形与点色）
    text: str
    value: str | None = None      # 活数据（如风控倒计时 "47s"）
    detail: str | None = None
    source: str | None = None
    sticky: bool = False
    expiresAt: int | None = None  # 毫秒（**服务端 `now` 口径**，见响应的 `now`）
    createdAt: int | None = None  # 毫秒（服务端 `now` 口径）；None = 老后端/算不出来
    form: str | None = None       # state | notice | action
    read: str = "auto"            # auto | confirm —— **已读方式的显式口径**（见下）
    action: dict | None = None    # {label, kind}


class NoticesOut(BaseModel):
    """`GET /vtuber/notices`：**已按优先级排序**的通知 + 服务端时间戳 + 手动任务忙标志。

    ⚠️ `now` 是这一刻服务端的毫秒时间：两扇窗各自 `Date.now()` 会差 1–2s，而 ttl 判定
    要以它为基准（目标架构 §4）。前端只负责"按 now 过滤过期"，不自己算绝对过期时刻。

    `manual_running`（M5-2 前置，devlog/258）与 `fetch-status` 里那个字段**同源**
    （`scheduler.manual_task_running()`：自动档持锁**不算**忙）——顶栏据此禁用按钮，
    与手动端点的 409 判据一致。带上它是为了让"删掉 `kickPoll`"不等于"按钮要等下一轮"。
    """
    now: int
    notices: list[NoticeOut] = []
    manual_running: bool = False


class NoticeAckIn(BaseModel):
    """`POST /vtuber/notices/ack` 的请求体：记**一条**或**一批**通知已读。

    `ids` 是 L1（2026-10-05）加的：面板的「一键已读」要一次清掉「需要处理」整组 ——
    让前端循环发 N 次单条 ack 会出现"清到一半失败、面板半干净"的中间态。
    两个字段都给了以 `ids` 为准（`id` 是既有调用方的兼容面）。
    """
    id: str = Field(default="", max_length=120)
    ids: list[str] = Field(default_factory=list, max_length=100)


class NoticeAckOut(BaseModel):
    """已读集合（**幂等**：同一个 id 记两次结果一样）。"""
    acked: list[str] = []


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
    is_pinned: bool = False                    # R35：平台置顶（列表按 is_pinned DESC 排最前）
    # L3（devlog/261）：**只读派生** —— 该帖封面的**本地副本**（`static/assets/cover/…`）。
    # 与 `VTuberOut.avatar_local` 同一套路（现查 `local_assets`，不加库列），但**渲染优先级相反**：
    # 封面是**我们主动固化**的，而远端反而常被防盗链拦 ⇒ 列表**本地优先**、远端着 `fallbackSrc`
    # （规格 §3.3）。抓取侧只固化 `is_archived=0` 的帖（每轮上限，见 `scheduler.COVER_PIN_PER_ROUND`）。
    cover_local: str | None = None
    # 媒体固化（devlog/319）：正文媒体的**本地副本**。
    # `images_local` 与 `body_json.images` **同序同长**（没有副本的位置是空串 —— 前端按索引对齐，
    # 不靠 URL 匹配）；`video_local` 是那条视频的本地副本（只在 `MEDIA_PIN_VIDEO` 开着时才有）。
    images_local: list[str] = []
    video_local: str | None = None
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
    B2 新增（2026-10-08）：`vod_url`（录播地址）/ `manual`（含用户手动记录成分）——
    两个都是**给人看和给人点**的字段，`manual` 由服务端按 `source` 分词判定
    （`app/domain/live_manual.py::is_manual_source`），前端不再自己拆字符串。
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
    vod_url: str | None = None                  # 录播地址（f013；唯一形态 https://www.bilibili.com/video/BV…）
    manual: bool = False                        # 这一场含"用户手动记录"成分（source 分词判定，服务端算）
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


class LiveSessionManualIn(BaseModel):
    """手动记录一场直播（B2，devlog/454）：`POST /account/{id}/live-sessions` 入参。

    用户口径（2026-10-08）：「日历上能手动补一场（时间/标题）+ 存录播地址」。

    - `start_at`/`end_at`：ISO 8601。**带偏移**（`…+08:00`）按偏移换算；**不带偏移**
      （`<input type="datetime-local">` 的产物）按**本机本地时区**解释 ——
      换算规则与理由见 `app/domain/live_manual.py::to_utc_naive`；
    - `end_at` 省略 = 未知/进行中（与自动场次同一口径，`None` 不是 0）；
    - `vod_url`：BV 号或 B 站视频链接，服务端规范化后入库（不合格 → 422 + 中文原因）。
    """

    start_at: datetime
    end_at: datetime | None = None
    title: str | None = None
    vod_url: str | None = None


class LiveSessionUpdateIn(BaseModel):
    """局部更新场次（PATCH）：只改传进来的字段（`exclude_unset`，同 `VtuberEventUpdate`）。

    ⚠️ 显式传 `end_at: null` = **清空结束时间**（改回"进行中"），与"没传"是两件事 ——
    所以路由层用 `model_dump(exclude_unset=True)` 而不是 `exclude_none`。

    `vod_url: ""` = 清空录播地址（用户删掉自己填的链接）。**只有手动记录的场次**
    能改时间/标题，自动抓来的场次只允许补录播地址（见路由层 400 的两个分支）。
    """

    start_at: datetime | None = None
    end_at: datetime | None = None
    title: str | None = None
    vod_url: str | None = None


class LiveSessionDeleteOut(BaseModel):
    """删除手动场次的回执（`deleted=false` 不会出现：删不掉就是 404/400）。"""
    deleted: bool
    live_id: str


class LiveWordOut(BaseModel):
    """词云词条（词 + 出现次数，气泡词云用）。"""
    text: str
    count: int


class LiveDanmakuInfo(BaseModel):
    """弹幕信息（danmakus：总量 + 词云热词）。

    `source` / `wc_status` 是 2026-09-13 新增（devlog/061）—— 用于在 UI 上**区分**
    三种此前混在「暂无热词数据」里的情况：

    | wc_status | 含义 | UI |
    |---|---|---|
    | `upstream` | 上游 `/api/v2/live` 直接给了 `extra.wordCloud` | 正常展示词云 |
    | `upstream_absent` | 上游**没给**热词（2026-09-13 实测 `extra` 字段整个消失） | 提示"上游未提供"+ 给「用弹幕自建」按钮 |
    | `self_built` | 用户点击后由本地分词自建（原始弹幕来自 `/api/v3/.../danmakus`） | 展示词云 + 标注来源为本地统计 |
    | `no_danmaku` | **问过上游**、确实没有这一场（2026-10-02 起：先按需现查一次才给这个态） | 提示"上游尚未收录本场"+「查一次」 |
    | `live` | 本场还在直播（`end_at` 为空）——上游要等结束后才收录 | 提示"正在直播中" |
    | `fetch_failed` | 拉取失败（网络/HTTP/被 WAF 拦） | 提示"拉取失败，可重试" |
    """
    total: int | None = None
    top_keywords: list[str] = []               # 兼容字段：仅词（旧前端）
    top_words: list[LiveWordOut] = []          # 带次数的词条（气泡词云 + hover 次数）
    hot_segments: list[dict] = []              # 预留：[{start, end, count}] 高浓度片段
    # 词云来源（D4 口径）
    source: str | None = None                  # upstream | self（自建）
    wc_status: str | None = None               # 见上表
    text_count: int | None = None              # 自建时：参与统计的文本弹幕条数
    engine: str | None = None                  # 自建时：分词引擎名（jieba / regex）


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

    与列表端同链路（merged + v2 信号栈），**只含本地库可推导的内容** ——
    上游取数（弹幕 / 指标 / 动态）已拆到 `LiveUpstreamOut`（2026-09-13，devlog/063）：
    原先它们挂在同一个响应里，上游慢时打开弹窗最坏要等 93s，且连不依赖上游的
    时间/分区/收益/分类也一起转圈。

    本响应保证**不发起任何第三方请求**（`analysis` 仍为预留字段）。
    """
    analysis: LiveAnalysisInfo | None = None


class LiveUpstreamOut(BaseModel):
    """场次详情里「必须打第三方」的那两格（2026-09-13，devlog/063）。

    | 字段 | 内容 | 失败时 |
    |---|---|---|
    | `danmaku` | 弹幕总量 + 上游词云（`wc_status` 区分六种情况） | `wc_status='fetch_failed'` |
    | `metrics` | 场次级指标（观看/点赞/打赏/互动/峰值/录制版本/频道累计） | `null` |
    | `events` | 直播中断/继续时间线（type 7/8） | `[]` |
    | `session_changed` | 这次请求**按需现查**补到了该场次的 danmakus 行（devlog/275） | `false` |

    非 danmakus 来源的已结束场次会**先现查一次**（`live_upstream.ensure_session_recorded`），
    查到了才接着取数；还在直播的场次**不请求网络**，直接回 `danmaku.wc_status='live'`。

    `session_changed` 的用途：现查补进来的那一行会带上弹幕数/收益/峰值/数据源，
    而弹窗手里那份**详情**是补之前取的 —— 前端据此重取一次详情，卡片才会整块一致
    （否则出现"词云有了、弹幕数还是空的"）。
    """
    danmaku: LiveDanmakuInfo | None = None
    metrics: LiveMetricsOut | None = None
    events: list[LiveEventOut] = []
    session_changed: bool = False


# ── 重要日期·大型活动（P7，v0.7.0） ────────────────────────────────

class VtuberEventOut(BaseModel):
    """手动维护的重要日期/活动条目（vtuber_events 表）。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    vtuber_id: int
    title: str
    event_date: str        # "YYYY-MM-DD"
    # R42-A（f007）：两张档案卡各取各的（纪念日 / 大事记时间轴）+ 自定义图标
    kind: str = EVENT_KIND_EVENT
    emoji: str | None = None
    created_at: datetime | None = None

    @field_serializer("created_at")
    def _ser_created_at(self, v: datetime | None):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class VtuberEventCreate(BaseModel):
    title: str
    event_date: str        # "YYYY-MM-DD"
    kind: str = EVENT_KIND_EVENT
    emoji: str | None = None

    @field_validator("title")
    @classmethod
    def _validate_title(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("title 不能为空")
        if len(v) > 60:
            raise ValueError("title 最长 60 字")
        return v

    @field_validator("kind")
    @classmethod
    def _validate_kind(cls, v: str) -> str:
        if v not in EVENT_KINDS:
            raise ValueError(f"kind 须是 {sorted(EVENT_KINDS)} 之一")
        return v

    @field_validator("emoji")
    @classmethod
    def _validate_emoji(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v[:8] or None          # 空串等同没填；长度封顶（防有人塞一整段文字）

    @field_validator("event_date")
    @classmethod
    def _validate_date(cls, v: str) -> str:
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("event_date 须为 YYYY-MM-DD")
        return v


class VtuberEventUpdate(BaseModel):
    """局部更新（R42-A）：只改传进来的字段。

    ⚠️ `emoji` 显式传 `None` = **清空**（与"没传"区分开）⇒ 路由里用
    `model_dump(exclude_unset=True)` 而不是 `exclude_none`。
    """
    title: str | None = None
    event_date: str | None = None
    kind: str | None = None
    emoji: str | None = None

    @field_validator("title")
    @classmethod
    def _validate_title(cls, v: str | None) -> str | None:
        return None if v is None else VtuberEventCreate._validate_title(v)

    @field_validator("kind")
    @classmethod
    def _validate_kind(cls, v: str | None) -> str | None:
        return None if v is None else VtuberEventCreate._validate_kind(v)

    @field_validator("emoji")
    @classmethod
    def _validate_emoji(cls, v: str | None) -> str | None:
        return VtuberEventCreate._validate_emoji(v)

    @field_validator("event_date")
    @classmethod
    def _validate_date(cls, v: str | None) -> str | None:
        return None if v is None else VtuberEventCreate._validate_date(v)


# ── 档案视图的卡片布局（R37-P2，devlog/142） ──────────────────────────

class ProfileCardOut(BaseModel):
    """一张卡片（`profile_cards` 表）。格位口径与前端 `profile/layoutModel.ts` 一致：
    12 列网格、`x` 从 0 起、`h` 以行计。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    card_key: str
    kind: str
    x: int
    y: int
    w: int
    h: int
    config_json: str | None = None


class ProfileCardIn(BaseModel):
    """保存时的一张卡（不带 id：整版替换由服务端重新分配）。"""
    card_key: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=64)
    x: int = Field(ge=0, le=11)
    y: int = Field(ge=0, le=999)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=24)
    config_json: str | None = None

    @model_validator(mode="after")
    def _fit_in_grid(self):
        # 越界**报错而不是夹取**：夹取会把前端的排布 bug 静默写进库
        # （用户下次打开发现卡片位置"自己变了"，且查不出是谁改的）。
        if self.x + self.w > 12:
            raise ValueError(f"卡片 {self.card_key} 超出 12 列（x={self.x} + w={self.w}）")
        return self


class ProfileLayoutIn(BaseModel):
    """整版布局（前端是"编辑一整张画布、松手存一次"）。"""
    cards: list[ProfileCardIn] = Field(max_length=50)

    @field_validator("cards")
    @classmethod
    def _unique_keys(cls, v: list[ProfileCardIn]) -> list[ProfileCardIn]:
        keys = [c.card_key for c in v]
        dup = {k for k in keys if keys.count(k) > 1}
        if dup:
            raise ValueError(f"card_key 重复：{sorted(dup)}")
        return v
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