// @vitest-environment jsdom
/**
 * 标题与**纯文字封面**里的表情（2026-10-14 用户口径，`devlog/486`）：
 * 「同时在标题和仅有文字的封面也渲染表情包」。
 *
 * 起因：这两处此前是**原样字符串** —— 用户看到的是 `[梨安收藏集表情包_气鼓鼓]` 这串方括号，
 * 而他刚在正文里把表情调成了图。
 *
 * 判据钉三件事：
 * ① 卡片标题（`.post-card-title`）里画的是图，不是方括号；
 * ② **纯文字封面**（`.paper-title`，无封面图的帖子）同样画图；
 * ③ 两处都按 B站 的 `size` 分档（`size=2` ⇒ `.post-emoji--big`）——
 *    尺寸本身由 CSS 跟着该处字号走（那是样式，不在用例里断言 px）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveEmojis = vi.fn()
vi.mock('../api/api', () => ({
  api: { resolveEmojis: (...a: unknown[]) => resolveEmojis(...a) },
  imgProxyUrl: (src: string) => `/api/img-proxy?url=${encodeURIComponent(src)}`,
}))

import PostCard from './PostCard'
import type { Post } from '../api/types'
import { resetEmojiCache } from './common/PostText'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const BIG = 'UPOWER_1_气鼓鼓'
const SMALL = '委屈'

function post(extra: Partial<Post> = {}): Post {
  return {
    id: 1, platform: 'bilibili', platform_uid: 'u1', platform_post_id: 'p1',
    type: 'text', title: `好耶[${BIG}]`, summary: null, cover_url: null, permalink: null,
    body_json: JSON.stringify({ text: '正文' }),
    stats_json: null, published_at: null, raw_json: null, note: null,
    is_archived: false, is_pinned: false, last_seen_at: null, deleted_detected_at: null,
    created_at: null,
    ...extra,
  } as Post
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  // ⚠️ 表情缓存是**模块级**的：不清就会命中上一条用例留下的结果
  resetEmojiCache()
  resolveEmojis.mockReset().mockResolvedValue({
    items: {
      [BIG]: { url: 'https://cdn/big.png', size: 2 },
      [SMALL]: { url: 'https://cdn/small.png', size: 1 },
    },
    count: 2, why: null,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (p: Post) => act(() => {
  root.render(<PostCard post={p} index={0} onOpen={() => {}} />)
})
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

describe('卡片标题 / 纯文字封面里的表情', () => {
  it('★ 标题里的表情画成图（不再是那串方括号）', async () => {
    render(post())
    await settle()
    const title = host.querySelector('.post-card-title')!
    const img = title.querySelector<HTMLImageElement>('img.post-emoji')
    expect(img, '标题里没画表情 ⇒ 用户看到的还是一串方括号').toBeTruthy()
    expect(img!.src).toBe('https://cdn/big.png')
    expect(title.textContent).not.toContain(`[${BIG}]`)
    // 分档：size=2 ⇒ 大表情那一档
    expect(img!.className).toContain('post-emoji--big')
    // `title` 属性仍是**可读的原文**（hover 提示不该带图片）
    expect(title.getAttribute('title')).toBe(`好耶[${BIG}]`)
  })

  it('★ 没有封面图 ⇒ 纯文字封面里也画图（用户点名的那一处）', async () => {
    render(post())
    await settle()
    const paper = host.querySelector('.paper-title')
    expect(paper, '纯文字封面没渲染').toBeTruthy()
    const img = paper!.querySelector<HTMLImageElement>('img.post-emoji')
    expect(img, '纯文字封面里没画表情').toBeTruthy()
    expect(img!.src).toBe('https://cdn/big.png')
  })

  it('小表情（size=1）走小档；解析不出来的仍给 chip（两处兜底一致）', async () => {
    resolveEmojis.mockResolvedValue({
      items: { [SMALL]: { url: 'https://cdn/small.png', size: 1 } },
      count: 1, why: null,
    })
    render(post({ title: `抱歉[${SMALL}][没有这枚_表情]` }))
    await settle()
    const title = host.querySelector('.post-card-title')!
    const img = title.querySelector<HTMLImageElement>('img.post-emoji')!
    expect(img.className).not.toContain('--big')
    expect(title.querySelector('.post-emoji-chip')?.textContent).toBe('表情')
  })

  it('有封面图时照旧画封面（不再渲染纯文字那一支）', async () => {
    render(post({ cover_url: 'http://i0.hdslb.com/bfs/new_dyn/x.jpg' }))
    await settle()
    expect(host.querySelector('.paper-title')).toBeNull()
    expect(host.querySelector('img.post-card-cover-img')).toBeTruthy()
  })
})
