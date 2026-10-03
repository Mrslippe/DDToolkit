// @vitest-environment jsdom
/**
 * B站视频块（devlog/290）：**点播放才取流**（地址短时效+绑 IP，不能预取）、
 * 失败**如实显示**后端给的原因（不存在/无权限/风控），并且用 DASH 起步、播不动才回落 durl；
 * 播不动时的补救顺序（过期 → 同档重取；否则 → durl）与"各只一次"的闸门见 devlog/293。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const biliPlay = vi.fn()
vi.mock('../api/api', () => ({ api: { biliPlay: (...a: unknown[]) => biliPlay(...a) } }))
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

    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
    })
    expect(biliPlay).toHaveBeenCalledTimes(1)
    expect(biliPlay.mock.calls[0][0]).toBe(7)
    // 拿到流之后：视频轨静音 + 音轨存在（双元素）
    expect(host.querySelector('video')?.muted).toBe(true)
    expect(host.querySelector('audio')).toBeTruthy()
  })

  it('失败**如实显示**后端分类的原因，不自己编文案', async () => {
    biliPlay.mockRejectedValue(new Error('没有观看权限（充电专属 / 地区限制 / 需要登录）'))
    act(() => root.render(<BiliVideo postId={7} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.vp-bigplay')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.querySelector('.bili-lazy-err')?.textContent).toContain('没有观看权限')
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
