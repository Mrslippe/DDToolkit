import type { FetchPostsResult, FetchResult, FetchStatus, Post, PostPage, PostStats, UpdatePostsResult, VTuber } from './types'

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
  return (await resp.json()) as T
}

export interface PostListParams {
  page: number
  page_size: number
  type?: string
  is_archived?: boolean
}

export const api = {
  /** 全部 VTuber（含嵌套 accounts） */
  listVtubers: () => request<VTuber[]>('/vtuber/list'),

  /** 抓取任务实时状态（TopBar 轮询用） */
  getFetchStatus: () => request<FetchStatus>('/vtuber/fetch-status'),

  /** 单个 VTuber */
  getVtuber: (id: number) => request<VTuber>(`/vtuber/${id}`),

  /** 帖子列表（服务端分页 + 过滤）；可传 signal 取消在途请求（切换 VTuber 防回写） */
  listPosts: (platform: string, uid: string, params: PostListParams, signal?: AbortSignal) => {
    const q = new URLSearchParams()
    q.set('page', String(params.page))
    q.set('page_size', String(params.page_size))
    if (params.type) q.set('type', params.type)
    if (params.is_archived !== undefined) q.set('is_archived', String(params.is_archived))
    return request<PostPage>(`/posts/${platform}/${uid}/paginated?${q.toString()}`, { signal })
  },

  /** 帖子统计概览（总数/类型分布/时间跨度） */
  postStats: (platform: string, uid: string) =>
    request<PostStats>(`/posts/${platform}/${uid}/stats`),

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

  /** 按 VTuber 名字触发帖子抓取 */
  fetchPostsByName: (name: string, videoPages = 2, dynamicsPages = 3) => {
    const q = new URLSearchParams({
      name,
      video_pages: String(videoPages),
      dynamics_pages: String(dynamicsPages),
    })
    return request<FetchPostsResult>(`/vtuber/fetch-posts?${q.toString()}`, { method: 'POST' })
  },
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

export type { Post }
