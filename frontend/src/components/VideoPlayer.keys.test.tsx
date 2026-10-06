// @vitest-environment jsdom
/**
 * 播放器键盘（用户 2026-10-06 需求）：**指针移入就接管键盘、移出交回页面**，且**不进 Tab 序**。
 *
 * ## 为什么原来那套"点了播放键之后方向键没反应"
 *
 * 快捷键实现一直是全的（`/`、`k`、`←→↑↓`、`m`、`f`），坏在**入口**：监听挂在播放器容器上，
 * 只有焦点在容器里才收得到；而那颗大播放键在开播后就被**卸载**了，焦点随之掉回 `<body>`
 * ⇒ 之后的按键谁也接不到。所以现在监听挂在 `document` 上，由"**指针在不在播放器里**"开关。
 *
 * 这里守四件事：
 * ① 指针移入 ⇒ 方向键/空格/音量/静音/全屏都能用（且 `preventDefault`，页面不会跟着滚）；
 * ② 指针移出 ⇒ **交回页面**（同一个键不再有反应）；
 * ③ 正在输入框里打字时 ⇒ 一律不抢（即便指针还在播放器上）；
 * ④ Tab 序契约：容器与它里面的按钮**全部 `tabIndex={-1}`**（用户口径「播放器中禁用 tab 焦点」）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VideoPlayer from './VideoPlayer'
import { playerPrefs, resetPlayerPrefs } from '../utils/playerPrefs'

vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const VIDEO = { url: 'http://v/a.mp4', fallbacks: [] as string[] }

let host: HTMLDivElement
let root: Root
let reqFs: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetPlayerPrefs()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
  reqFs = vi.fn(() => Promise.resolve())
  ;(HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = reqFs
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen
})

/** 渲染并把"视频总长"补成 100s —— jsdom 里 `duration` 是 NaN，不补的话 `seekBy` 会被夹回 0。 */
function render() {
  act(() => root.render(<VideoPlayer video={VIDEO} />))
  const v = el()
  Object.defineProperty(v, 'duration', { configurable: true, value: 100 })
  return v
}

const el = () => host.querySelector('video') as HTMLVideoElement
const vp = () => host.querySelector('.vp') as HTMLElement

/**
 * 指针进/出播放器。
 *
 * ⚠️ 派发的必须是 **`pointerover` / `pointerout`**（冒泡、React 靠它们合成
 * `onPointerEnter` / `onPointerLeave`）—— `pointerenter` 自身**不冒泡**，React 18 挂在
 * 根容器上的委托监听收不到它，派发了也等于没进过播放器（第一版就是这么全红的）。
 */
function hover(on: boolean) {
  act(() => {
    vp().dispatchEvent(new PointerEvent(on ? 'pointerover' : 'pointerout', {
      bubbles: true, cancelable: true, relatedTarget: null,
    }))
  })
}

/** 在 `document` 上敲一下（真实用户按键走的就是这条路）。 */
function key(k: string, opts: { target?: EventTarget; type?: 'keydown' | 'keyup' } = {}) {
  const e = new KeyboardEvent(opts.type ?? 'keydown', { key: k, bubbles: true, cancelable: true })
  act(() => { (opts.target ?? document).dispatchEvent(e) })
  return e
}

describe('播放器键盘：指针移入接管、移出交回', () => {
  it('移入后 →/← 能快进快退（并 preventDefault，不让页面跟着滚）', () => {
    const v = render()
    hover(true)
    // 右方向键的口径是**按住 250ms 才 3×**，短按在**松手**那一刻补上"快进 5s"（devlog/356）
    // ⇒ 必须成对派发 keydown + keyup，只发 keydown 什么也不该发生。
    const e = key('ArrowRight')
    expect(v.currentTime, '只按下、还没松手 ⇒ 先不动').toBeCloseTo(0, 1)
    expect(e.defaultPrevented, '接管了就必须拦默认行为（否则页面会滚）').toBe(true)
    key('ArrowRight', { type: 'keyup' })
    expect(v.currentTime, '短按松手 ⇒ +5s').toBeCloseTo(5, 1)
  })

  it('**指针不在播放器里就不接管**（交回页面）', () => {
    const v = render()
    const e = key('ArrowRight')
    expect(v.currentTime, '没移入 ⇒ 一秒都不该动').toBe(0)
    expect(e.defaultPrevented, '没接管就不许拦默认行为').toBe(false)
  })

  it('移出之后立刻交回（同一次挂载内来回切）', () => {
    const v = render()
    hover(true)
    key('ArrowRight')
    key('ArrowRight', { type: 'keyup' })
    expect(v.currentTime).toBeGreaterThan(0)
    hover(false)
    v.currentTime = 0
    key('ArrowRight')
    key('ArrowRight', { type: 'keyup' })
    expect(v.currentTime, '移出后不该再接管').toBe(0)
  })

  it('空格 = 暂停/播放（看 UI 契约，不看 jsdom 的桩）', async () => {
    const v = render()
    hover(true)
    expect(vp().getAttribute('data-vp-state')).toBe('paused')
    // ⚠️ jsdom 不实现媒体播放：`play()` 是桩、**不会**自己发 `play` 事件，而组件的播放态正是
    //    由 `onPlay/onPause` 驱动的 ⇒ 这里得替浏览器把事件补上（与 `VideoPlayer.test.tsx`
    //    同一条约定），否则测的是桩不是组件。
    await act(async () => { key(' '); v.dispatchEvent(new Event('play')); await Promise.resolve() })
    expect(vp().getAttribute('data-vp-state')).toBe('playing')
    await act(async () => { key(' '); v.dispatchEvent(new Event('pause')); await Promise.resolve() })
    expect(vp().getAttribute('data-vp-state')).toBe('paused')
  })

  it('m 静音 / ↑↓ 音量（看**偏好**本身，不绕 UI 档位）', () => {
    render()
    hover(true)
    expect(playerPrefs().muted).toBe(false)
    key('m')
    expect(playerPrefs().muted, 'm 应当是静音').toBe(true)
    key('m')
    expect(playerPrefs().muted).toBe(false)
    // ⚠️ 音量别用"档位变了"来判（1.0 → 0.95 仍是 `high`，第一版就是这么假红的）
    const before = playerPrefs().volume
    key('ArrowDown')
    expect(playerPrefs().volume).toBeLessThan(before)
    key('ArrowUp')
    expect(playerPrefs().volume).toBeCloseTo(before, 5)
  })

  it('f = 全屏（调容器上的 requestFullscreen）', () => {
    render()
    hover(true)
    key('f')
    expect(reqFs).toHaveBeenCalled()
  })

  it('全屏时**不靠指针也接管**（全屏下鼠标可能停着不动）', () => {
    const v = render()
    // 直接伪造"已进全屏"：`requestFullscreen` 在 jsdom 里是桩、不会真的切全屏，
    // 组件听的是 `fullscreenchange` + `document.fullscreenElement`
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: vp() })
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    try {
      v.currentTime = 0
      key('ArrowRight')
      key('ArrowRight', { type: 'keyup' })
      expect(v.currentTime, '全屏态必须照样接管（此时指针可能已不在播放器上）').toBeCloseTo(5, 1)
    } finally {
      act(() => {
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
        document.dispatchEvent(new Event('fullscreenchange'))
      })
    }
  })

  it('正在输入框里打字 ⇒ 不抢键（哪怕指针还在播放器上）', () => {
    const v = render()
    hover(true)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    const e = key('ArrowRight', { target: input })
    expect(v.currentTime, '输入框里的方向键归输入框').toBe(0)
    expect(e.defaultPrevented).toBe(false)
    input.remove()
  })
})

describe('播放器键盘：Tab 序契约（用户口径「播放器中禁用 tab 焦点」）', () => {
  it('容器与它里面的**每一个按钮**都是 tabIndex=-1', () => {
    render()
    // 先把控件都露出来（大播放键/底栏/菜单都可能按状态条件渲染）
    hover(true)
    expect(vp().getAttribute('tabindex'), '容器不进 Tab 序').toBe('-1')
    const buttons = Array.from(vp().querySelectorAll('button'))
    expect(buttons.length, '这条判据要真的扫到按钮').toBeGreaterThan(3)
    const offenders = buttons
      .filter((b) => b.getAttribute('tabindex') !== '-1')
      .map((b) => b.getAttribute('class') || b.getAttribute('aria-label') || '(无名)')
    expect(offenders, '这些按钮还在 Tab 序里（Tab 会一个个停过去）').toEqual([])
  })
})
