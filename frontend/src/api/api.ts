import type { Account, AccountStatSnapshot, BiliSearchResult, Capabilities, FanTrendPoint, FetchPostsResult, FetchResult, FetchStatus, LiveDanmakuInfo, LiveSession, LiveSessionDetail, LiveUpstream, PoolItem, PostPage, PostStats, ThirdpartyVtuber, UpcomingReservation, UpdatePostsResult, VTuber, VTuberFormerValues } from './types'

/**
 * API 基地址：
 * - Web 开发默认走 Vite 代理（/api → http://127.0.0.1:8000，见 vite.config.ts）
 * - 也可用 VITE_API_BASE 直连后端（如 http://127.0.0.1:8000），后端 CORS 已放开
 * - 桌面端（Tauri）启动时通过 setApiBase 注入 sidecar 实际端口
 */
export const DEFAULT_API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

let apiBase = DEFAULT_API_BASE

/** 桌面端引导完成后注入真实后端基地址 */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, '')
}

export function getApiBase(): string {
  return apiBase
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${apiBase}${path}`, init)
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`
    try {
      const body = await resp.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      /* 非 JSON 响应，保留默认信息 */
    }
    throw new Error(detail)
  }
  const text = await resp.text()
  return (text ? JSON.parse(text) : null) as T
}

export interface PostListParams {
  page: number
  page_size: number
  type?: string
  is_archived?: boolean
  is_deleted?: boolean
  q?: string
  date_from?: string
  date_to?: string
}

export const api = {
  /** 全部 VTuber（含嵌套 accounts） */
  listVtubers: () => request<VTuber[]>('/vtuber/list'),

  /** 抓取任务实时状态（TopBar 轮询用） */
  getFetchStatus: () => request<FetchStatus>('/vtuber/fetch-status'),

  /** 单个 VTuber */
  getVtuber: (id: number) => request<VTuber>(`/vtuber/${id}`),

  /** 上传卡片页自定义背景，返回更新后的 VTuber（含 background_path） */
  uploadBackground: (id: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<VTuber>(`/vtuber/${id}/background`, { method: 'POST', body: form })
  },

  /** 清除自定义背景，回退头像铺底，返回更新后的 VTuber */
  clearBackground: (id: number) =>
    request<VTuber>(`/vtuber/${id}/background`, { method: 'DELETE' }),

  /** 解除订阅：删除 VTuber（连带删其账号与全部帖子记录） */
  deleteVtuber: (id: number) => request<void>(`/vtuber/${id}`, { method: 'DELETE' }),

  /** 帖子列表（服务端分页 + 过滤）；可传 signal 取消在途请求（切换 VTuber 防回写） */
  listPosts: (platform: string, uid: string, params: PostListParams, signal?: AbortSignal) => {
    const q = new URLSearchParams()
    q.set('page', String(params.page))
    q.set('page_size', String(params.page_size))
    if (params.type) q.set('type', params.type)
    if (params.is_archived !== undefined) q.set('is_archived', String(params.is_archived))
    if (params.is_deleted !== undefined) q.set('is_deleted', String(params.is_deleted))
    if (params.q) q.set('q', params.q)
    if (params.date_from) q.set('date_from', params.date_from)
    if (params.date_to) q.set('date_to', params.date_to)
    return request<PostPage>(`/posts/${platform}/${uid}/paginated?${q.toString()}`, { signal })
  },

  /** 帖子统计概览（总数/类型分布/时间跨度） */
  postStats: (platform: string, uid: string) =>
    request<PostStats>(`/posts/${platform}/${uid}/stats`),

  // ── P5 档案视图 ────────────────────────────────────────────────

  /** 粉丝趋势点序列（服务端按天分桶降采样） */
  fanTrend: (accountId: number) =>
    request<FanTrendPoint[]>(`/account/${accountId}/fan-trend`),

  /** 账号信息快照（粉丝数/直播状态时间序列，时间倒序）。R9：账号信息历史弹窗用 */
  statSnapshots: (accountId: number, limit = 60) =>
    request<AccountStatSnapshot[]>(`/account/${accountId}/stat-snapshots?limit=${limit}`),

  /** 该 V 的曾用名 / 曾用签名（各最多 5 条，最近优先；只含**平台侧**旧值）。
   *  R9（devlog/080）：接入账号信息历史弹窗 —— 按账号过滤后展示。 */
  getFormerValues: (vtuberId: number) =>
    request<VTuberFormerValues>(`/vtuber/${vtuberId}/former-values`),

  /** 直播场次（由 self 快照转移推导） */
  liveSessions: (accountId: number) =>
    request<LiveSession[]>(`/account/${accountId}/live-sessions`),

  /** 单场次详情（详情弹窗）—— 只含本地库数据，不发起第三方请求（devlog/063） */
  liveSessionDetail: (accountId: number, liveId: string) =>
    request<LiveSessionDetail>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}`,
    ),

  /**
   * 场次详情里「必须打第三方」的那两格：弹幕词云 + 场次指标 + 直播动态（devlog/063）。
   *
   * 与详情端点分开：上游会间歇性变慢（实测 1.1s ↔ 15.6s，最坏 3×30s 重试），
   * 挂在详情里会让整个弹窗一起等。失败不抛错 —— 后端以降级字段如实回报
   * （`danmaku.wc_status='fetch_failed'` / `'no_danmaku'`），前端据此显示"没拉到"。
   *
   * `signal`：切场次/关弹窗时**取消在途请求**（上游最坏要等 90 多秒，
   * 用户早就不看这一场了）。走 `request()` 既有的 `init.signal`，见 devlog/064。
   */
  liveSessionUpstream: (accountId: number, liveId: string, signal?: AbortSignal) =>
    request<LiveUpstream>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}/upstream`,
      signal ? { signal } : undefined,
    ),

  /**
   * **按需**用原始弹幕自建词云（2026-09-13，danmakus 上游 `extra.wordCloud` 断供后）。
   *
   * 刻意与详情端点分开：自建要拉整场原始弹幕（实测单场可达 5 万条 / 数 MB），
   * 不能塞进"每次开弹窗"的请求里。用户点按钮才调（见 LiveSessionDialog）。
   *
   * `signal`：关弹窗 / 切场次时取消 —— 这条路径实测最长 **120s**（devlog/062 §四），
   * 用户早就不看它了，没必要让它在后台跑完（devlog/064 的同一套管道，devlog/069 补上）。
   */
  buildLiveSessionWordCloud: (accountId: number, liveId: string, signal?: AbortSignal) =>
    request<LiveDanmakuInfo>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}/wordcloud`,
      signal ? { signal } : undefined,
    ),

  /** 用户校正场次分类（v2 第⑦信号：override 最高优先，并反哺系列/词库） */
  setLiveSessionCategory: (accountId: number, liveId: string, category: string) =>
    request<{ category: string; category_from: string }>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}/category`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      },
    ),

  /** 撤除场次分类校正，恢复自动推断 */
  clearLiveSessionCategory: (accountId: number, liveId: string) =>
    request<void>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}/category`,
      { method: 'DELETE' },
    ),

  /** 第三方 VTuber 索引精确查询（企划/公会/房间号） */
  externalsVtuberByUid: (uid: string) =>
    request<ThirdpartyVtuber[]>(`/externals/vtubers/by-uid?uid=${encodeURIComponent(uid)}`),

  /** 更新 VTuber 元信息（P8-B：档案设置窗口 = 名称/头像/企划/生日/出道日/设定） */
  updateVtuber: (id: number, data: {
    name?: string
    avatar?: string | null
    faction?: string | null
    setting?: string | null
    notes?: string | null
    birthday?: string | null
    debut_date?: string | null
    /** 签名覆盖（null = 撤销覆盖，回落到"跟随来源账号"） */
    sign_override?: string | null
    /** 卡片签名跟随哪个账号（null = 主账号） */
    sign_source_account_id?: number | null
  }) =>
    request<VTuber>(`/vtuber/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  /** P8-B：部分更新账号（昵称 / 签名 / 顺序等）。
   *  2026-09-13（devlog/075）：`locked_fields` 已退役，且**本路径不再记曾用值**
   *  （手改不是"平台上曾经用过的"，见 `PUT /account` 的 docstring）。 */
  updateAccount: (accountId: number, data: {
    display_name?: string | null
    sign?: string | null
    avatar_url?: string | null
    url?: string | null
    sort_order?: number
  }) =>
    request<Account>(`/account/${accountId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  /** P8-B：删除账号（连带清理其帖子与从属数据） */
  deleteAccount: (accountId: number) =>
    request<void>(`/account/${accountId}`, { method: 'DELETE' }),

  /** P8-B：重排平台账号展示顺序（card 视图拖拽落库） */
  reorderAccounts: (vtuberId: number, accountIds: number[]) =>
    request<Account[]>(`/vtuber/${vtuberId}/account-order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_ids: accountIds }),
    }),

  /** 手动触发全量账号信息抓取（所有 VTuber） */
  triggerFetch: () =>
    request<FetchResult>('/vtuber/fetch', { method: 'POST' }),

  /** 抓取单个 VTuber 的账号信息 */
  fetchVtuber: (vtuberId: number) =>
    request<FetchResult>(`/vtuber/${vtuberId}/fetch`, { method: 'POST' }),

  /** 更新未归档动态贴文（先归档旧帖再抓取；name 省略 = 全部 VTuber） */
  updateUnarchivedPosts: (name?: string) => {
    const q = name ? `?name=${encodeURIComponent(name)}` : ''
    return request<UpdatePostsResult>(`/vtuber/update-posts${q}`, { method: 'POST' })
  },

  /** 按 VTuber 名字触发帖子抓取；full=true → 后台全量（视频+动态 -1，任务立即返回） */
  fetchPostsByName: (name: string, videoPages = 2, dynamicsPages = 3, full = false, platform = 'bilibili') => {
    const q = new URLSearchParams({
      name,
      platform,
      video_pages: String(videoPages),
      dynamics_pages: String(dynamicsPages),
    })
    if (full) q.set('full', 'true')
    return request<FetchPostsResult>(`/vtuber/fetch-posts?${q.toString()}`, { method: 'POST' })
  },

  /** 给 VTuber 添加平台账号（bilibili / weibo；添加后可触发账号信息抓取） */
  addAccount: (vtuberId: number, data: { platform: string; platform_uid: string; display_name?: string }) =>
    request<Account>('/vtuber/' + vtuberId + '/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // ── 候选池 / 收录（v0.5） ──────────────────────────────────────

  /** 本地候选检索：csv 池 + danmakus 索引合并，已入库条目自动剔除；
   *  signal 用于防抖取消在途请求（R11：返回项带 `origin` 标注来源） */
  searchPool: (kw: string, signal?: AbortSignal) =>
    request<PoolItem[]>(`/vtuber/pool/search?kw=${encodeURIComponent(kw)}`, { signal }),

  /** 直接从 B 站检索（R11，devlog/083）：纯数字按 UID 精确查，其余按名称搜。
   *  只在用户**显式触发**时调用（后端有 0.8s 串行 + 每分钟 20 次上限 + 5 分钟缓存）。 */
  biliSearch: (kw: string, page = 1, signal?: AbortSignal) =>
    request<BiliSearchResult>(
      `/vtuber/bili/search?kw=${encodeURIComponent(kw)}&page=${page}`, { signal }),

  /** 收录 VTuber（后端建库后自动调度单V账号抓取）。
   *  `source='bilibili'` = B 站直搜来源：池外条目后端会**实查 acc/info 复核**后才建库 */
  adoptVtuber: (platform: string, platformUid: string, faction?: string,
                source?: 'pool' | 'bilibili') =>
    request<VTuber>('/vtuber/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, platform_uid: platformUid, faction: faction || null,
                             source: source ?? null }),
    }),

  /** 当前能力矩阵：未登录时哪些能用、哪些受限（devlog/086）。前端提示的单一事实来源。 */
  capabilities: () => request<Capabilities>('/capabilities'),

  /** 某 V 的未来直播预约（R13；来自动态 reservation 帖的服务端解析）。
   *  `start_at` 是北京 wall-clock（naive），前端按本地时区解析即可。 */
  futureReservations: (vtuberId: number, days = 90) =>
    request<UpcomingReservation[]>(`/vtuber/${vtuberId}/future-reservations?days=${days}`),

  // ── 批量任务（拉取浮窗）────────────────────────────────────────

  /** 全量账号信息抓取（后台执行） */
  batchFetchAccounts: () =>
    request<{ status: string }>('/vtuber/fetch-accounts', { method: 'POST' }),

  /** 全量帖子抓取（视频+动态，后台执行） */
  batchFetchAllPosts: () =>
    request<{ status: string }>('/vtuber/batch/fetch-all-posts', { method: 'POST' }),

  /** 更新未归档帖（后台执行） */
  batchUpdateUnarchived: () =>
    request<{ status: string }>('/vtuber/batch/update-unarchived', { method: 'POST' }),

  /** 归档旧帖（默认 30 天前，同步返回归档数） */
  batchArchive: (days = 30) =>
    request<{ status: string; archived: number }>(`/vtuber/batch/archive?days=${days}`, {
      method: 'POST',
    }),

  // ── 登录（B 站 / 微博统一扫码 UI）─────────────────────────────────

  /** 生成扫码登录二维码：bilibili 返回 url；weibo 返回 image(base64 data URL) */
  startQrLogin: (platform: 'bilibili' | 'weibo') =>
    request<{ qr_id: string; url?: string; image?: string }>(`/auth/${platform}/qr/start`, {
      method: 'POST',
    }),

  /** 轮询扫码状态：waiting / scanned / confirmed / expired / failed */
  checkQrLogin: (platform: 'bilibili' | 'weibo', qrId: string) =>
    request<{ status: string; detail?: string }>(
      `/auth/${platform}/qr/check?qr_id=${encodeURIComponent(qrId)}`,
    ),

  /** 登录态（TopBar 徽章 / 登录对话框展示） */
  authStatus: (platform: 'bilibili' | 'weibo') =>
    request<{ logged_in: boolean; needs_login: boolean; uid: string | null; name: string | null }>(
      `/auth/${platform}/status`,
    ),
}

/** 后端返回的相对资源路径（如 static/avatars/x.jpg）→ 可访问 URL */
export function resolveAsset(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return `${apiBase}/${path.replace(/^\/+/, '')}`
}

/** 图片代理 URL（直连 CDN 失败时的兜底链路，后端 /img-proxy 带磁盘缓存） */
export function imgProxyUrl(src: string): string {
  return `${apiBase}/img-proxy?url=${encodeURIComponent(src)}`
}
