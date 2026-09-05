// 与后端 Pydantic schema 对齐的类型定义（app/schemas/vtuber.py）

export interface Account {
  id: number
  vtuber_id: number
  platform: string
  platform_uid: string
  display_name: string | null
  avatar_url: string | null
  avatar_path: string | null
  sign: string | null
  url: string | null
  followers_count: number
  room_id: string | null
  live_status: number // 0=离线 1=直播中
  live_title: string | null
  live_url: string | null
  last_fetched_at: string | null
}

export interface VTuber {
  id: number
  name: string
  faction: string | null
  birthday: string | null
  debut_date: string | null
  setting: string | null
  avatar: string | null
  background_path: string | null
  notes: string | null
  created_at: string | null
  updated_at: string | null
  accounts: Account[]
}

/** 候选池条目（vtubers.csv 离线索引） */
export interface PoolItem {
  name: string
  platform: string
  platform_uid: string
}

export interface Post {
  id: number
  platform: string
  platform_uid: string
  platform_post_id: string
  type: string
  title: string | null
  summary: string | null
  cover_url: string | null
  permalink: string | null
  body_json: string | null
  stats_json: string | null
  published_at: string | null
  raw_json: string | null
  is_archived: boolean
  /** 最近一次确认仍在线的时间（v0.5.1 墓碑机制） */
  last_seen_at: string | null
  /** 墓碑：已被判定删除的时刻（v0.5.1） */
  deleted_detected_at: string | null
  created_at: string | null
}

export interface PostPage {
  items: Post[]
  total: number
  page: number
  page_size: number
}

export interface PostStats {
  platform: string
  platform_uid: string
  total: number
  archived: number
  /** 墓碑数（v0.5.1） */
  deleted: number
  by_type: Record<string, number>
  earliest: string | null
  latest: string | null
}

/** 粉丝趋势点（P5）：date 按天分桶；source=self 直采 / zeroroku 回填 */
export interface FanTrendPoint {
  date: string
  fans: number
  source: string
}

/** 直播场次（P5：由 self 快照转移推导，5min 粒度近似） */
export interface LiveSession {
  account_id: number
  start_at: string
  end_at: string | null
  duration_minutes: number | null
  /** 场次标题（P7：场次内最后一条非空快照标题；用于日历格内展示） */
  live_title: string | null
}

/** 直播礼物日聚合（金额为原始字符串保精度） */
export interface GiftDay {
  id: number
  account_id: number
  source: string
  gift_date: string
  gift_amount: string | null
  guard_amount: string | null
  sc_amount: string | null
  total_amount: string | null
  room_id: string | null
  created_at: string | null
}

/** 第三方 VTuber 索引条目（P5 档案卡：企划/公会/房间号） */
export interface ThirdpartyVtuber {
  id: number
  platform: string
  platform_uid: string
  name: string
  type: string | null
  room_id: string | null
  group_name: string | null
  source: string
  updated_at: string | null
}

/** 重要日期·活动手动条目（P7：vtuber_events 表） */
export interface VtuberEvent {
  id: number
  vtuber_id: number
  title: string
  /** "YYYY-MM-DD" */
  event_date: string
  created_at: string | null
}

/** 未来直播预约（P7：reservation 帖 desc1 文本自动解析） */
export interface FutureReservation {
  post_id: number
  title: string
  /** 北京 wall-clock naive 时间串（服务端已按发布日推断年份） */
  start_at: string
  reserve_total: number
  rid: string | null
}

export interface FetchResult {
  status: string
  message?: string
  result?: {
    success: number
    failed: number
    skipped: number
    details: string[]
  }
}

/** POST /vtuber/fetch-posts 的响应结构（与 /vtuber/fetch 不同） */
export interface FetchPostsResult {
  status: string
  message?: string
  /** 前置归档规则刷新的条数（v0.4.7） */
  archived_first?: number
  total?: {
    videos: number
    dynamics: number
    stored: number
    skipped: number
  }
  /** 任一账号触发风控提前结束（B：前端据此提示"部分内容未抓全"） */
  rate_limited?: boolean
  /** 视频缺失估计 = B站参考总数 - 本轮已覆盖（方案 2） */
  video_missing?: number | null
  details?: Record<string, unknown>[]
}

/** POST /vtuber/update-posts 的响应结构 */
export interface UpdatePostsResult {
  status: string
  message?: string
  archived?: number
  /** 任一账号触发风控/中断（方案 1：前端据此提示） */
  rate_limited?: boolean
  total?: {
    dynamics: number
    stored: number
    skipped: number
  }
  details?: {
    platform_uid: string
    dynamics: number
    stored: number
    skipped: number
    archived_stop: boolean
    stopped_early: boolean
    rate_limited: boolean
  }[]
}

/** GET /vtuber/fetch-status：账号信息抓取实时状态 */
export interface AccountSnapshot {
  platform_uid: string
  display_name: string | null
  sign: string | null
  followers_count: number | null
  live_status: number | null
  live_title: string | null
  avatar_path: string | null
}

export interface AccountFetchStatus {
  running: boolean
  current: string | null
  index: number
  total: number
  /** 本轮任务内已完成的账号字段快照（按完成顺序追加），供侧栏就地增量刷新 */
  recent: AccountSnapshot[]
  /** 最近一次任务完成汇总（方案 1：TopBar 据此弹完成报告） */
  last_result?: {
    seq: number
    label: string
    success: number
    failed: number
    skipped: number
  }
}

/** GET /vtuber/fetch-status：帖子抓取实时状态 */
export interface PostFetchStatus {
  running: boolean
  target: string | null
  /** 最近一次任务完成汇总（方案 1+2：含中断账号与视频缺失估计） */
  last_result?: {
    seq: number
    kind: string
    label: string
    videos: number
    dynamics: number
    stored: number
    skipped: number
    issues: { label: string; stop_reason: string; error: string | null }[]
    video_missing: number | null
  }
}

export interface FetchStatus {
  account: AccountFetchStatus
  post: PostFetchStatus
}

/** stats_json 解析后的统计字段（B 站口径） */export interface PostStatsJson {
  view?: number
  like?: number
  comment?: number
  forward?: number
  favorite?: number
  coin?: number
  share?: number
  danmaku?: number
}

/** 直播预约卡片（body_json.reservation，后端从 additional.reserve 提取） */
export interface ReservationInfo {
  status?: number // 0=未预约(可预约) 1=已结束 2=已预约
  button_text?: string
  button_status?: number
  button_type?: number
  desc1?: string
  desc2?: string
  reserve_total?: number
}

/** 转发原文（body_json.origin） */
export interface OriginInfo {
  type?: string
  title?: string
  text?: string
  images?: { url: string; width?: number; height?: number }[]
  cover_url?: string
  permalink?: string
}

/** Quill Delta 富文本操作（B 站专栏/OPUS 格式） */
export interface DeltaOp {
  insert?: string | Record<string, unknown>
  attributes?: Record<string, unknown>
}

/** body_json 解析后的常见结构（按类型差异） */
export interface PostBodyJson {
  text?: string
  images?: { url: string; width?: number; height?: number }[]
  bvid?: string
  description?: string
  duration?: string
  duration_sec?: number
  cv_id?: number
  content?: string
  delta?: string // Quill Delta JSON（专栏富文本）
  reservation?: ReservationInfo
  origin?: OriginInfo
  room_id?: string
  live_status?: number
  [key: string]: unknown
}

/** GET /auth/{platform}/status：平台登录态 */
export interface AuthStatus {
  logged_in: boolean
  needs_login: boolean
  uid: string | null
  name: string | null
}

/** POST /auth/{platform}/qr/start */
export interface QrStartResult {
  qr_id: string
  url?: string
  image?: string
}

/** GET /auth/{platform}/qr/check */
export interface QrCheckResult {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed'
  detail?: string
}
