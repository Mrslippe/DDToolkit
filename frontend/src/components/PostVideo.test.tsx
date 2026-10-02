// @vitest-environment jsdom
/**
 * 视频块（devlog/281）的判据：**能不能换源、能不能兜底**。
 *
 * 为什么单测这个组件而不是整个详情抽屉：抽屉带 Radix + 覆盖式滚动条，jsdom 下要补一堆
 * 浏览器 API；而"这条流解不了怎么办"是视频这块**唯一**会出错的地方，独立出来才测得准。
 * （真机播放本身仍属人工验证 —— 我只能验到"元素/URL 正确 + 上游返回 206"。）
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PostVideo from './PostVideo'

// 兜底按钮会走 open_external：这里只关心"点了没报错"，把桥接换成假的
const openExternal = vi.fn((url: string) => { void url; return Promise.resolve() })
vi.mock('../utils/shellBridge', () => ({
  openExternal: (url: string) => openExternal(url),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  openExternal.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(props: Parameters<typeof PostVideo>[0]) {
  act(() => root.render(<PostVideo {...props} />))
}

const video = () => host.querySelector('video')

describe('PostVideo', () => {
  it('渲染 `<video controls>`，poster 用封面，且**不自动播放**', () => {
    render({
      video: { url: 'http://v/1080.mp4', fallbacks: ['http://v/720.mp4'] },
      poster: 'http://x/cover.webp',
      permalink: 'https://www.xiaohongshu.com/explore/n1',
    })

    const v = video()!
    expect(v).toBeTruthy()
    expect(v.getAttribute('src')).toBe('http://v/1080.mp4')
    expect(v.getAttribute('poster')).toBe('http://x/cover.webp')
    expect(v.hasAttribute('controls')).toBe(true)
    expect(v.hasAttribute('autoplay'), '不自动播放：声音与流量都不该意外发生').toBe(false)
    expect(v.getAttribute('preload')).toBe('metadata')
  })

  it('这条流解不了 ⇒ 沿 fallback 链换源（不当成"视频坏了"）', () => {
    render({ video: { url: 'http://v/a.mp4', fallbacks: ['http://v/b.mp4', 'http://v/c.mp4'] } })

    act(() => { video()!.dispatchEvent(new Event('error')) })
    expect(video()!.getAttribute('src')).toBe('http://v/b.mp4')
    act(() => { video()!.dispatchEvent(new Event('error')) })
    expect(video()!.getAttribute('src')).toBe('http://v/c.mp4')
  })

  it('链走完都失败 ⇒ 兜底「在浏览器打开」（且真的调了外链桥）', async () => {
    render({
      video: { url: 'http://v/a.mp4' },
      permalink: 'https://www.xiaohongshu.com/explore/n1?xsec_token=T',
    })

    act(() => { video()!.dispatchEvent(new Event('error')) })

    expect(host.querySelector('video')).toBeFalsy()
    const btn = host.querySelector<HTMLButtonElement>('.pv-open')!
    expect(btn.textContent).toContain('在浏览器打开')
    await act(async () => {
      btn.click()
      await Promise.resolve()
    })
    expect(openExternal).toHaveBeenCalledWith('https://www.xiaohongshu.com/explore/n1?xsec_token=T')
  })

  it('没有 permalink 时兜底只说明情况，不给死按钮', () => {
    render({ video: { url: 'http://v/a.mp4' } })
    act(() => { video()!.dispatchEvent(new Event('error')) })
    expect(host.querySelector('.pv-dead')?.textContent).toContain('播不了')
    expect(host.querySelector('.pv-open')).toBeFalsy()
  })
})
