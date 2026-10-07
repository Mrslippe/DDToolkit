// @vitest-environment jsdom
/**
 * 背景取景编辑器（需求 7 / V1b-2，`devlog/419`）。
 *
 * 这里判的不是样式，是**手感的三条约定**（每条都能被改坏，所以都值得钉住）：
 * ① **图跟手**：往右拖 ⇒ 图右移 ⇒ 露出左半张 ⇒ 取景点 `x` **变小**（方向口径见 `backgroundFocus.ts`）；
 * ② **松手才发请求**、且**点一下不算取景**（死区）；
 * ③ `scale === 1` 开拖会**抬到 120%** —— 没缩放时平移在数学上无处可去，不抬就是"拖了没反应"。
 *
 * ⚠️ 舞台尺寸在 jsdom 里量出来是 0，所以下面统一把 `getBoundingClientRect` 打成 300×120，
 *    否则 1:1 跟手的算式退化、判据会变成"随便动一下都过"。
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

import BackgroundFocusEditor from './BackgroundFocusEditor'
import type { VTuber } from '../api/types'

// ⚠️ 少了这一句：`act()` 不会真的去冲被动副作用 —— 卸载时的"关窗兜底"永远看不到（而且是**假绿**：看着像兜底生效了）
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

/** ⚠️ jsdom 量不出布局 —— 打个真实尺寸进去，算式才有意义。 */
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
}

/** 按下 → 移动若干步 → 松手。`dx`/`dy` 是**总位移**（像素）。 */
async function drag(dx: number, dy: number) {
  const el = stage()
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }))
  })
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 100 + dx, clientY: 50 + dy }),
    )
  })
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, clientX: 100 + dx, clientY: 50 + dy }),
    )
    await Promise.resolve()
  })
}

async function setRange(v: number) {
  const el = slider()
  await act(async () => {
    // ⚠️ 必须走**原生 setter**：React 会给 `<input>` 实例装一个 value 拦截器，`el.value = x`
    //    会被它当成"React 自己写进去的值"而**静默不派发 onChange**（探针实测：直接赋值 + input 事件，
    //    百分比纹丝不动）。绕过它的唯一办法是从 `HTMLInputElement.prototype` 上取原始 setter。
    nativeValueSet.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const pct = () => host.querySelector('.vd-focus-pct')!.textContent

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
  it('★ 1:1 跟手：scale=2、舞台 300px 时往右拖 60px ⇒ x 正好减 0.2', async () => {
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
    await drag(60, 0)
    expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
    // Δx = -60/((2-1)·300) = -0.2 ⇒ 0.3；往右拖 ⇒ x 变小 ⇒ 看的是左半张 ✓
    expect(lastFocus().x).toBeCloseTo(0.3, 6)
    expect(lastFocus().y).toBeCloseTo(0.5, 6)
    expect(lastFocus().scale, '已有缩放就别动它').toBe(2)
    expect(setBackgroundFocus.mock.calls[0][0]).toBe(V_ID)
    // 端到端方向（拖拽 ⇒ x ⇒ transform 三段拼起来才是"手感"）：往右拖 ⇒ 图整体**右移** ⇒ 露出左半张 ✓
    expect(img().style.transform).toBe('translate(20%, 0%) scale(2)')
  })

  it('★ scale=1 开拖 ⇒ 抬到 120%（见文件头 ③），且方向仍是"看左半张"', async () => {
    await mount({ background_focus: null })
    await drag(60, 0)
    expect(lastFocus().scale).toBeCloseTo(1.2, 6)
    expect(lastFocus().x).toBe(0) // 60/((1.2-1)·300) = 1 ⇒ 夹到 0（顶到图片左边缘）
  })

  it('★ 死区：点一下不算取景 —— 不发请求、也不放大', async () => {
    await mount({ background_focus: null })
    await drag(2, 1)
    expect(setBackgroundFocus).not.toHaveBeenCalled()
    expect(img().style.transform, '仍是原样铺').toBe('')
  })

  it('拖拽**松手才存**：按下+移动期间一个请求都不发', async () => {
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
    const el = stage()
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }))
      el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160, clientY: 50 }))
    })
    expect(setBackgroundFocus).not.toHaveBeenCalled()
    expect(img().style.transform, '但预览要跟着动').toContain('scale(2)')
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 160, clientY: 50 }))
      await Promise.resolve()
    })
    expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
  })

  it('滑杆：一次滑动只打一发（防抖）+ 越界夹在 1..3', async () => {
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

  it('坏 JSON / 空取景 ⇒ 原样铺（不生成 transform），也不炸', async () => {
    await mount({ background_focus: '{{{' })
    expect(img().style.transform).toBe('')
    expect(host.querySelector('.vd-focus-hint'), '没缩放时提示"拖动取景"').toBeTruthy()
    await mount({ background_focus: '{"x":0.2,"y":0.1,"scale":2}' })
    expect(img().style.transform).toBe('translate(30%, 40%) scale(2)')
  })

  it('「重置取景」= 删掉取景记录，**不动背景图**', async () => {
    await mount({ background_focus: '{"x":0.2,"y":0.2,"scale":2}' })
    expect(img().style.transform).not.toBe('')
    await act(async () => {
      button('重置取景').click()
      await Promise.resolve()
    })
    expect(clearBackgroundFocus).toHaveBeenCalledWith(V_ID)
    expect(setBackgroundFocus, '重置不是"存一个居中值"').not.toHaveBeenCalled()
    expect(img().style.transform, '立刻回到原样铺').toBe('')
    expect(savedResult, 'onSaved 拿到的是后端返回的新 VTuber').toBeTruthy()
  })

  it('方向键与拖拽**同一个模型**：ArrowRight 推的是图 ⇒ x 变小；Shift 步长 ×5', async () => {
    vi.useFakeTimers()
    try {
      await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
      const el = stage()
      await act(async () => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      })
      await flushTimers()
      expect(lastFocus().x).toBeCloseTo(0.48, 6)
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
