/**
 * 「优质投稿」口径（R37-P1，devlog/141）—— 排序判断，纯函数可单测。
 *
 * 用户口径（2026-09-17）：「卡片内容由用户自定义，例如有纪念日、**优质投稿**、大事记、
 * 时间线等等」。P1 只做**只读**的两种卡片，所以这里只回答一个问题：**哪几条算"优质"**。
 *
 * 排序规则（写死在这里、由单测钉住，而不是散在组件里）：
 *   1. **已删的不算**（`deleted_detected_at`）—— 墓碑帖不该出现在"优质"里；
 *   2. 优先**投稿**（`type === 'video'`）：一条投稿都没有时退回全部类型（微博号没有 video）；
 *   3. 主指标 **播放量**（`stats.view`）；投稿没有播放量时用**点赞**兜底；
 *   4. 同分按**发布时间倒序**（新的在前）—— 否则同分顺序会随数据顺序漂，卡片每次开都不一样。
 */
import type { Post, PostStatsJson } from '../../api/types'
import { parseStats } from '../../utils/format'

export interface RankedPost {
  post: Post
  /** 参与排序的分数 */
  score: number
  /** 分数来自哪个指标（卡片上要如实标注是"播放"还是"点赞"） */
  metric: 'view' | 'like'
}

function scoreOf(post: Post): { score: number; metric: 'view' | 'like' } {
  const stats: PostStatsJson = parseStats(post.stats_json)
  const view = stats.view ?? 0
  if (view > 0) return { score: view, metric: 'view' }
  return { score: stats.like ?? 0, metric: 'like' }
}

function timeOf(post: Post): number {
  const t = post.published_at ? Date.parse(post.published_at) : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * 「随机投稿」取样（R42，用户 2026-09-19：「优质投稿改为**随机投稿**，并且在卡片中
 * **随机展示投稿**」）。
 *
 * 与 `rankTopPosts` 的区别：那个回答"哪几条最优质"，这个回答"随机给几条能看的"。
 * 仍然先过一道**可看性**筛（墓碑帖、没有封面的纯文字帖不该被随机到 ——
 * 用户要的是"封面更大更明显"，随机到一张没有封面的会让卡片空一块）：
 *   1. 排除已删（`deleted_detected_at`）；
 *   2. 优先**有封面**的（`cover_url`）；一条都没有时退回全部（微博号可能都没封面）；
 *   3. 优先投稿（`type === 'video'`），同上退回。
 *
 * `rand` 可注入 ⇒ 单测可确定性验证（默认 `Math.random`）。
 */
export function pickRandomPosts(posts: Post[], limit = 2,
                                rand: () => number = Math.random): Post[] {
  const alive = posts.filter((p) => !p.deleted_detected_at)
  if (!alive.length) return []
  const withCover = alive.filter((p) => !!p.cover_url)
  const base = withCover.length ? withCover : alive
  const videos = base.filter((p) => p.type === 'video')
  const pool = videos.length ? videos : base
  // 洗牌（Fisher–Yates）后取前 limit —— 不用 sort(random) ：那个分布不均且慢
  const arr = [...pool]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, Math.max(0, limit))
}

/** 卡片上那句"数据来源/口径"提示（随机取样时不再谈"优质"）。 */
export function randomPostsHint(posts: Post[], picked: Post[]): string {
  const alive = posts.filter((p) => !p.deleted_detected_at).length
  if (!alive) return '还没有抓到投稿'
  if (!picked.length) return '还没有带封面的投稿'
  return `从 ${alive} 条里随机取 ${picked.length} 条 · 点「换一批」再来`
}

/** 取"优质投稿"前 `limit` 条（顺序即展示顺序）。 */
export function rankTopPosts(posts: Post[], limit = 3): RankedPost[] {
  const alive = posts.filter((p) => !p.deleted_detected_at)
  const videos = alive.filter((p) => p.type === 'video')
  const pool = videos.length ? videos : alive
  return pool
    .map((post) => ({ post, ...scoreOf(post) }))
    .sort((a, b) => (b.score - a.score) || (timeOf(b.post) - timeOf(a.post)))
    .slice(0, limit)
}

/** 卡片头部那句话：有几条候选、按什么排（**如实说**，别让"没数据"看起来像"没有好内容"）。 */
export function topPostsHint(posts: Post[], ranked: RankedPost[]): string {  if (!ranked.length) return '这个账号还没有入库投稿'
  const videos = posts.filter((p) => p.type === 'video' && !p.deleted_detected_at).length
  const metric = ranked[0].metric === 'view' ? '播放' : '点赞'
  return videos ? `按${metric}排序 · 共 ${videos} 条投稿` : `按${metric}排序 · 暂无投稿，取全部动态`
}