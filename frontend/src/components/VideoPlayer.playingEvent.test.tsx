// @vitest-environment jsdom
/**
 * 需求 9（`devlog/425`）：播放器把"我到底在不在播"广播出去，卡片页的**背景视频据此让位**。
 *
 * 两条判据（都能被一种"改回去"的写法弄红）：
 * ① **广播的源头是状态机**，所以 `play` / `pause` 一进一出只发两条 ——
 *    若改成监听元素的裸 `play`/`pause` 事件，缓冲按住、seek 静默这些内部动作也会发，
 *    背景视频就会跟着一顿一顿地闪（`devlog/303` 那类问题的另一种表现）；
 * ② **卸载时要补一条"停了"**：那个 pause 是播放器发的，播放器没了就没人再发 play
 *    ⇒ 不补的话，关掉播放器后背景视频**永远停在暂停上**（用户下次开卡片页才发现"背景不动了"）。
 *
 * ⚠️ 这里**不去 mock `utils/appEvents`**：直接监听 `window` 上的真事件，
 * 顺带把"事件名/载荷形状"这条契约也走了一遍（改表里的名字 ⇒ 这里红）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VideoPlayer from './VideoPlayer'
import { EVENTS, on } from '../utils/appEvents'
import { resetPlayerPrefs } from '../utils/playerPrefs'

vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const VIDEO = { url: 'http://v/a.mp4', fallbacks: [] as string[] }

let host: HTMLDivElement
let root: Root
let mounted: boolean
/** 收到的广播（按顺序）。 */
let seen: boolean[]
let off: () => void

const el = () => host.querySelector('video') as HTMLVideoElement

beforeEach(() => {
  resetPlayerPrefs()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
  seen = []
  off = on(EVENTS.playerPlaying, ({ playing }) => seen.push(playing))
})

afterEach(() => {
  off()
  if (mounted) act(() => root.unmount())
  mounted = false
  host.remove()
})

function render() {
  act(() => root.render(<VideoPlayer video={VIDEO} />))
  const v = el()
  Object.defineProperty(v, 'duration', { configurable: true, value: 100 })
  return v
}

describe('播放器 → 背景视频的让位信号', () => {
  it('★ `play` / `pause` 一进一出 ⇒ 只广播两条（源头是状态机，不是裸媒体事件）', async () => {
    const v = render()
    seen.length = 0                      // 挂载那一下的初始值不算
    await act(async () => { v.dispatchEvent(new Event('play')) })
    expect(seen, '开播 ⇒ 一条 true').toEqual([true])
    await act(async () => { v.dispatchEvent(new Event('pause')) })
    expect(seen, '暂停 ⇒ 一条 false').toEqual([true, false])
    // 同一状态重复派发**不该**再发（背景视频不应该被反复 pause/play）
    await act(async () => { v.dispatchEvent(new Event('pause')) })
    expect(seen).toEqual([true, false])
  })

  it('★ 卸载时补一条"停了"（否则关掉播放器后背景视频永远停在暂停上）', async () => {
    const v = render()
    await act(async () => { v.dispatchEvent(new Event('play')) })
    expect(seen[seen.length - 1]).toBe(true)
    seen.length = 0
    await act(async () => { root.unmount() })
    mounted = false
    expect(seen, '卸载要广播 playing:false').toEqual([false])
  })
})
