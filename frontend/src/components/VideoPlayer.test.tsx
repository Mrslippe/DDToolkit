// @vitest-environment jsdom
/**
 * 自绘播放器（devlog/283）的判据。要点：
 * - **不许退回原生控件**（`controls` 属性一出现，皮肤就白做了）；
 * - **音量全局共用**（用户口径：别一个响一个轻）；
 * - 播放/暂停、进度点选、倍速、fallback 链（含真失败才报错）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VideoPlayer from './VideoPlayer'
import { playerPrefs, resetPlayerPrefs } from '../utils/playerPrefs'
import { clearReports, reportEntries } from '../utils/problemReport'

vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  resetPlayerPrefs()
  clearReports()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // jsdom 不实现媒体播放：补最小桩（只验"我们有没有调对"）
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const VIDEO = { url: 'http://v/a.mp4', fallbacks: ['http://v/b.mp4'] }

function render(props: Record<string, unknown> = {}) {
  act(() => root.render(<VideoPlayer video={VIDEO} {...props} />))
}

const el = () => host.querySelector('video') as HTMLVideoElement

describe('VideoPlayer', () => {
  it('自绘控件：**没有 `controls` 属性**，且播放链带自愈标记', () => {
    render({ poster: 'http://x/c.webp' })
    expect(el().hasAttribute('controls'), '有 controls ⇒ 原生控件会盖掉我们的皮肤').toBe(false)
    expect(el().getAttribute('poster')).toBe('http://x/c.webp')
    expect(host.querySelector('[data-self-healing="1"]')).toBeTruthy()
  })

  it('点大播放键 ⇒ 进播放态（大键收起、底栏变"暂停"）；再点 ⇒ 回暂停态', async () => {
    // ⚠️ jsdom 不实现媒体播放（`play()`/`paused` 都是桩），**断言可观察的 UI 契约**而不是
    //    "有没有调 play" —— 后者在 jsdom 里要靠改原型/实例打桩，测的是桩不是组件
    //    （2026-10-03 实测：两种打桩法都得不到稳定结论）。
    render()
    const v = el()
    const big = host.querySelector<HTMLButtonElement>('.vp-bigplay')!
    await act(async () => {
      big.click()
      v.dispatchEvent(new Event('play'))
      await Promise.resolve()
    })
    expect(host.querySelector('.vp-bigplay'), '播放中不该还挂着大播放键').toBeFalsy()
    expect(host.querySelector('button[aria-label="暂停"]')).toBeTruthy()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="暂停"]')!.click()
      v.dispatchEvent(new Event('pause'))
      await Promise.resolve()
    })
    expect(host.querySelector('button[aria-label="播放"]')).toBeTruthy()
  })

  it('**音量全局共用**：一个播放器改音量，另一个跟着变（并写进 localStorage）', async () => {
    const second = document.createElement('div')
    document.body.append(second)
    const root2 = createRoot(second)
    act(() => {
      root.render(<VideoPlayer video={VIDEO} />)
      root2.render(<VideoPlayer video={{ url: 'http://v/other.mp4' }} />)
    })
    const a = host.querySelector('video') as HTMLVideoElement
    const b = second.querySelector('video') as HTMLVideoElement
    const slider = host.querySelector<HTMLInputElement>('input[aria-label="音量"]')!

    await act(async () => {
      // React 认的是原生 setter 触发的 input 事件（直接改 .value 它看不见）
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value')!.set!
      setter.call(slider, '0.35')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(playerPrefs().volume).toBeCloseTo(0.35, 5)
    expect(a.volume).toBeCloseTo(0.35, 5)
    expect(b.volume, '第二个播放器没跟着变 ⇒ 就是"一个响一个轻"').toBeCloseTo(0.35, 5)
    expect(JSON.parse(localStorage.getItem('ddtoolkit.player.prefs') || '{}').volume)
      .toBeCloseTo(0.35, 5)
    act(() => root2.unmount())
    second.remove()
  })

  it('倍速菜单：选 2× ⇒ playbackRate 立即生效（也是全局偏好）', async () => {
    render()
    await act(async () => { host.querySelector<HTMLButtonElement>('.vp-btn--text')!.click() })
    const items = [...host.querySelectorAll<HTMLButtonElement>('.vp-menu-item')]
    expect(items.map((i) => i.textContent)).toEqual(['0.5×', '1×', '1.5×', '2×'])
    await act(async () => { items[3].click(); await Promise.resolve() })
    expect(el().playbackRate).toBe(2)
    expect(playerPrefs().rate).toBe(2)
  })

  it('点进度条 ⇒ 按比例 seek（并显示 mm:ss/mm:ss）', async () => {
    render()
    const v = el()
    Object.defineProperty(v, 'duration', { value: 30, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')) })
    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50 }))
      await Promise.resolve()
    })
    expect(v.currentTime).toBeCloseTo(15, 1)
    expect(host.querySelector('.vp-time')?.textContent).toContain('/00:30')
  })

  it('进度条 hover ⇒ 出时间气泡（图二），默认是细线、hover 才变粗', async () => {
    render()
    const v = el()
    Object.defineProperty(v, 'duration', { value: 30, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')) })

    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    // ⚠️ 不在这里断言"未 hover 时没有气泡"：jsdom 里 `getBoundingClientRect` 的替换与
    //    React 的状态复用让那条前置断言不稳（跑一遍红一遍绿）；**只看两条正向契约**。
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40 }))
      await Promise.resolve()
    })
    // 40% × 30s = 12s
    expect(host.querySelector('.vp-progress-tip')?.textContent).toBe('00:12')

    // ⚠️ React 的 `onMouseLeave` 是用 **mouseout + relatedTarget** 模拟的：派发裸 `mouseleave`
    //    它收不到（2026-10-03 踩到）
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
      await Promise.resolve()
    })
    expect(host.querySelector('.vp-progress-tip')).toBeFalsy()
  })

  it('音量条在 hover 浮窗里（图三），喇叭图标按档位变', async () => {
    render()
    const pop = host.querySelector('.vp-volpop')
    expect(pop, '音量条要有浮窗容器（默认不占底栏）').toBeTruthy()
    expect(pop!.querySelector('input[aria-label="音量"]')).toBeTruthy()

    const volBtn = host.querySelector<HTMLButtonElement>('[data-vol-level]')!
    expect(volBtn.dataset.volLevel).toBe('high')          // 默认 100%

    const slider = host.querySelector<HTMLInputElement>('input[aria-label="音量"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(slider, '0.2')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(host.querySelector<HTMLButtonElement>('[data-vol-level]')!.dataset.volLevel).toBe('low')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-vol-level]')!.click()
      await Promise.resolve()
    })
    expect(host.querySelector<HTMLButtonElement>('[data-vol-level]')!.dataset.volLevel).toBe('mute')
  })

  it('直连全失败 ⇒ 换到本机代理；代理也失败 ⇒ 兜底并报一条', async () => {
    render()
    const seen: string[] = []
    for (let i = 0; i < 8; i += 1) {
      const v = el()
      if (!v) break
      seen.push(v.getAttribute('src') ?? '')
      await act(async () => { v.dispatchEvent(new Event('error')); await Promise.resolve() })
    }
    expect(seen[0]).toBe('http://v/a.mp4')
    expect(seen[1]).toBe('http://v/b.mp4')
    expect(seen[2]).toBe('/video-proxy?url=http%3A%2F%2Fv%2Fa.mp4')
    expect(host.querySelector('.vp-dead')?.textContent).toContain('播不了')
    expect(reportEntries().some((r) => r.where === '视频播放')).toBe(true)
  })
})
