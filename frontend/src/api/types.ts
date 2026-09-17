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
  /** P8-B：平台徽章展示顺序（升序） */
  sort_order: number
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
  /**
   * 签名来源与覆盖（2026-09-13，devlog/074）：卡片签名 =
   * `sign_override`（手改的覆盖）→ `sign_source_account_id` 指向的账号 → 主账号。
   * 两者都**不动** `accounts.sign`（平台签名只读）。
   */
  sign_override: string | null
  sign_source_account_id: number | null
  created_at: string | null
  updated_at: string | null
  accounts: Account[]
}

/** 一条「曾用值」（曾用名 / 曾用签名）；platform 为 null = 账号已被删。
 *  2026-09-13（devlog/080）：已接入「账号信息历史」弹窗（`AccountHistoryDialog`）——
 *  只展示**平台侧**被覆盖掉的旧值（抓取覆盖前记账），手改不入账。 */
export interface FormerValueItem {
  value: string
  platform: string | null
  account_id: number | null
  changed_at: string | null
}

/** `GET /vtuber/{id}/former-values`：各最多 5 条，最近优先 */
export interface VTuberFormerValues {
  names: FormerValueItem[]
  signs: FormerValueItem[]
}

/** `GET /account/{id}/stat-snapshots`：账号信息快照（粉丝数/直播状态时间序列）。
 *  source：self = 本工具直采，zeroroku = 第三方回填（R4 的合并口径就吃这个字段）。 */
export interface AccountStatSnapshot {
  id: number
  account_id: number
  followers_count: number | null
  live_status: number | null
  live_title: string | null
  /** 采集时刻（UTC，带 +00:00） */
  captured_at: string
  source: string
}

/** 本地候选检索条目（R11，devlog/083：两个来源合并）
 *  - `origin='pool'`  = `vtubers.csv` 离线候选池（名称更规范，同 uid 时优先）
 *  - `origin='index'` = `thirdparty_vtubers`（danmakus 周级索引，`group` 是企划/公会） */
export interface PoolItem {
  name: string
  platform: string
  platform_uid: string
  origin?: 'pool' | 'index'
  /** 企划 / 公会（只有 index 来源有） */
  group?: string
}

/** 一条 B 站检索结果（`GET /vtuber/bili/search`） */
export interface BiliSearchItem {
  platform: string
  platform_uid: string
  name: string
  sign: string
  followers: number
  avatar: string
  /** 认证说明（如"bilibili 知名游戏UP主"）；空串 = 无认证 */
  verified: string
  is_live: boolean
  room_id: string | null
  videos: number
  level: number
  /** true = 按 UID 精确查到的单条（不是搜索命中） */
  exact: boolean
  /** true = 该账号已在库里（前端置灰"已订阅"） */
  in_library: boolean
}

/** `GET /vtuber/bili/search`：`error` 非空时 `items` 必为空，`hint` 是给用户看的原因 */
export interface BiliSearchResult {
  items: BiliSearchItem[]
  page: number
  total_pages: number
  has_more: boolean
  error: string | null
  hint: string | null
  exact: boolean
  cached: boolean
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
  /** P9-3（v0.9.6）：投稿动态的附言（并入同 bvid 的投稿帖，卡片/详情以「UP 主附言」标注） */
  note: string | null
  is_archived: boolean
  /** R35：平台置顶（B 站「置顶」/ 微博 isTop）。后端按 is_pinned DESC 排在本账号列表最前 */
  is_pinned: boolean
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

/** 直播场次（v0.9.x 内容管道：danmakus 主源 + self 快照 ±90min 合并；
 *  旧字段语义不变，M1+ 新增 source/category/分区/收益等） */
export interface LiveSession {
  account_id: number
  start_at: string
  end_at: string | null
  duration_minutes: number | null
  /** 场次标题（并集：danmakus/feed/快照标题，主数据优先） */
  live_title: string | null

  /** 数据源组合（danmakus / feed / self / danmakus+feed+self …，主数据在前） */
  source?: string
  live_id?: string | null
  room_id?: string | null
  parent_area_name?: string | null
  area_name?: string | null
  /** 场次收益（danmakus totalIncome，元） */
  total_income?: number | null
  /** 峰值在线（danmakus maxOnlineCount） */
  max_online_count?: number | null
  /** 弹幕数（danmakus danmakusCount） */
  danmakus_count?: number | null
  /** 场次封面（详情弹窗左列封面图） */
  cover_url?: string | null
  /** 中断续播并段数（v2 合并，1=单场；>1 表示该场为多次断开续播） */
  segment_count?: number
  /** 类型 key（服务端推断：game/chat/watch/upload/song/fitness/radio/collab/special/live） */
  category?: string
  /** 类型推断来源（v2：override/series/title/learned/area/date/fallback） */
  category_from?: string
}

/** 词云词条（词 + 出现次数，拼贴词云面积∝词频用） */
export interface LiveWord {
  text: string
  count: number
}

/** 词云来源（2026-09-13，devlog/061）：上游给的、还是本地自建的 */
export type WordCloudSource = 'upstream' | 'self'

/**
 * 词云状态 —— 用于在 UI 上**区分**此前混在「暂无热词数据」里的几种情况。
 *
 * | 值 | 含义 | UI |
 * |---|---|---|
 * | `upstream` | 上游 `/api/v2/live` 直接给了热词 | 正常展示 |
 * | `upstream_absent` | 上游**没给**热词（2026-09-13 实测该字段整个消失） | 提示 + 「用弹幕自建」按钮 |
 * | `self_built` | 用户点击后由本地分词自建 | 展示 + 标注来源 |
 * | `no_danmaku` | 本场确实没有弹幕记录 | 提示「本场无弹幕记录」 |
 * | `fetch_failed` | 拉取失败 | 提示「拉取失败，可重试」 |
 */
export type WordCloudStatus =
  | 'upstream' | 'upstream_absent' | 'self_built' | 'no_danmaku' | 'fetch_failed'

/** 弹幕信息（danmakus 场次级：总量 + 词云 + 来源标记） */
export interface LiveDanmakuInfo {
  total?: number | null
  top_keywords?: string[]
  /** 带次数的词条（拼贴词云） */
  top_words?: LiveWord[]
  /** 预留：[{ start, end, count }] 高浓度片段 */
  hot_segments?: Record<string, unknown>[]
  /** 词云来源：`upstream`=上游给的 / `self`=本地自建 */
  source?: WordCloudSource | null
  /** 词云状态（见 `WordCloudStatus`）——UI 据此决定展示词云还是给按钮 */
  wc_status?: WordCloudStatus | null
  /** 自建时：参与统计的文本弹幕条数 */
  text_count?: number | null
  /** 自建时：分词引擎名（jieba / regex） */
  engine?: string | null
}

/** 直播内容分析（预留接口：内容分析服务接入后填充，当前为 null） */
export interface LiveAnalysisInfo {
  summary?: string | null
  tags?: string[]
  /** 预留：高潮/名场面时间点 */
  highlights?: Record<string, unknown>[]
}

/** 场次级补充指标（A 组：danmakus /api/v2/live 同响应，2026-09-07 接入） */
export interface LiveMetrics {
  watch_count?: number | null
  like_count?: number | null
  pay_count?: number | null
  interaction_count?: number | null
  online_rank?: number | null
  comment_count?: number | null
  /** 弹幕是否全量录制 */
  is_full?: boolean | null
  /** 是否多录制源合并 */
  is_merged?: boolean | null
  /** 在线峰值 top5（高光时刻）[{ts: ms, count}] */
  peaks?: Record<string, unknown>[]
  /** 录制版本 [{user_name, is_official}] */
  versions?: Record<string, unknown>[]
  /** 频道累计：fans_count/total_danmakus_count/... */
  channel?: Record<string, unknown>
}

/** 直播间事件（B 组：type 7=直播中止 8=直播继续） */
export interface LiveEvent {
  type: number
  send_date?: string | null
}

/** 单场次详情（点击日期格 → 详情弹窗）—— **只含本地库可推导的内容**。
 *
 * 2026-09-13（devlog/063）：弹幕 / 指标 / 动态三样已拆到 `LiveUpstream`
 * （独立端点 `/live-sessions/{id}/upstream`）——原先它们挂在详情响应里，
 * 上游慢时整个弹窗一起转圈（最坏 93s）。本类型的端点不再发起任何第三方请求。
 */
export interface LiveSessionDetail extends LiveSession {
  analysis?: LiveAnalysisInfo | null
}

/** 场次详情里「必须打第三方」的那两格：弹幕词云 + 直播动态（devlog/063）。
 *
 * | 字段 | 失败时 |
 * |---|---|
 * | `danmaku` | `wc_status='fetch_failed'`（"没拉到"，**不是**"本场没有"） |
 * | `metrics` | `null` |
 * | `events` | `[]` |
 */
export interface LiveUpstream {
  danmaku?: LiveDanmakuInfo | null
  metrics?: LiveMetrics | null
  events?: LiveEvent[] | null
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
  /** true = 本次由**定时档**发起（综合档账号流）。自动节拍不占顶栏，见 TopBar 静默判定 */
  auto?: boolean
  current: string | null
  index: number
  total: number
  /** 运行中的任务名（P8-C；账号流恒为 'account'，与帖子流共用一套文案映射） */
  task?: string | null
  /** 当前正在抓的 VTuber 名（顶栏「任务 - V名 - i/N」用） */
  vtuber_name?: string | null
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
  /** true = 本次由**定时档**发起（动态流常态节拍，一轮接一轮、没有终局） */
  auto?: boolean
  target: string | null
  /** 运行中的任务名（P8-C）：dynamic / update / full / quick / adopt */
  task?: string | null
  /** 当前正在抓的 VTuber 名 */
  vtuber_name?: string | null
  /** 进度（P8-C）：i/N；动态流按轮次汇报，全量/更新按账号序号汇报 */
  index?: number
  total?: number
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

/** 外部第三方数据任务状态（收录回填 / 每日批次，v0.9.4） */
export interface ExternalFetchStatus {
  running: boolean
  /** 运行中的任务文案（并发时用「、」合并） */
  label: string | null
  /** 最近一次结束的任务文案（完成胶囊用） */
  last_label: string | null
  /** 完成序号：每次结束自增，前端据变化发 fetch-idle 刷新档案卡片 */
  seq: number
}

export interface FetchStatus {
  account: AccountFetchStatus
  post: PostFetchStatus
  external?: ExternalFetchStatus
  /**
   * 是否有**手动**任务在跑（含「已请求抢占、正等自动档让位」的窗口）——
   * 与手动端点的 409 判据同源（`scheduler.manual_task_running()`）。
   * 按钮禁用必须用它，不能用 `account.running || post.running`：后者把自动节拍
   * （动态流每轮 ~80s）也算忙，用户在轮询期间会点不动任何手动按钮，而后端其实受理。
   * 旧后端不返回该字段 → 前端退回旧判据（见 TopBar）。
   */
  manual_running?: boolean
  /** 风控冷却（R12a，devlog/089）：此前只在服务端日志里，顶栏据此显示告警。
   *  冷却窗口过去后自动变回 `active:false`，前端无需清理。
   *
   *  R27（devlog/125）新增 `platform` / `hits`：冷却**按平台**记账、连续命中会升级
   *  （1→base / 2→2×base / ≥3→4×base，封顶 60 分钟）。两个字段目前只有后端与用例在用，
   *  界面没吃（"让托盘用户看见哪个平台在冷却"归 R29）。 */
  rate_limit?: {
    active: boolean
    reason: string
    seconds_left: number
    platform?: string
    hits?: number
  }
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

/** 档案视图的一张卡片布局（f006，R37-P2）。格位口径与 `components/profile/layoutModel.ts` 一致：
 *  12 列网格、`x` 从 0 起、`h` 以行计。`card_key` 是**实例 id**（内置卡 = kind）。 */
export interface ProfileCardRow {
  id: number
  card_key: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  config_json: string | null
}

/** 保存时提交的一张卡（不带 id：服务端整版替换、重新分配 id） */
export interface ProfileCardInput {
  card_key: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  config_json?: string | null
}

/** 重要日期 / 大型活动（`vtuber_events` 表，P7 起；R37-P3 接进档案视图的「大事记」卡）。
 *  `event_date` 是 `YYYY-MM-DD` 本地日期字符串 —— 别用 `new Date(s)` 解析（会按 UTC 退一天）。 */
export interface VtuberEvent {
  id: number
  vtuber_id: number
  title: string
  event_date: string
  created_at: string | null
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

// ── 能力矩阵（GET /capabilities，devlog/086）──────────────────────────
//
// 三态：`full` 完整可用 · `degraded` 能用但完整性/稳定性打折 · `requires_login` 平台限制。
// 关键口径：**未登录不等于不可用** —— 本地浏览、检索、粉丝数、直播状态、第三方历史都能用；
// 只有"抓投稿/动态"这类内容接口被平台按 IP 拦（匿名 412），所以那些点必须**标注**而不是隐藏。

export type CapabilityState = 'full' | 'degraded' | 'requires_login'

export interface CapabilityFeature {
  id: string
  label: string
  /** 依赖哪个平台的登录态；null = 不需要登录 */
  platform: string | null
  /** 未登录时的固有状态（与 `state` 不同：`state` 是当前登录态下的实际状态） */
  anon_state: CapabilityState
  anon_note: string
  login_note: string
  /** 实测依据（含日期）—— 展示在详情里，别让"限制"变成没来由的一句话 */
  evidence: string
  /** 当前状态 */
  state: CapabilityState
  /** 给用户看的说明（当前状态下该说什么） */
  note: string
}

export interface CapabilityLimit {
  id: string
  label: string
  state: CapabilityState
  note: string
}

export interface Capabilities {
  bilibili_logged_in: boolean
  weibo_logged_in: boolean
  /** WBI 密钥状态；`anonymous=true` 表示密钥来自匿名 nav（未登录也能搜） */
  wbi: { cached: boolean; anonymous: boolean | null }
  features: CapabilityFeature[]
  /** 非 full 的那些 —— 前端渲染提示只读它 */
  limited: CapabilityLimit[]
  measured_at: string
}

/** `GET /vtuber/{id}/future-reservations`（R13）：服务端解析好的未来直播预约。
 *
 * ⚠️ 与 `ReservationInfo` 不是一回事：那个是动态 `body_json.reservation` 的**原始形状**，
 * 这个已经把 desc1 文本解析成时刻、过滤掉已结束/已过期、按时间升序。
 * `start_at` 是**北京 wall-clock（naive）** —— 直接 `new Date("YYYY-MM-DDTHH:mm:ss")`
 * 按本地时区解析即正确，别再自己加时区。 */
export interface UpcomingReservation {
  post_id: number
  title: string
  start_at: string
  /** 预约人数（danmakus/平台侧给的总数；0=未知） */
  reserve_total: number
  /** 预约卡片 id（可拼直播间/动态链接；可能为空） */
  rid: string | null
}

// ── 应用设置（GET/PUT /settings，R14a devlog/091）─────────────────────
//
// 后端把「范围 / 单位 / 生效时机 / 说明」一起下发（`runtime_settings.SPECS`），
// 前端**不再抄一份**：界面上的 min/max、单位、"下一轮生效"全部来自这里 ——
// 抄一份的下场是两边慢慢分叉，而用户看到的是界面允许、后端拒绝。

export interface SettingSpec {
  key: string
  kind: 'int' | 'float' | 'bool'
  default: number | boolean
  /** 闭区间；bool 为 null */
  min: number | null
  max: number | null
  label: string
  unit: string
  /** 左栏导航分类（大类：抓取设置 / 数据源）——导航由它生成，界面不写死清单 */
  group: string
  /** 页内小组标题（按用途分，例如「开播信息抓取」）；空串 = 该页不分组 */
  section: string
  /** 非关键项 → 收进页尾「高级（默认收起）」 */
  advanced: boolean
  /** 生效时机（"下一轮生效（不用重启）"等） */
  effect: string
  /** 额外说明（例如 0 = 关闭） */
  note: string
  /** 当前生效值 */
  value: number | boolean
  /** 是否被改过（≠ 默认值） */
  changed: boolean
}

/** 只读项：**不给改**，但要如实说明为什么（不是"忘了做"） */
export interface SettingReadonlyNote {
  key: string
  label: string
  why: string
}

// ── 存储占用（R22-B，devlog/104）──────────────────────────────────────

/** 一组占用的字节数与文件数 */
export interface StorageGroup {
  bytes: number
  files: number
}

/** `GET /settings/storage`：谁在占地方 + 缓存上限 + 磁盘余量 */
export interface StorageInfo {
  data_dir: string
  database: string
  groups: {
    database: StorageGroup
    img_cache: StorageGroup
    logs: StorageGroup
    other: StorageGroup
  }
  total_bytes: number
  /** 手工留下的 `vtuber.db.bak-*`（不是程序生成的，但确实占地方） */
  stale_backups: { name: string; bytes: number }[]
  disk: { free: number; total: number }
  img_cache_max_bytes: number
  /** 可用空间低于阈值（后端算好，界面不抄一份阈值） */
  low_space: boolean
  low_space_threshold_bytes: number
}

/** 两个存储动作的返回：做了什么 + **最新的占用**（免得界面再打一次接口） */
export interface StorageActionResult {
  files?: number
  bytes?: number
  wal_before?: number
  wal_after?: number
  freed_pages?: number
  storage: StorageInfo
}

export interface AppSettingsInfo {
  app_name: string
  version: string
  data_dir: string
  database: string
  port: number | null
  migration_head: string
  log_file: string
  cors_origins: string
  env_file: string
  pid: number
}

export interface AppSettings {
  specs: SettingSpec[]
  readonly: SettingReadonlyNote[]
  info: AppSettingsInfo
  /** 被改过的键 → 当前值（界面用来标"已改过"） */
  overrides: Record<string, number | boolean>
}

export interface AppSettingsSaved {
  ok: boolean
  changed: string[]
  values: Record<string, number | boolean>
  overrides: Record<string, number | boolean>
}

// ── 界面偏好（GET/PUT /settings/prefs，R14b devlog/092）───────────────
//
// 与 `SettingSpec` 分开：settings 是"抓取参数"（有范围、下一轮生效），
// prefs 是"界面长什么样"（枚举、立即生效）。

export interface PrefsOption {
  value: string
  label: string
}

export interface PrefsSpec {
  key: string
  label: string
  group: string
  options: PrefsOption[]
  /** 当前能力的事实说明（例如"深色主题尚未实现"）—— 由后端下发，界面照实显示 */
  note: string
}

export interface Prefs {
  values: Record<string, string>
  defaults: Record<string, string>
  specs: PrefsSpec[]
  changed: string[]
}

export interface PrefsSaved {
  ok: boolean
  changed: string[]
  values: Record<string, string>
}
