// @vitest-environment jsdom
/**
 * B站视频块（devlog/290）：**点播放才取流**（地址短时效+绑 IP，不能预取）、
 * 失败**如实显示**后端给的原因（不存在/无权限/风控），并且用 DASH 起步、播不动才回落 durl。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const biliPlay = vi.fn()
vi.mock('../api/api', () => ({ api: { biliPlay: (...a: unknown[]) => biliPlay(...a) } }))
vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

import BiliVideo from './BiliVideo'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const INFO = {
  bvid: 'BV1', cid: 1, kernel: 'dash' as const, quality: 80,
  accept: [{ id: 120, label: '4K' }, { id: 80, label: '高清 1080P' }],
  dash: { video: [{ id: 80, base_url: 'https://cdn/v.m4s', height: 1080 }],
          audio: [{ id: 30280, base_url: 'https://cdn/a.m4s' }] },
  durl: [], expires_in: 120,
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
})
