import { describe, expect, it } from 'vitest'

import type { Post } from '../../api/types'
import { rankTopPosts, topPostsHint } from './topPosts'

/**
 * 「优质投稿」排序口径（R37-P1，devlog/141）。
 *
 * 为什么值得单测：卡片上"哪三条"完全由这套规则决定，而它在界面上**看不出对错**
 * （数字都长得合理）—— 只有把规则钉住，改坏了才会红。四条规则各一条用例。
 */

let seq = 0
const mk = (over: Partial<Post> = {}): Post => {
  seq += 1
  return {
    id: seq, platform: 'bilibili', platform_uid: '1', platform_post_id: `p${seq}`,
    type: 'video', title: `视频 ${seq}`, summary: null, cover_url: null,
    permalink: null, body_json: null, stats_json: null,
    published_at: '2026-09-01T00:00:00Z', raw_json: null, note: null,
    is_archived: false, is_pinned: false, last_seen_at: null,
    deleted_detected_at: null, created_at: null, ...over,
  } as Post
}

const views = (n: number) => JSON.stringify({ view: n })

describe('rankTopPosts — 哪几条算优质', () => {
  it('按播放量降序', () => {
    const posts = [mk({ stats_json: views(10) }), mk({ stats_json: views(999) }),
                   mk({ stats_json: views(100) })]
    expect(rankTopPosts(posts).map((r) => r.score)).toEqual([999, 100, 10])
  })

  it('已删的墓碑帖不参与（哪怕播放最高）', () => {
    const posts = [
      mk({ stats_json: views(9999), deleted_detected_at: '2026-09-10T00:00:00Z' }),
      mk({ stats_json: views(10) }),
    ]
    const ranked = rankTopPosts(posts)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].score).toBe(10)
  })

  it('优先投稿：有 video 时动态不进榜', () => {
    const posts = [
      mk({ type: 'text', stats_json: views(99999) }),
      mk({ type: 'video', stats_json: views(12) }),
    ]
    const ranked = rankTopPosts(posts)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].post.type).toBe('video')
  })

  it('一条投稿都没有 → 退回全部类型（微博号没有 video，别显示成空卡）', () => {
    const posts = [mk({ type: 'text', stats_json: views(5) }),
                   mk({ type: 'image', stats_json: views(7) })]
    const ranked = rankTopPosts(posts)
    expect(ranked.map((r) => r.post.type)).toEqual(['image', 'text'])
  })

  it('没有播放量时用点赞兜底，并如实标 metric（卡片上要写"点赞"）', () => {
    const posts = [mk({ stats_json: JSON.stringify({ like: 30 }) }),
                   mk({ stats_json: views(5) })]
    const ranked = rankTopPosts(posts)
    expect(ranked[0].metric).toBe('like')
    expect(ranked[0].score).toBe(30)
    expect(ranked[1].metric).toBe('view')
  })

  it('同分按发布时间倒序（新的在前）—— 否则顺序会随数据顺序漂', () => {
    const posts = [
      mk({ stats_json: views(7), published_at: '2026-01-01T00:00:00Z', title: '旧' }),
      mk({ stats_json: views(7), published_at: '2026-09-01T00:00:00Z', title: '新' }),
    ]
    expect(rankTopPosts(posts).map((r) => r.post.title)).toEqual(['新', '旧'])
  })

  it('没有 stats 的帖子分数为 0，但仍然可上榜（榜位不足时不该空着）', () => {
    const ranked = rankTopPosts([mk({ stats_json: null })])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].score).toBe(0)
  })

  it('limit 生效（默认 3）', () => {
    const posts = Array.from({ length: 6 }, (_, i) => mk({ stats_json: views(i + 1) }))
    expect(rankTopPosts(posts)).toHaveLength(3)
    expect(rankTopPosts(posts, 5)).toHaveLength(5)
  })

  it('空列表 → 空榜（卡片显示空态，不崩）', () => {
    expect(rankTopPosts([])).toEqual([])
  })
})

describe('topPostsHint — 如实说清"按什么排、有几条"', () => {
  it('没有候选 → 明说还没有入库投稿', () => {
    expect(topPostsHint([], [])).toBe('这个账号还没有入库投稿')
  })

  it('有投稿 → 报条数与指标', () => {
    const posts = [mk({ stats_json: views(9) })]
    expect(topPostsHint(posts, rankTopPosts(posts))).toBe('按播放排序 · 共 1 条投稿')
  })

  it('退回全部类型时说明白（不让人以为"这个号没投稿"就是没内容）', () => {
    const posts = [mk({ type: 'text', stats_json: views(9) })]
    expect(topPostsHint(posts, rankTopPosts(posts))).toBe('按播放排序 · 暂无投稿，取全部动态')
  })
})