import type { FetchPostsResult, FetchResult, Post, PostPage, PostStats, UpdatePostsResult, VTuber } from './types'

/**
 * API 基地址：
 * - 开发环境默认走 Vite 代理（/api → http://127.0.0.1:8000，见 vite.config.ts）
 * - 也可用 VITE_API_BASE 直连后端（如 http://127.0.0.1:8000），后端 CORS 已放开
 */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, init)
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

  /** 单个 VTuber */
  getVtuber: (id: number) => request<VTuber>(`/vtuber/${id}`),

  /** 帖子列表（服务端分页 + 过滤） */
  listPosts: (platform: string, uid: string, params: PostListParams) => {
    const q = new URLSearchParams()
    q.set('page', String(params.page))
    q.set('page_size', String(params.page_size))
    if (params.type) q.set('type', params.type)
    if (params.is_archived !== undefined) q.set('is_archived', String(params.is_archived))
    return request<PostPage>(`/posts/${platform}/${uid}/paginated?${q.toString()}`)
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
  return `${API_BASE}/${path.replace(/^\/+/, '')}`
}

/** 图片代理 URL（直连 CDN 失败时的兜底链路，后端 /img-proxy 带磁盘缓存） */
export function imgProxyUrl(src: string): string {
  return `${API_BASE}/img-proxy?url=${encodeURIComponent(src)}`
}

export type { Post }
