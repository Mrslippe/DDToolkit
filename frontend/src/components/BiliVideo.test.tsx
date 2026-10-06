// @vitest-environment jsdom
/**
 * B站视频块（devlog/290）：**点播放才取流**（地址短时效+绑 IP，不能预取）、
 * 失败**如实显示**后端给的原因（不存在/无权限/风控），并且用 DASH 起步、播不动才回落 durl；
 * 播不动时的补救顺序（过期 → 同档重取；否则 → durl）与"各只一次"的闸门见 devlog/293。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const biliPlay = vi.fn()
const biliSegments = vi.fn()
const clientLog = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, dropped: false }))
vi.mock('../api/api', () => ({
  api: {
    biliPlay: (...a: unknown[]) => biliPlay(...a),
    // 段表（devlog/312）：默认内核是 MSE ⇒ 取流之后会接着要它。mock 里缺这个函数就是
    // "api.biliSegments is not a function"（与 clientLog / 两个代理 URL 同一类坑）。
    biliSegments: (...a: unknown[]) => biliSegments(...a),
    // 播放诊断上报（devlog/306）：组件会 `api.clientLog(一行)`，mock 里缺它就会抛
    // "api.clientLog is not a function"（跟上面两个代理 URL 同一类坑）
    clientLog: (...a: unknown[]) => clientLog(...a),
  },
  // ⚠️ **`authFetch` 也必须导出**：MSE 内核取段走的就是它（`utils/mseKernel` 的默认取数）。
  //    漏一个符号的后果是"内核当场熔断、静默退回渐进式"—— 用例会看到渐进式，却看不出为什么
  //    （这一批真踩过：报错原文是 vitest 的 `No "authFetch" export is defined on the mock`）。
  authFetch: (path: string, init?: RequestInit) => fetch(path, init),
  // 两个代理 URL 的拼法要**真的**走一遍（它们带着 apiBase，见 devlog/294）：
  // 只 mock `biliPlay` 而漏掉这两个 ⇒ 组件直接抛 "No export is defined on the mock"。
  videoProxyUrl: (u: string) => `/api/video-proxy?url=${encodeURIComponent(u)}`,
  imgProxyUrl: (u: string) => `/api/img-proxy?url=${encodeURIComponent(u)}`,
}))
vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

import BiliVideo, { nextRetryAction } from './BiliVideo'
import { resetVideoKernel, setKernelChoice } from '../utils/videoKernel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const INFO = {
  bvid: 'BV1', cid: 1, kernel: 'dash' as const, quality: 80,
  accept: [{ id: 120, label: '4K' }, { id: 80, label: '高清 1080P' }],
  dash: { video: [{ id: 80, base_url: 'https://cdn/v.m4s', height: 1080 }],
          audio: [{ id: 30280, base_url: 'https://cdn/a.m4s' }] },
  durl: [], expires_in: 120,
}

/** durl 回落档：单 mp4、没有 DASH 轨 */
const DURL_INFO = {
  ...INFO, kernel: 'durl' as const, dash: { video: [], audio: [] },
  durl: [{ url: 'https://cdn/v.mp4', size: 1, length: 1 }],
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  biliPlay.mockReset()
  biliSegments.mockReset()
  resetVideoKernel()          // 内核开关是 localStorage 里的（跨用例会串）
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('BiliVideo', () => {
  it('打开页面**不取流**（`playurl` 地址短时效），点播放才要一次', async () => {
    biliPlay.mockResolvedValue(INFO)
    act(() => root.render(<BiliVideo postId={7} poster="http://x/c.webp" />))

    expect(biliPlay, '挂载即取流 ⇒ 地址会在用户真正点播前就过期').not.toHaveBeenCalled()
    expect(host.querySelector('.vp-bigplay')).toBeTruthy()
    // 封面下方那一条标题带**已删**（用户 2026-10-03：标题在详情页顶上已经有了）——
    // 它当时还是块黑边，盖在封面下沿像一条多余的分隔
    expect(host.querySelector('.bili-lazy-title'), '标题带不该再出现').toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
    })
    expect(biliPlay).toHaveBeenCalledTimes(1)
    expect(biliPlay.mock.calls[0][0]).toBe(7)
    // 拿到流之后：双元素（视频轨 + 独立的音轨）；声音只在音轨上，
    // 视频轨的 `muted` 跟随全局偏好（小窗静音按钮靠它，见 devlog/299）
    expect(host.querySelector('audio')).toBeTruthy()
    expect(host.querySelector('video')?.muted).toBe(false)
  })

  it('点播放 ⇒ **拿到地址就开始播**（不是只把播放器画出来）', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    biliPlay.mockResolvedValue(INFO)
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
    })
    const tags = () => play.mock.contexts.map((el) => (el as HTMLMediaElement).tagName)
    expect(tags(), '视频轨要起播').toContain('VIDEO')
    expect(tags(), '出画前音轨先不出声（否则开头会听两遍，devlog/298）').not.toContain('AUDIO')

    const v = host.querySelector('video')!
    Object.defineProperty(v, 'readyState', { value: 2, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('playing')); await Promise.resolve() })
    expect(tags(), '视频轨出画后 DASH 音轨跟上').toContain('AUDIO')
    play.mockRestore()
  })

  it('**切 P 要带上 cid 重取流**（且不重置用户选的清晰度）—— devlog/329', async () => {
    /**
     * 老实现永远只播第 1 P（`play_info` 只发顶层 cid）：7 P 的实况在应用里只剩 76 分钟，
     * 而且没有任何入口。这条盯的是"切 P 到底发了什么"：
     * ① `cid` 必须带上；② 顺带把当前清晰度带上（别悄悄回到默认档）。
     */
    const MULTI = {
      ...INFO,
      pages: [{ cid: 111, page: 1, part: '第一章', duration_s: 100 },
              { cid: 222, page: 2, part: '第二章', duration_s: 200 }],
      page: 1,
    }
    biliPlay.mockResolvedValue(MULTI)
    biliSegments.mockResolvedValue({ bvid: 'BV1', quality: 80, duration_s: 10,
                                     video: null, audio: null })
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
    })
    expect(biliPlay.mock.calls[0][1] ?? {}, '第一次不指定 cid（默认第 1 P）')
      .not.toHaveProperty('cid')

    // 打开分P 菜单 → 点 P2
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === '分P')!
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
    const p2 = [...host.querySelectorAll<HTMLButtonElement>('.vp-menu--page .vp-menu-item')][1]
    await act(async () => { p2.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })

    const second = biliPlay.mock.calls[1]
    expect(second?.[1], `切 P 没带 cid：${JSON.stringify(second)}`).toMatchObject({ cid: 222, qn: 80 })
  })

  it('失败**如实显示**后端分类的原因，不自己编文案', async () => {
    biliPlay.mockRejectedValue(new Error('没有观看权限（充电专属 / 地区限制 / 需要登录）'))
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const pill = host.querySelector('.bili-lazy-err')!
    expect(pill.textContent).toContain('没有观看权限')
    expect(pill.getAttribute('role'), '失败要走 alert（读屏要念）').toBe('alert')
    // 失败之后播放键要回来（一点就重试），且**不是**贴在底部的黑条
    expect(host.querySelector('.vp-bigplay')).toBeTruthy()
    expect(host.querySelector('.bili-lazy-hint'), '底部那条黑边不该再存在').toBeNull()
  })

  it('取流中：**屏幕中央转圈**，不再有"正在取流…"的下黑边', async () => {
    biliPlay.mockReturnValue(new Promise(() => { /* 永不 resolve：停在取流中 */ }))
    act(() => root.render(<BiliVideo postId={7} poster="http://x/c.webp" />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
    })
    const spin = host.querySelector('.vp-spin')!
    expect(spin, '取流中要有中央缓冲标识').toBeTruthy()
    expect(spin.getAttribute('role')).toBe('status')
    expect(spin.getAttribute('aria-label')).toBe('正在取流')
    expect(spin.querySelector('.vp-spin-icon'), '转的是图标本身').toBeTruthy()
    expect(host.querySelector('.bili-lazy-hint'), '那条"正在取流…"黑边已删').toBeNull()
    // 转圈时不再同时显示播放键（同一格位置，两个元素会叠在一起）
    expect(host.querySelector('.vp-bigplay')).toBeNull()

    // 位置与旋转必须在**真 CSS** 里（jsdom 不做布局，只能查声明）
    const css = readFileSync(resolve(__dirname, '../styles/posts.css'), 'utf8')
    // ⚠️ 必须**锚在行首**：不锚的话 `.vp:fullscreen .vp-spin { … }` 这种后代规则会抢先匹配
    //    （2026-10-06 实测：加了一条全屏降本规则，这条判据当场红 —— 而基础规则一个字没改）。
    const box = css.match(/^\.vp-spin \{[^}]*\}/m)?.[0] ?? ''
    expect(box, '.vp-spin 要绝对定位（居中靠它）').toContain('position: absolute')
    expect(box, '要居中').toContain('translate(-50%, -50%)')
    expect(css, '转起来靠 keyframes').toContain('@keyframes vp-spin')
    expect(css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?vp-spin-icon/),
           'reduced-motion 下别把动效整个去掉（会像卡住）').toBeTruthy()
  })

  it('封面走 ProxyImage：`http://` 要 https 化 + 带 no-referrer（裸 `<img>` 会破图）', () => {
    // 真机现场（devlog/294）：B站封面是 `http://i1.hdslb.com/…`，页面里的裸 `<img>` 直接破图
    // （黑底 + "图片"占位）。ProxyImage 会 https 化、带 no-referrer、失败还能转 `/img-proxy`。
    act(() => root.render(
      <BiliVideo postId={7} poster="http://i1.hdslb.com/bfs/archive/c.jpg" />))
    const img = host.querySelector<HTMLImageElement>('.bili-lazy img')!
    expect(img.getAttribute('src')).toBe('https://i1.hdslb.com/bfs/archive/c.jpg')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(img.getAttribute('data-render-src'), 'ProxyImage 的探针属性（R46）')
      .toBe('https://i1.hdslb.com/bfs/archive/c.jpg')
  })

  it('镜像链交给播放器：`urls` 里第 2 条起进 `videoFallbacks`（不必回后端重取）', async () => {
    const alt = 'https://upos-sz-estgoss.bilivideo.com/v2.m4s?sign=y'
    biliPlay.mockResolvedValue({
      ...INFO,
      dash: { video: [{ id: 80, base_url: 'https://xy1.mcdn.bilivideo.cn:8082/v.m4s',
                        urls: ['https://xy1.mcdn.bilivideo.cn:8082/v.m4s', alt], height: 1080 }],
              audio: [{ id: 30280, base_url: 'https://xy1.mcdn.bilivideo.cn:8082/a.m4s',
                        urls: ['https://xy1.mcdn.bilivideo.cn:8082/a.m4s'], }] },
    })
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
    })
    const v = host.querySelector('video')!
    expect(v.getAttribute('src')).toContain('xy1.mcdn.bilivideo.cn')
    await act(async () => { v.dispatchEvent(new Event('error')); await Promise.resolve() })
    expect(host.querySelector('video')!.getAttribute('src'), '第二条镜像要用上')
      .toBe(`/api/video-proxy?url=${encodeURIComponent(alt)}`)
  })

  it('播不动 ⇒ **先回落 durl**（换内核重取一次），只回落一次', async () => {
    biliPlay.mockResolvedValueOnce(INFO).mockResolvedValueOnce(DURL_INFO)
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
    })
    // 视频轨报错（DASH 在 WebView2 里解不了的那条路）
    const v = host.querySelector('video')!
    await act(async () => {
      v.dispatchEvent(new Event('error'))
      await Promise.resolve()
    })
    expect(biliPlay).toHaveBeenCalledTimes(2)
    expect(biliPlay.mock.calls[1][1]).toEqual({ fallback: true })
    expect(host.querySelector('video')?.getAttribute('src')).toContain('v.mp4')

    // 再报错：durl 那条还会沿"直连 → 代理"换一次源，换完仍失败 ⇒ **不再重取**（各只一次）
    // ⚠️ 这里必须把链走完才判死 —— 若闸门坏了，biliPlay 会一直涨（devlog/292 那次就是这么坏的）
    for (let i = 0; i < 3 && !host.querySelector('.vp-dead'); i++) {
      const el = host.querySelector('video')
      if (!el) break                      // 已经进"播不了"兜底卡（它不渲染 video 元素）
      await act(async () => {
        el.dispatchEvent(new Event('error'))
        await Promise.resolve()
      })
    }
    expect(biliPlay).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.vp-dead'), '全失败要落到"播不了"兜底卡').toBeTruthy()
  })

  it('**地址过期** ⇒ 用同一档重取（保住 1080P），而不是降级去要 durl', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    biliPlay.mockResolvedValue({ ...INFO, expires_in: 60 })
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
    })
    // 快进过有效期（用户把抽屉晾着，再点播放时地址已经死了）
    vi.setSystemTime(now + 61_000)
    biliPlay.mockResolvedValueOnce({ ...INFO, expires_in: 60 })
    await act(async () => {
      host.querySelector('video')!.dispatchEvent(new Event('error'))
      await Promise.resolve()
    })
    expect(biliPlay).toHaveBeenCalledTimes(2)
    expect(biliPlay.mock.calls[1][1], '过期要重取**同一档**' +
      '（降级 durl 会白丢 1080P）').toEqual({ qn: 80 })
  })
})

// ── S2：段表接线（devlog/312）───────────────────────────────────────────────

/** 最小 MediaSource/SourceBuffer 替身：只为"段表真的进了播放器"这件事服务 */
class TinySourceBuffer {
  updating = false
  mode = ''
  readonly buffered = { length: 0, start: () => 0, end: () => 0 }
  addEventListener() { /* 忽略 */ }
  appendBuffer() { /* 忽略 */ }
  remove() { /* 忽略 */ }
}
class TinyMediaSource {
  static isTypeSupported = () => true
  readyState = 'closed'
  duration = NaN
  private readonly listeners: Record<string, (() => void)[]> = {}
  addEventListener(t: string, fn: () => void) {
    (this.listeners[t] ??= []).push(fn)
    if (t === 'sourceopen') queueMicrotask(() => { this.readyState = 'open'; fn() })
  }
  removeEventListener() { /* 忽略 */ }
  addSourceBuffer() { return new TinySourceBuffer() as unknown as SourceBuffer }
  endOfStream() { /* 忽略 */ }
}

const SEGMENTS = {
  bvid: 'BV1', quality: 80, duration_s: 10,
  video: { url: 'https://cdn/v.m4s', urls: ['https://cdn/v.m4s'],
           mime: 'video/mp4; codecs="avc1"', init: { start: 0, end: 947 },
           segments: [{ i: 0, start: 948, end: 1947, dur_s: 10, sap: true }], duration_s: 10 },
  audio: { url: 'https://cdn/a.m4s', urls: ['https://cdn/a.m4s'],
           mime: 'audio/mp4; codecs="mp4a"', init: { start: 0, end: 700 },
           segments: [{ i: 0, start: 701, end: 900, dur_s: 10, sap: true }], duration_s: 10 },
}

describe('BiliVideo · 段表（MSE 内核的输入）', () => {
  it('默认内核 ⇒ 取流之后接着取段表，并把两轨交给播放器（**不再有独立音轨**）', async () => {
    vi.stubGlobal('MediaSource', TinyMediaSource)
    Object.defineProperty(URL, 'createObjectURL',
                          { value: () => 'blob:tiny', configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL',
                          { value: () => { /* 忽略 */ }, configurable: true, writable: true })
    // 取段走的是 `authFetch('/api/video-proxy?…')`：这里只回答一个空段（不模拟解码）。
    // ⚠️ 长度要**正好是请求的那一段**（内核会校验，`devlog/314`）；给固定 16 字节会被判"数据不对"。
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range') ?? ''
      const m = /bytes=(\d+)-(\d+)/.exec(range)
      const size = m ? Number(m[2]) - Number(m[1]) + 1 : 16
      return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(size),
               text: async () => '' }
    }))
    biliPlay.mockResolvedValue({ ...INFO, dash: {
      video: [{ id: 80, base_url: 'https://cdn/v.m4s', codecs: 'avc1', mime: 'video/mp4' }],
      audio: [{ id: 30280, base_url: 'https://cdn/a.m4s', codecs: 'mp4a', mime: 'audio/mp4' }] } })
    biliSegments.mockResolvedValue(SEGMENTS)

    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(biliSegments).toHaveBeenCalledTimes(1)
    expect(biliSegments.mock.calls[0][0]).toBe(7)
    expect(host.querySelector('video')!.getAttribute('src'), '走 MSE ⇒ 流由 blob 提供')
      .toBe('blob:tiny')
    expect(host.querySelector('audio'), '段表生效后音轨在同一条元素上（一个钟）').toBeNull()
    expect(host.querySelector('.bili-lazy-err'), '内核切换不是错误，别弹给用户').toBeNull()
  })

  it('内核被切回渐进式 ⇒ **连段表都不取**（退路要真的少走一步，而不是取了不用）', async () => {
    setKernelChoice('progressive')
    biliPlay.mockResolvedValue(INFO)
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(biliSegments).not.toHaveBeenCalled()
    expect(host.querySelector('audio'), '渐进式 = 双元素').not.toBeNull()
  })

  it('段表拿不到（502/超时）⇒ **照样播**，只是走渐进式', async () => {
    vi.stubGlobal('MediaSource', TinyMediaSource)
    biliPlay.mockResolvedValue(INFO)
    biliSegments.mockRejectedValue(new Error('502 这条流没有 sidx'))
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.querySelector('video')!.getAttribute('src'))
      .toBe(`/api/video-proxy?url=${encodeURIComponent(INFO.dash.video[0].base_url)}`)
    expect(host.querySelector('audio')).not.toBeNull()
    expect(host.querySelector('.bili-lazy-err'), '段表失败不该让用户看到报错').toBeNull()
  })
})

describe('nextRetryAction（补救顺序，纯函数）', () => {
  it('过期优先同档重取，其次 durl 回落，两次都试过就收手', () => {
    const none = { expired: false, triedRefresh: false, triedFallback: false }
    expect(nextRetryAction(none)).toBe('fallback')
    expect(nextRetryAction({ ...none, expired: true })).toBe('refresh')
    expect(nextRetryAction({ expired: true, triedRefresh: false, triedFallback: true }))
      .toBe('refresh')
    expect(nextRetryAction({ expired: false, triedRefresh: true, triedFallback: true }))
      .toBe('none')
    expect(nextRetryAction({ expired: true, triedRefresh: true, triedFallback: true }))
      .toBe('none')
  })
})
