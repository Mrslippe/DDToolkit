import type { Post, PostBodyJson, PostStatsJson } from '../api/types'

/** UTC ISO 时间 → 本地时间显示（yyyy-MM-dd HH:mm） */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 数字 → 万/亿 缩写（万分位四舍五入取一位小数，避免 99999 → "10.0万" 的进位跳变） */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`
  if (n >= 10_000) return `${Math.round(n / 1_000) / 10}万`
  return String(n)
}

/** 帖子显示标题：title → 摘要前 20 字 → 平台帖子 ID（问题 3） */
export function postDisplayTitle(post: Pick<Post, 'title' | 'summary' | 'platform_post_id'>): string {
  const title = post.title?.trim()
  if (title) return title
  const summary = post.summary?.trim()
  if (summary) return summary.slice(0, 20)
  return post.platform_post_id
}

/** B 站图床 URL 规范化：http://i*.hdslb.com → https（避免混合内容拦截） */
export function normalizeImageUrl(url: string): string {
  return url.replace(/^http:\/\/([^/]*\.)?hdslb\.com\//, 'https://$1hdslb.com/')
}

/** 安全解析 JSON 字符串，失败返回默认值 */
export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** body_json 解析 */
export function parseBody(s: string | null | undefined): PostBodyJson {
  return parseJson<PostBodyJson>(s, {})
}

/** stats_json 解析 */
export function parseStats(s: string | null | undefined): PostStatsJson {
  return parseJson<PostStatsJson>(s, {})
}

/** 帖子类型 → 中文名 */
export const POST_TYPE_LABEL: Record<string, string> = {
  video: '视频',
  video_dynamic: '投稿',
  image: '图文',
  text: '文字',
  repost: '转发',
  article: '专栏',
  live: '直播',
  music: '音乐',
}

export function postTypeLabel(type: string): string {
  return POST_TYPE_LABEL[type] ?? type
}
