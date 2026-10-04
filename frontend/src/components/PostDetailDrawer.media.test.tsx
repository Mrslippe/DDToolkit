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

const refreshMedia = vi.fn()
const clientLog = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, dropped: false }))
vi.mock('../api/api', () => ({
  imgProxyUrl: (s: string) => `/api/img-proxy?url=${encodeURIComponent(s)}`,
  videoProxyUrl: (s: string) => `/api/video-proxy?url=${encodeURIComponent(s)}`,
  resolveAsset: (p: string | null | undefined) => (p ? `/api/${p}` : undefined),
  api: {
    clientLog: (...a: unknown[]) => clientLog(...a),
    refreshMedia: (...a: unknown[]) => refreshMedia(...a),
  },
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
/** 重取回来的**新签发**地址（同一张图，签名换了一批） */
const NEW_REMOTE = 'http://sns-webpic-qc.xhscdn.com/202610041200/f00d/notes_pre_post/x!nd_dft.webp'
/** 列表里**另一条**帖子的图（用来验"上一条的重取结果不会漏到下一条"） */
const OTHER_REMOTE = 'http://sns-webpic-qc.xhscdn.com/202610040900/beef/notes_pre_post/z!nd_dft.webp'
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
  refreshMedia.mockReset()
  // 缺省"重取什么都没拿到"：别的用例只关心本地兜底，不该被这条链绊倒
  refreshMedia.mockResolvedValue({ ok: true, pinned: 0, post: null })
  clientLog.mockClear()
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
/** 冲掉 `refreshMedia().then(...)` 那几层微任务，让 `setPatched` 落到 DOM 上 */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const hasSrc = (url: string) => imgs().some((i) => i.getAttribute('src') === url)
/** 重取返回的**新的一整帖**（后端顺手固化过，前端只管替换渲染） */
const refetched = (url: string, extra: Partial<Post> = {}) => post({
  body_json: JSON.stringify({ text: '正文', images: [{ url }] }),
  ...extra,
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

/**
 * **打开时重取**（用户口径里的"备选项"，2026-10-04 devlog/320）。
 *
 * 本地没有副本 + 远端签名过期 ⇒ 四级全走完。图床地址是平台**限时签发**的，
 * 盘上没有副本时只有回源重签一条路（`POST /posts/{id}/refresh-media`）。
 *
 * 三条纪律各有判据：**只试一次**（N 张坏图不能变成 N 个请求）、
 * **失败不打扰用户**（照旧占位，只留一行诊断）、**换了帖就丢掉**
 * （否则会拿上一条的地址渲染下一条）。
 */
describe('详情页 · 打开时重取（devlog/320）', () => {
  it('四级全失败 ⇒ 重取一次，并把**新签发**的地址就地换上', async () => {
    refreshMedia.mockResolvedValue({ ok: true, pinned: 1, post: refetched(NEW_REMOTE) })
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [''] })} open onClose={() => {}} />))

    failOnce()
    failOnce()                                    // 没有本地副本 ⇒ 这两跳之后就是占位
    await settle()

    expect(refreshMedia).toHaveBeenCalledTimes(1)
    expect(refreshMedia).toHaveBeenCalledWith(1)
    expect(hasSrc(NEW_REMOTE), '重取回来的新地址没画出来 —— 那"重取"就白做了').toBe(true)
  })

  it('一帖只重取一次：N 张坏图 + 重复报错也只发一个请求（别把上游打爆）', async () => {
    const second = 'http://sns-webpic-qc.xhscdn.com/202610030051/def/notes_pre_post/y!nd_dft.webp'
    refreshMedia.mockResolvedValue({ ok: true, pinned: 1, post: refetched(NEW_REMOTE) })
    act(() => root.render(
      <PostDetailDrawer
        post={post({
          images_local: ['', ''],
          body_json: JSON.stringify({ text: '正文', images: [{ url: REMOTE }, { url: second }] }),
        })}
        open onClose={() => {}} />))

    failOnce()
    failOnce()                                    // 两张同时走到占位 ⇒ onAllFailed 被叫两次
    failOnce()                                    // 收到新帖之前又失败一轮
    await settle()

    expect(refreshMedia, '两张坏图变成了两个请求').toHaveBeenCalledTimes(1)
    expect(hasSrc(NEW_REMOTE)).toBe(true)
  })

  it('URL 没变但**本地副本新到位**也要重画（重取的常见结果就是"顺手固化"）', async () => {
    refreshMedia.mockResolvedValue({
      ok: true, pinned: 1, post: refetched(REMOTE, { images_local: [LOCAL] }),
    })
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [''] })} open onClose={() => {}} />))
    failOnce()
    failOnce()                                    // 旧帖：没有副本 ⇒ 占位
    await settle()
    // 新帖：同一个远端地址 + 新到位的本地副本 ⇒ 必须**重置到第一级**，否则那个实例
    // 还停在 failed 上，连 `<img>` 都不再渲染 ⇒ 兜底的本地副本也就永远用不上
    expect(hasSrc(REMOTE), '副本到位后没有重画').toBe(true)
    failOnce()
    failOnce()
    expect(hasSrc(`/api/${LOCAL}`), '落地了本地副本却没兜住').toBe(true)
  })

  it('重取失败 ⇒ **不打扰用户**：详情照旧、只留一行诊断', async () => {
    refreshMedia.mockRejectedValue(new Error('429 太频繁'))
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [''] })} open onClose={() => {}} />))

    failOnce()
    failOnce()
    await settle()

    expect(document.body.textContent, '详情页不该因为重取失败就空掉').toContain('标题')
    expect(clientLog).toHaveBeenCalled()
    expect(String(clientLog.mock.calls[0][0])).toContain('重取媒体失败')
  })

  it('换了帖就把重取回来的那份丢掉（上一条的地址不许漏到下一条）', async () => {
    refreshMedia.mockResolvedValue({ ok: true, pinned: 1, post: refetched(NEW_REMOTE) })
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [''] })} open onClose={() => {}} />))
    failOnce()
    failOnce()
    await settle()
    expect(hasSrc(NEW_REMOTE)).toBe(true)

    // 父级点了列表里另一条（同一个抽屉实例、post 换人）
    act(() => root.render(
      <PostDetailDrawer
        post={post({ id: 2, platform_post_id: 'n2',
                     body_json: JSON.stringify({ text: '正文', images: [{ url: OTHER_REMOTE }] }) })}
        open onClose={() => {}} />))

    expect(hasSrc(OTHER_REMOTE), '换了帖却没渲染新帖自己的图').toBe(true)
    expect(hasSrc(NEW_REMOTE), '上一条重取来的地址漏到下一条了').toBe(false)
  })
})
