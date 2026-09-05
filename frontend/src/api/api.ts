import type { Account, FanTrendPoint, FetchPostsResult, FetchResult, FetchStatus, FutureReservation, GiftDay, LiveSession, PoolItem, PostPage, PostStats, ThirdpartyVtuber, UpdatePostsResult, VTuber, VtuberEvent } from './types'

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

  /** 直播场次（由 self 快照转移推导） */
  liveSessions: (accountId: number) =>
    request<LiveSession[]>(`/account/${accountId}/live-sessions`),

  /** 直播礼物日聚合（日期倒序；limit=0 全量） */
  giftDays: (accountId: number, limit = 0) =>
    request<GiftDay[]>(`/account/${accountId}/gift-days?limit=${limit}`),

  /** 第三方 VTuber 索引精确查询（企划/公会/房间号） */
  externalsVtuberByUid: (uid: string) =>
    request<ThirdpartyVtuber[]>(`/externals/vtubers/by-uid?uid=${encodeURIComponent(uid)}`),

  // ── P7 重要日期·大型活动 ─────────────────────────────────────────

  /** 手动事件列表（按日期升序） */
  listVtuberEvents: (vtuberId: number) =>
    request<VtuberEvent[]>(`/vtuber/${vtuberId}/events`),

  /** 添加手动事件 */
  createVtuberEvent: (vtuberId: number, data: { title: string; event_date: string }) =>
    request<VtuberEvent>(`/vtuber/${vtuberId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  /** 删除手动事件 */
  deleteVtuberEvent: (eventId: number) =>
    request<void>(`/vtuber/event/${eventId}`, { method: 'DELETE' }),

  /** 未来直播预约（reservation 帖自动解析；days=90 默认窗口） */
  futureReservations: (vtuberId: number, days = 90) =>
    request<FutureReservation[]>(`/vtuber/${vtuberId}/future-reservations?days=${days}`),

  /** 更新 VTuber 元信息（档案卡企划编辑等） */
  updateVtuber: (id: number, data: {
    faction?: string | null
    setting?: string | null
    notes?: string | null
    birthday?: string | null
    debut_date?: string | null
  }) =>
    request<VTuber>(`/vtuber/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
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

  /** 候选池检索：名称关键词 / uid 前缀，已入库条目自动剔除；signal 用于防抖取消在途请求 */
  searchPool: (kw: string, signal?: AbortSignal) =>
    request<PoolItem[]>(`/vtuber/pool/search?kw=${encodeURIComponent(kw)}`, { signal }),

  /** 从候选池收录 VTuber（后端建库后自动调度单V账号抓取） */
  adoptVtuber: (platform: string, platformUid: string, faction?: string) =>
    request<VTuber>('/vtuber/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, platform_uid: platformUid, faction: faction || null }),
    }),

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
