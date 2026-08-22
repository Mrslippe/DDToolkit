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
  birthday: string | null
  debut_date: string | null
  setting: string | null
  avatar: string | null
  notes: string | null
  created_at: string | null
  updated_at: string | null
  accounts: Account[]
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
  by_type: Record<string, number>
  earliest: string | null
  latest: string | null
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
  details?: Record<string, unknown>[]
}

/** POST /vtuber/update-posts 的响应结构 */
export interface UpdatePostsResult {
  status: string
  message?: string
  archived?: number
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
}

/** GET /vtuber/fetch-status：帖子抓取实时状态 */
export interface PostFetchStatus {
  running: boolean
  target: string | null
}

export interface FetchStatus {
  account: AccountFetchStatus
  post: PostFetchStatus
}

/** stats_json 解析后的统计字段（B 站口径） */
export interface PostStatsJson {
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
