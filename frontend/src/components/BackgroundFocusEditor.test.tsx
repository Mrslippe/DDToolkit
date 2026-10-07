// @vitest-environment jsdom
/**
 * 背景取景编辑器（需求 7；口径 V1b-3 换成"图片锚点"后重写，`devlog/420`）。
 *
 * 这里判的不是样式，是**手感的四条约定**（每条都能被改坏）：
 * ① **图跟手**：拖拽按"溢出量"换算，拖 60px 图就挪 60px；
 * ② **没余量的那条轴就是挪不动**（竖图铺在横框里 ⇒ 横向无余量 ⇒ 拖了也不动，且**不许**跳变）——
 *    ⚠️ 旧口径下这条是"自动抬到 120%"绕过去的，现在不需要了：`scale=1` 纵向照样能挪；
 * ③ **三件套一起挂**（位置 + 缩放 + **支点**），支点必须与位置同源；
 * ④ **松手才存**、点一下不算取景（死区）。
 *
 * ⚠️ 舞台尺寸在 jsdom 里量出来是 0，所以统一把 `getBoundingClientRect` 打成 300×120；
 *    图片原始尺寸由 `Image` 桩给成 900×1200（`cover` 倍数 = max(框/图) = 1/3 ⇒ 图渲染成 300×400）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setBackgroundFocus = vi.fn()
const clearBackgroundFocus = vi.fn()

vi.mock('../api/api', () => ({
  api: {
    setBackgroundFocus: (...a: unknown[]) => setBackgroundFocus(...a),
    clearBackgroundFocus: (...a: unknown[]) => clearBackgroundFocus(...a),
  },
}))
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }))

/** 图片桩：jsdom 不会真的解码，得自己把"原始尺寸"喂进去（`onload` 排队到微任务）。 */
class FakeImage {
  onload: (() => void) | null = null
  naturalWidth = 900
  naturalHeight = 1200
  set src(_v: string) { queueMicrotask(() => this.onload?.()) }
}
vi.stubGlobal('Image', FakeImage)

import BackgroundFocusEditor from './BackgroundFocusEditor'
import type { VTuber } from '../api/types'

// ⚠️ 少了这一句：`act()` 不会真的去冲被动副作用 —— 卸载时的"关窗兜底"永远看不到（而且是**假绿**）
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const V_ID = 7
const STAGE_W = 300
const STAGE_H = 120
const nativeValueSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

function mkVTuber(over: Partial<VTuber> = {}): VTuber {
  return { id: V_ID, name: '柚子', background_focus: null, ...over } as VTuber
}

let host: HTMLDivElement
let root: Root
let mounted: boolean
let savedResult: VTuber | undefined

const onSaved = (v: VTuber) => {
  savedResult = v
}

function stage() {
  return host.querySelector<HTMLElement>('.vd-focus-stage')!
}
function img() {
  return host.querySelector<HTMLElement>('.vd-focus-img')!
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    (b.textContent || '').includes(label),
  )!
}
function slider() {
  return host.querySelector<HTMLInputElement>('.vd-focus-range')!
}
const pct = () => host.querySelector('.vd-focus-pct')!.textContent

/** ⚠️ jsdom 量不出布局 —— 打个真实尺寸进去，换算才有意义。 */
function stubRect(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({ width: STAGE_W, height: STAGE_H, top: 0, left: 0, right: STAGE_W, bottom: STAGE_H, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

async function mount(over: Partial<VTuber> = {}) {
  await act(async () => {
    root.render(
      <BackgroundFocusEditor vtuber={mkVTuber(over)} src="/static/custom_bg/a.webp" onSaved={onSaved} />,
    )
    await Promise.resolve()
  })
  stubRect(stage())
  // 让 `Image` 桩的 onload（微任务）跑完 ⇒ 组件拿到原始尺寸
  await act(async () => { await Promise.resolve() })
}

/** 按下 → 移动 → 松手。`dx`/`dy` 是**总位移**（像素）。 */
async function drag(dx: number, dy: number) {
  const el = stage()
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }))
  })
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100 + dx, clientY: 50 + dy }))
  })
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 100 + dx, clientY: 50 + dy }))
    await Promise.resolve()
  })
}

async function setRange(v: number) {
  const el = slider()
  await act(async () => {
    // ⚠️ 必须走**原生 setter**：React 会给 `<input>` 实例装一个 value 拦截器，`el.value = x`
    //    会被它当成"React 自己写进去的值"而**静默不派发 onChange**（探针实测，`devlog/419`）。
    nativeValueSet.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const flushTimers = async () => {
  await act(async () => {
    vi.advanceTimersByTime(400)
    await Promise.resolve()
  })
}

const lastFocus = () => {
  const calls = setBackgroundFocus.mock.calls
  return calls[calls.length - 1][1] as { x: number; y: number; scale: number }
}

beforeEach(() => {
  setBackgroundFocus.mockReset().mockResolvedValue(mkVTuber())
  clearBackgroundFocus.mockReset().mockResolvedValue(mkVTuber())
  savedResult = undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  mounted = false
  host.remove()
  document.body.innerHTML = ''
})

describe('BackgroundFocusEditor', () => {
  it('★ 1:1 跟手：图渲染成 300×400、scale=2 ⇒ 往右拖 60px，锚点正好减 0.2', async () => {
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
    await drag(60, 0)
    expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
    // 横向溢出 = 2×300 − 300 = 300 ⇒ Δx = −60/300 = −0.2
    expect(lastFocus().x).toBeCloseTo(0.3, 6)
    expect(lastFocus().scale, '已有缩放就别动它').toBe(2)
    expect(setBackgroundFocus.mock.calls[0][0]).toBe(V_ID)
    // ★ 三件套：位置、缩放、**支点同源**
    expect(img().style.backgroundPosition).toBe('30% 50%')
    expect(img().style.transform).toBe('scale(2)')
    expect(img().style.transformOrigin, '支点必须跟着锚点走').toBe('30% 50%')
  })

  it('★ `scale=1` 也能挪：纵向有余量就跟手，横向没余量就**一动不动**（不许跳变）', async () => {
    await mount({ background_focus: null })
    await drag(60, 60)
    // 横向：300 − 1×300 = 0 ⇒ 无余量 ⇒ x 不变
    expect(lastFocus().x, '横向没有可挪的余量').toBe(0.5)
    // 纵向：400 − 120 = 280 ⇒ Δy = −60/280
    expect(lastFocus().y).toBeCloseTo(0.5 - 60 / 280, 6)
    expect(lastFocus().scale, '⚠️ 旧口径那套"拖动自动抬到 120%"已经删掉').toBe(1)
    expect(img().style.transform, 'scale=1 ⇒ 不生成变换').toBe('')
    expect(img().style.backgroundPosition).toBe('50% 28.57%')
  })

  it('★ 死区：点一下不算取景 —— 不发请求、也不动', async () => {
    await mount({ background_focus: null })
    await drag(2, 1)
    expect(setBackgroundFocus).not.toHaveBeenCalled()
    expect(img().style.backgroundPosition, '没有取景 ⇒ 居中').toBe('50% 50%')
  })

  it('拖拽**松手才存**：按下+移动期间一个请求都不发', async () => {
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
    const el = stage()
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }))
      el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160, clientY: 50 }))
    })
    expect(setBackgroundFocus).not.toHaveBeenCalled()
    expect(img().style.transform, '但预览要跟着动').toBe('scale(2)')
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 160, clientY: 50 }))
      await Promise.resolve()
    })
    expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
  })

  it('滑杆：一次滑动只打一发（防抖）+ 越界夹在 1..3 + 支点跟着变', async () => {
    vi.useFakeTimers()
    try {
      await mount({ background_focus: null })
      await setRange(1.5)
      // ⚠️ 先证"滑杆真推动了"：这一步要是假的，下面两条全是假绿（探针踩过一次）
      expect(pct(), '滑杆没推动 ⇒ 后面的判据都不算数').toBe('150%')
      await setRange(2.5)
      await setRange(9) // 想给 900%，只能到 300%
      expect(setBackgroundFocus, '还在防抖窗口里').not.toHaveBeenCalled()
      await flushTimers()
      expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
      expect(lastFocus().scale).toBe(3)
      expect(pct()).toBe('300%')
      expect(img().style.transform).toBe('scale(3)')
      expect(img().style.transformOrigin).toBe(img().style.backgroundPosition)
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 关窗兜底：防抖窗口里关窗 ⇒ 最后一格补发（不然白调）', async () => {
    vi.useFakeTimers()
    try {
      await mount({ background_focus: null })
      await setRange(1.8)
      expect(setBackgroundFocus).not.toHaveBeenCalled()
      expect(pct(), '滑杆真推动了').toBe('180%')
      expect(vi.getTimerCount(), '防抖那一发还挂着').toBe(1)
      act(() => root.unmount())
      mounted = false
      expect(vi.getTimerCount(), '兜底要把挂着的防抖清掉').toBe(0)
      await act(async () => {
        await Promise.resolve()
      })
      expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
      expect(lastFocus().scale).toBeCloseTo(1.8, 6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('坏 JSON / 空取景 ⇒ 不生成任何**变换**（退回"原样铺"），也不炸', async () => {
    await mount({ background_focus: '{{{' })
    expect(img().style.backgroundPosition, '没有取景 ⇒ 居中（= 样式表默认值）').toBe('50% 50%')
    expect(img().style.transform).toBe('')
    // ⚠️ 引擎会把 `aspect-ratio` 规范成 `1.777… / 1`，所以按数值比（别拿字符串比）
    expect(parseFloat(stage().style.aspectRatio), '量不到真背景层 ⇒ 退回默认比例').toBeCloseTo(16 / 9, 6)
    await mount({ background_focus: '{"x":0.2,"y":0.1,"scale":2}' })
    expect(img().style.backgroundPosition).toBe('20% 10%')
    expect(img().style.transformOrigin).toBe('20% 10%')
  })

  it('「重置取景」= 删掉取景记录，**不动背景图**', async () => {
    await mount({ background_focus: '{"x":0.2,"y":0.2,"scale":2}' })
    expect(img().style.transform).toBe('scale(2)')
    await act(async () => {
      button('重置取景').click()
      await Promise.resolve()
    })
    expect(clearBackgroundFocus).toHaveBeenCalledWith(V_ID)
    expect(setBackgroundFocus, '重置不是"存一个居中值"').not.toHaveBeenCalled()
    expect(img().style.backgroundPosition, '立刻回到默认居中').toBe('50% 50%')
    expect(savedResult, 'onSaved 拿到的是后端返回的新 VTuber').toBeTruthy()
  })

  it('方向键与拖拽**同一个模型**：ArrowRight 推的是图 ⇒ 锚点 x 变小；Shift 步长 ×5', async () => {
    vi.useFakeTimers()
    try {
      await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
      const el = stage()
      await act(async () => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      })
      await flushTimers()
      expect(lastFocus().x).toBeCloseTo(0.48, 6)
      expect(lastFocus().scale, '方向键不再偷偷改缩放').toBe(2)
      await act(async () => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
      })
      await flushTimers()
      expect(lastFocus().y).toBeCloseTo(0.5 - 0.1, 6)
    } finally {
      vi.useRealTimers()
    }
  })
})
