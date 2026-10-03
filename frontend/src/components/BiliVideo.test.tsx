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
vi.mock('../api/api', () => ({
  api: { biliPlay: (...a: unknown[]) => biliPlay(...a) },
  // 两个代理 URL 的拼法要**真的**走一遍（它们带着 apiBase，见 devlog/294）：
  // 只 mock `biliPlay` 而漏掉这两个 ⇒ 组件直接抛 "No export is defined on the mock"。
  videoProxyUrl: (u: string) => `/api/video-proxy?url=${encodeURIComponent(u)}`,
  imgProxyUrl: (u: string) => `/api/img-proxy?url=${encodeURIComponent(u)}`,
}))
vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

import BiliVideo, { nextRetryAction } from './BiliVideo'

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
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
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
    const box = css.match(/\.vp-spin \{[^}]*\}/)?.[0] ?? ''
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
