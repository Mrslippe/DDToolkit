// @vitest-environment jsdom
/**
 * 详情页的媒体**本地兜底**（2026-10-04，devlog/319）。
 *
 * 用户口径：「把抓取时固化作为轻资产固化的一部分……把打开时重取作为一个备选项，
 * 如果本地没有缓存就回退到重取」。这一批落地的是前半句：**本地有副本就画本地那份**
 * （图床签名过期后远端 403，而盘上那份一直在）。
 *
 * 渲染链是 `ProxyImage` 的四级：**远端直连 → /img-proxy → 本地副本 → 占位**
 * （本地那一级靠 `fallbackSrc`），所以判据是"两次失败之后落在本地路径上"。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/api', () => ({
  imgProxyUrl: (s: string) => `/api/img-proxy?url=${encodeURIComponent(s)}`,
  videoProxyUrl: (s: string) => `/api/video-proxy?url=${encodeURIComponent(s)}`,
  resolveAsset: (p: string | null | undefined) => (p ? `/api/${p}` : undefined),
  api: { clientLog: () => Promise.resolve({ ok: true, dropped: false }) },
}))
vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

import PostDetailDrawer from './PostDetailDrawer'
import type { Post } from '../api/types'

// jsdom 没有这两样，而详情抽屉里的 OverlayScroll/radix 要用（照抄 avatarVersions.test.tsx）
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => false,
}))
Element.prototype.scrollTo = () => {}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const REMOTE = 'http://sns-webpic-qc.xhscdn.com/202610030051/abc/notes_pre_post/x!nd_dft.webp'
const LOCAL = 'static/assets/post_image/p1_deadbeef.webp'

function post(extra: Partial<Post> = {}): Post {
  return {
    id: 1, platform: 'xiaohongshu', platform_uid: 'u1', platform_post_id: 'n1',
    type: 'note', title: '标题', summary: null, cover_url: null, permalink: null,
    body_json: JSON.stringify({ text: '正文', images: [{ url: REMOTE }] }),
    stats_json: null, published_at: null, raw_json: null, note: null,
    is_archived: false, is_pinned: false, last_seen_at: null, deleted_detected_at: null,
    created_at: null,
    ...extra,
  } as Post
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''          // 抽屉走 portal（radix Dialog），DOM 挂在 body 上
})

/** ⚠️ 详情抽屉是 radix Dialog ⇒ **走 portal**，图片不在 `host` 里而在 `document.body` 上 */
const imgs = () => [...document.body.querySelectorAll<HTMLImageElement>('img')]
const failOnce = () => act(() => {
  imgs().forEach((i) => i.dispatchEvent(new Event('error')))
})

describe('详情页 · 媒体本地兜底（devlog/319）', () => {
  it('远端两跳都失败 ⇒ 画出**本地副本**（而不是灰块）', () => {
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [LOCAL] })} open onClose={() => {}} />))

    const first = imgs().find((i) => i.getAttribute('src')?.includes('xhscdn'))!
    expect(first, '第一跳是远端直连').toBeTruthy()
    failOnce()                                    // 直连失败 ⇒ 走 /img-proxy
    expect(imgs().some((i) => i.getAttribute('src')?.includes('/img-proxy'))).toBe(true)
    failOnce()                                    // 代理也失败 ⇒ 落到本地副本
    expect(imgs().some((i) => i.getAttribute('src') === `/api/${LOCAL}`),
           '本地有副本却没兜住 —— 那固化就白做了').toBe(true)
  })

  it('**没有**本地副本时保持原样：四级走完就是占位（不给假希望）', () => {
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [''] })} open onClose={() => {}} />))
    failOnce()
    failOnce()
    expect(imgs().some((i) => i.getAttribute('src')?.startsWith('/api/static/'))).toBe(false)
  })

  it('`images_local` 与 `images` **按索引**对齐（不是按 URL 猜）', () => {
    const second = 'http://sns-webpic-qc.xhscdn.com/202610030051/def/notes_pre_post/y!nd_dft.webp'
    const local2 = 'static/assets/post_image/p1_cafebabe.webp'
    act(() => root.render(
      <PostDetailDrawer
        post={post({
          images_local: ['', local2],           // 第一张没有副本、第二张有
          body_json: JSON.stringify({ text: '正文', images: [{ url: REMOTE }, { url: second }] }),
        })}
        open onClose={() => {}} />))

    // 两张都过两跳 ⇒ 第一张该落占位、第二张该落本地
    failOnce()
    failOnce()
    const srcs = imgs().map((i) => i.getAttribute('src'))
    expect(srcs).toContain(`/api/${local2}`)
    expect(srcs.filter((s) => s?.includes('p1_cafebabe')).length, '只有第二张有副本').toBe(1)
  })
})
