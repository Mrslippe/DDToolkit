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
vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve(),
  // B2（devlog/381）：进/出全屏时会调它切窗口表面；jsdom 里没有壳，给个空实现
  setSurfaceOpaque: () => Promise.resolve() }))

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

// ── 视频那条路要用的几个小工具（两个 describe 共用）─────────────────────────
const vid = () => document.body.querySelector('video')
/**
 * 把播放器的候选一条条打死（打到换成"播不了"兜底卡为止）。
 *
 * ⚠️ 每轮都要**重新看一次 DOM 里还有没有 `<video>`**：React 换 `src` 时**复用同一个
 * 元素**（不是重新挂载），所以"同一个引用"不等于"同一条地址"；打到判死之后组件才换成兜底卡。
 */
const killVideo = async () => {
  for (let i = 0; i < 6; i += 1) {
    const v = vid()
    if (!v) break
    await act(async () => { v.dispatchEvent(new Event('error')); await Promise.resolve() })
    if (document.body.querySelector('.vp-dead')) break
  }
}
/**
 * **手动控制重取什么时候回来**：真实网络有往返，不能让"重取回包"挤在同一轮微任务里
 * （那样 `setPatched` 会在我们还没烧完旧链时就把新地址换上，测的就不是用户看到的那条路）。
 */
const pendingRefresh: Array<(v: unknown) => void> = []
const deferRefresh = () => refreshMedia.mockImplementation(
  () => new Promise((res) => { pendingRefresh.push(res as never) }))
const answerRefresh = async (r: unknown) => {
  pendingRefresh.shift()!(r)
  await settle()
}

beforeEach(() => { pendingRefresh.length = 0 })

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

  it('重取失败 ⇒ 照旧显示详情，但**要说一句为什么**（不许让用户对着灰块猜）', async () => {
    refreshMedia.mockRejectedValue(
      new Error('小红书内容需要 Cookie（至少 a1 与 web_session）：没配置时我们不发起请求 —— 补救：设置 → 登录 → 小红书'))
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [''] })} open onClose={() => {}} />))

    failOnce()
    failOnce()
    await settle()

    expect(document.body.textContent, '详情页不该因为重取失败就空掉').toContain('标题')
    const hint = document.body.querySelector('[data-media-hint]')
    expect(hint?.textContent, '失败原因没露出来 —— 用户只会看到灰块').toContain('Cookie')
    expect(hint?.textContent).toContain('设置')
    expect(clientLog).toHaveBeenCalled()
    expect(String(clientLog.mock.calls[0][0])).toContain('重取媒体失败')
  })

  it('换帖后不留上一条的重取失败提示（提示与帖同生命周期）', async () => {
    refreshMedia.mockRejectedValue(new Error('小红书内容需要 Cookie'))
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [''] })} open onClose={() => {}} />))
    failOnce()
    failOnce()
    await settle()
    expect(document.body.querySelector('[data-media-hint]')).toBeTruthy()

    act(() => root.render(
      <PostDetailDrawer
        post={post({ id: 2, platform_post_id: 'n2',
                     body_json: JSON.stringify({ text: '正文', images: [{ url: OTHER_REMOTE }] }) })}
        open onClose={() => {}} />))

    expect(document.body.querySelector('[data-media-hint]'), '上一条的失败提示漏到下一条了')
      .toBeNull()
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

/**
 * **视频那条路也走重取**（2026-10-06 用户实机报障，devlog/363）。
 *
 * 抖音的播放地址（`v3-web.douyinvod.com/…?l=20261005191106…`）是**限时签名**的：
 * 实测存过夜之后 CDN 一律 403（带不带 Referer 都一样），而重取详情拿到的**新签发**地址
 * 带 `Referer: https://www.douyin.com/` 就 206。视频不像图片那样有本地副本
 * （`assets._media_urls` 里抖音视频**永远不固化**），所以"重取"是唯一出路 ——
 * 以前只有图片接了这条链，视频全失败就只是报一条 + 给个"在浏览器打开"。
 *
 * 与图片同一条纪律（一帖一次），另一条是**主语要说对**：提示语写"图片没能加载"，
 * 用户就会去翻图，而真正过期的是播放地址。
 */
describe('详情页 · 视频地址过期 ⇒ 重取（devlog/363）', () => {
  const OLD_V = 'https://v3-web.douyinvod.com/20261005191106/aaa/video.mp4'
  const NEW_V = 'https://v3-web.douyinvod.com/20261006035329/bbb/video.mp4'
  const videoPost = (extra: Partial<Post> = {}) => post({
    platform: 'douyin', type: 'video',
    body_json: JSON.stringify({ desc: '正文', video: { url: OLD_V } }),
    ...extra,
  })
  const refetchedVideo = (url: string) => videoPost({
    body_json: JSON.stringify({ desc: '正文', video: { url } }),
  })

  it('全部源都失败 ⇒ 重取一次，并把**新签发**的播放地址换上（不用重开抽屉）', async () => {
    deferRefresh()
    act(() => root.render(<PostDetailDrawer post={videoPost()} open onClose={() => {}} />))

    await killVideo()
    expect(refreshMedia, '视频全失败没人去重取 ⇒ 用户只能看到一个死掉的播放器')
      .toHaveBeenCalledWith(1)
    expect(document.body.querySelector('.vp-dead'), '前置：重取回来之前确实没得播').toBeTruthy()

    await answerRefresh({ ok: true, pinned: 0, post: refetchedVideo(NEW_V) })

    expect(vid()?.getAttribute('src'), '重取回来的新地址没换上 —— 那"重取"就白做了')
      .toBe(NEW_V)
    expect(document.body.querySelector('.vp-dead')).toBeNull()
  })

  it('新地址也失败 ⇒ **不再重取第二次**（一帖一次，别把上游打爆）', async () => {
    deferRefresh()
    act(() => root.render(<PostDetailDrawer post={videoPost()} open onClose={() => {}} />))

    await killVideo()
    await answerRefresh({ ok: true, pinned: 0, post: refetchedVideo(NEW_V) })
    await killVideo()                             // 换上来的新地址也挂（上游又签了个坏地址）

    expect(refreshMedia).toHaveBeenCalledTimes(1)
    expect(pendingRefresh.length, '第二次请求发出来了').toBe(0)
  })

  it('重取失败 ⇒ 提示语的**主语是"视频"**（写"图片"用户就会去翻图）', async () => {
    refreshMedia.mockRejectedValue(new Error('当前未登录，无法重取媒体（去 设置 → 登录）'))
    act(() => root.render(<PostDetailDrawer post={videoPost()} open onClose={() => {}} />))

    await killVideo()
    await settle()

    const hint = document.body.querySelector('[data-media-hint]')
    expect(hint?.textContent, '重取失败的原因没露出来').toContain('未登录')
    expect(hint?.textContent, '提示语主语说错了 —— 过期的是播放地址，不是图片')
      .toContain('视频')
    expect(clientLog).toHaveBeenCalled()
  })

  it('图片那条**照旧说"图片"**（默认主语没被视频带偏）', async () => {
    refreshMedia.mockRejectedValue(new Error('小红书内容需要 Cookie'))
    act(() => root.render(
      <PostDetailDrawer post={post({ images_local: [''] })} open onClose={() => {}} />))
    failOnce()
    failOnce()
    await settle()
    const hint = document.body.querySelector('[data-media-hint]')
    expect(hint?.textContent).toContain('图片')
    expect(hint?.textContent).not.toContain('视频')
  })

  it('B 站视频**不**走这条重取（端点对没有详情补全的平台如实 409）', async () => {
    // B 站的取流是另一条路（`BiliVideo` 按需取流 + `onFallback` 回落 durl）；
    // 在这里发一次只会拿到 409 的请求，还会给用户挂一句莫名其妙的红字。
    act(() => root.render(
      <PostDetailDrawer post={videoPost({ platform: 'bilibili' })} open onClose={() => {}} />))

    await killVideo()
    await settle()

    expect(refreshMedia, 'B 站这条路上发了必然 409 的请求').not.toHaveBeenCalled()
    expect(document.body.querySelector('.vp-dead'), '兜底卡照旧（给"在浏览器打开"）').toBeTruthy()
  })
})

/**
 * **"一帖只试一次"不能变成"这一帖永远没救"**（2026-10-06 真机，`devlog/366`）。
 *
 * 真机现场：用户点开一条抖音视频，前端**确实**打了 `refresh-media`（后端日志里有那行
 * `前端 [media] 重取媒体失败 post#5100：… identity_throttled`），失败原因是撞上了
 * **我们自己的**抖音令牌桶（`aweme_detail` 0.12/s ≈8.3s 一发）。而失败之后前端把这一帖
 * 记成"试过了" ⇒ 关掉再打开也不重试 ⇒ 那条视频永久废掉。
 *
 * 三条出口各有判据：① 正在重取时要说一句（后端可能在排队等限速，别让用户以为没反应）；
 * ② 失败那行给一颗「再试一次」（点了就真的再发一次）；③ 关掉抽屉会清掉那份记忆。
 */
describe('详情页 · 重取失败之后还能再试（devlog/366）', () => {
  const OLD_V = 'https://v3-web.douyinvod.com/20261005145109/aaa/video.mp4'
  const NEW_V = 'https://v3-web.douyinvod.com/20261006041525/bbb/video.mp4'
  const videoPost = () => post({
    platform: 'douyin', type: 'video',
    body_json: JSON.stringify({ desc: '正文', video: { url: OLD_V } }),
  })
  const refetchedVideo = () => post({
    platform: 'douyin', type: 'video',
    body_json: JSON.stringify({ desc: '正文', video: { url: NEW_V } }),
  })

  it('正在重取时给一句话（后端可能正在为我们自己的限速排队，别让用户以为没反应）', async () => {
    deferRefresh()
    act(() => root.render(<PostDetailDrawer post={videoPost()} open onClose={() => {}} />))
    await killVideo()
    expect(document.body.querySelector('[data-media-refreshing]')?.textContent,
           '正在重取却一声不吭 —— 用户只会以为又坏了').toContain('正在重取')
    await answerRefresh({ ok: true, pinned: 0, post: refetchedVideo() })
    expect(document.body.querySelector('[data-media-refreshing]'), '重取回来了还挂着"正在重取"')
      .toBeNull()
  })

  it('失败那行的「再试一次」真的再发一次（不受"一帖一次"限制）', async () => {
    refreshMedia.mockRejectedValue(new Error('没能取到新的媒体地址：…（**我们自己的限速**）'))
    act(() => root.render(<PostDetailDrawer post={videoPost()} open onClose={() => {}} />))
    await killVideo()
    await settle()
    expect(refreshMedia).toHaveBeenCalledTimes(1)
    const btn = document.body.querySelector<HTMLButtonElement>('[data-media-retry]')
    expect(btn, '失败那行没有出口 —— 用户只能关掉重开').toBeTruthy()

    refreshMedia.mockResolvedValue({ ok: true, pinned: 0, post: refetchedVideo() })
    await act(async () => { btn!.click(); await Promise.resolve() })
    await settle()
    expect(refreshMedia, '点了「再试一次」却没有再发').toHaveBeenCalledTimes(2)
    expect(vid()?.getAttribute('src'), '再试一次拿回来的新地址没换上').toBe(NEW_V)
  })

  it('关掉抽屉（再打开）会清掉"试过了"的记忆 ⇒ 还能再试一次', async () => {
    refreshMedia.mockRejectedValue(new Error('没能取到新的媒体地址：… identity_throttled'))
    const view = (open: boolean) => (
      <PostDetailDrawer post={videoPost()} open={open} onClose={() => {}} />)
    act(() => root.render(view(true)))
    await killVideo()
    await settle()
    expect(refreshMedia).toHaveBeenCalledTimes(1)

    // 关掉再打开（同一个抽屉实例、同一个帖：真机上就是这样连点两次的）
    act(() => root.render(view(false)))
    act(() => root.render(view(true)))
    await killVideo()
    await settle()
    expect(refreshMedia, '关掉再打开也不重试 ⇒ 这条视频永久废掉（真机现场）')
      .toHaveBeenCalledTimes(2)
  })
})
