// @vitest-environment jsdom
/**
 * 录播播放器的接线判据（2026-10-13，用户 3.2：封面上的 ▶ 打开它）。
 *
 * 这里**不测播放**（取流/清晰度/分P/MSE 那一整套是 `BiliVideo` 的判据，见它的三个文件）——
 * 只测"这个窗有没有把正确的参数递下去、该不该开、有没有退路"：
 *
 * | 判据 | 坏了会怎样 |
 * |---|---|
 * | 把 `bvid` 递给播放面 | 播不了（或打错端点） |
 * | ★ 把 `?p=N` 递成 `initialPage` | 多 P 录播只播第一段（`devlog/329` 那类问题） |
 * | 认不出 BV ⇒ 不开这个窗 | 用户看到一个黑框在那儿转 |
 * | 「在浏览器打开」这条退路在 | 真机上播不动时用户没有出路 |
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveSession } from '../../api/types'

vi.mock('../BiliVideo', () => ({ default: (p: Record<string, unknown>) => (
  <div data-bili-stub data-bvid={String(p.bvid)} data-page={String(p.initialPage ?? '')} />
) }))
const openExternal = vi.fn((_url: string) => Promise.resolve())
vi.mock('../../utils/shellBridge', () => ({
  openExternal: (url: string) => openExternal(url),
}))

import VodPlayerDialog from './VodPlayerDialog'

const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnv.IS_REACT_ACT_ENVIRONMENT = true

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

const withVod = (url: string, title = '歌回') => ({
  live_id: 'sess-1', live_title: title, start_at: '2026-10-08T20:00:00Z',
  vod_url: url, cover_url: null, source: 'danmakus', manual: false,
} as unknown as LiveSession)

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()

function render(session: LiveSession | null, open = true) {
  act(() => {
    root.render(<VodPlayerDialog open={open} session={session} onClose={onClose} />)
  })
}

const stub = () => document.querySelector<HTMLElement>('[data-bili-stub]')

beforeEach(() => {
  onClose.mockReset()
  openExternal.mockReset().mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('录播播放器', () => {
  it('把 bvid 递给播放面（不是 postId —— 录播不是帖子）', () => {
    render(withVod('https://www.bilibili.com/video/BV1xx411c7mD'))
    expect(stub()!.getAttribute('data-bvid')).toBe('BV1xx411c7mD')
    expect(stub()!.getAttribute('data-page')).toBe('')
  })

  it('★ 地址里的 `?p=3` 递成 `initialPage`（否则多 P 录播只播第一段）', () => {
    render(withVod('https://www.bilibili.com/video/BV1xx411c7mD?p=3'))
    expect(stub()!.getAttribute('data-page')).toBe('3')
  })

  it('标题与 BV 号都显示出来（用户得知道自己在看哪一场）', () => {
    render(withVod('https://www.bilibili.com/video/BV1xx411c7mD', '深夜歌回'))
    expect(document.querySelector('.vodp-title')!.textContent).toContain('深夜歌回')
    expect(document.querySelector('.vodp-sub')!.textContent).toContain('BV1xx411c7mD')
  })

  it('认不出 BV 的地址 ⇒ **不开**这个窗（不开一个黑框在那儿转）', () => {
    render(withVod('https://example.com/x.mp4'))
    expect(stub()).toBeNull()
    expect(onClose).toHaveBeenCalled()
  })

  it('「在浏览器打开」这条退路在（真机播不动时用户得有出路）', async () => {
    const url = 'https://www.bilibili.com/video/BV1xx411c7mD'
    render(withVod(url))
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-vod-open-external]')!.click()
      await Promise.resolve()
    })
    expect(openExternal).toHaveBeenCalledWith(url)
  })
})
