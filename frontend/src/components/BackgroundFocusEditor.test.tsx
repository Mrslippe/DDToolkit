// @vitest-environment jsdom
/**
 * 背景取景（需求 7；操作面 V1b-4 搬进预览框，`devlog/421`）。
 *
 * 这里判的**不是样式**，是"手感 + 客户端契约"六条（每条都能被改坏）：
 * ① **图跟手**：拖拽按"溢出量"换算；
 * ② **没余量的那条轴一动不动**（竖图铺在宽框里，横向本来就没有可露的部分，且不许跳变）；
 * ③ ★**滚轮缩放**：向上滚放大、向下滚缩回，且**必须 `preventDefault` 成功**
 *    （`defaultPrevented` 为真 ⇒ 非被动监听真的挂上了；被动监听拦不住弹窗跟着滚）；
 * ④ **没有滑杆**（用户要求撤掉）—— 这条直接用"渲染里不含 `input[type=range]`"钉住；
 * ⑤ **三件套一起挂**（位置 + 缩放 + **支点同源**）；
 * ⑥ 松手/滚停才存、点一下不算取景、关窗兜底补发。
 *
 * ⚠️ 框尺寸在 jsdom 里量出来是 0，所以统一把 `getBoundingClientRect` 打成 132×74；
 *    图片原始尺寸由 `Image` 桩给成 900×1200 ⇒ `cover` 倍数 = max(132/900, 74/1200) = 0.1467
 *    ⇒ 图渲染成 132×176（**横向没余量、纵向有 102px**）—— 这正是"竖图铺在宽框里"的形态。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setBackgroundFocus = vi.fn()
const clearBackgroundFocus = vi.fn()
const setBackgroundVideoFocus = vi.fn()
const clearBackgroundVideoFocus = vi.fn()

vi.mock('../api/api', () => ({
  api: {
    setBackgroundFocus: (...a: unknown[]) => setBackgroundFocus(...a),
    clearBackgroundFocus: (...a: unknown[]) => clearBackgroundFocus(...a),
    setBackgroundVideoFocus: (...a: unknown[]) => setBackgroundVideoFocus(...a),
    clearBackgroundVideoFocus: (...a: unknown[]) => clearBackgroundVideoFocus(...a),
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
/** 预览框现在**占满整幅宽**（16:9 ⇒ 460×258.75），所以拖拽换算按这个尺寸来。 */
const BOX_W = 460
const BOX_H = 258.75
/** `cover` 下图的渲染尺寸 = 900×1200 × (460/900) ⇒ 460×613.33（横向没余量、纵向溢出 354.58）。 */
const IMG_W = 460
const IMG_H = 1200 * (BOX_W / 900)

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

const box = () => host.querySelector<HTMLElement>('[data-testid="focus-box"]')!
const img = () => host.querySelector<HTMLElement>('[data-testid="focus-img"]')!
const resetBtn = () => host.querySelector<HTMLButtonElement>('.vd-focus-reset')!
const badge = () => host.querySelector<HTMLElement>('.vd-focus-zoom')

/** ⚠️ jsdom 量不出布局 —— 打个真实尺寸进去，换算才有意义。 */
function stubRect(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({ width: BOX_W, height: BOX_H, top: 0, left: 0, right: BOX_W, bottom: BOX_H, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

async function mount(over: Partial<VTuber> = {}, videoSrc: string | null = null) {
  await act(async () => {
    root.render(
      <BackgroundFocusEditor vtuber={mkVTuber(over)} src="/static/custom_bg/a.webp"
                             videoSrc={videoSrc} onSaved={onSaved} />,
    )
    await Promise.resolve()
  })
  stubRect(box())
  // 让 `Image` 桩的 onload（微任务）跑完 ⇒ 组件拿到原始尺寸
  await act(async () => { await Promise.resolve() })
}

/** 按下 → 移动 → 松手。`dx`/`dy` 是**总位移**（像素）。 */
async function drag(dx: number, dy: number) {
  const el = box()
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

/** 滚一格。返回事件本身，好断言 `defaultPrevented`。 */
async function wheel(deltaY: number) {
  const el = box()
  const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
  await act(async () => {
    el.dispatchEvent(ev)
  })
  return ev
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
  setBackgroundVideoFocus.mockReset().mockResolvedValue(mkVTuber())
  clearBackgroundVideoFocus.mockReset().mockResolvedValue(mkVTuber())
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
  vi.useRealTimers()
})

describe('BackgroundFocusEditor', () => {
  it('★ 1:1 跟手：图渲染成 460×613、scale=2 ⇒ 往右拖 30px，锚点正好减 30/460', async () => {
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
    await drag(30, 0)
    expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
    // 横向溢出 = 2×460 − 460 = 460 ⇒ Δx = −30/460
    expect(lastFocus().x).toBeCloseTo(0.5 - 30 / IMG_W, 6)
    expect(lastFocus().scale, '拖拽不许改缩放').toBe(2)
    expect(setBackgroundFocus.mock.calls[0][0]).toBe(V_ID)
    // ★ 三件套：位置、缩放、**支点同源**（百分比限两位小数）
    expect(img().style.backgroundPosition).toBe('43.48% 50%')
    expect(img().style.transform).toBe('scale(2)')
    expect(img().style.transformOrigin, '支点必须跟着锚点走').toBe('43.48% 50%')
    expect(badge()!.textContent, '放大时才有读数').toBe('200%')
  })

  it('★ `scale=1` 时纵向跟手、横向**一动不动**（没余量就不许跳变），且不生成变换', async () => {
    await mount({ background_focus: null })
    await drag(30, 30)
    expect(lastFocus().x, '横向没有可挪的余量').toBe(0.5)
    // 纵向溢出 = 613.33 − 258.75 = 354.58 ⇒ Δy = −30/354.58
    expect(lastFocus().y).toBeCloseTo(0.5 - 30 / (IMG_H - BOX_H), 6)
    expect(lastFocus().scale).toBe(1)
    expect(img().style.transform, 'scale=1 ⇒ 不生成变换').toBe('')
    expect(badge(), '1× 时没有读数').toBeNull()
  })

  it('★ 滚轮缩放：上滚放大、下滚缩回 1×；且**必须 `preventDefault` 成功**（非被动监听）', async () => {
    vi.useFakeTimers()
    await mount({ background_focus: null })
    // ① 上滚一格（鼠标 deltaY≈−100）⇒ ×e^{0.15}
    const up = await wheel(-100)
    expect(up.defaultPrevented, '⚠️ 被动监听拦不住弹窗跟着滚 —— 这条就是钉它的').toBe(true)
    expect(host.querySelector('.vd-focus-zoom')!.textContent).toBe('116%')
    // ② 下滚一格 ⇒ 回到**正好 1×**（近 1 要吸回去，否则永远差一点点）
    await wheel(100)
    expect(badge(), '缩回 1× 时读数消失').toBeNull()
    expect(img().style.transform).toBe('')
    // ③ 一次滚轮只打一发 PUT（防抖）
    expect(setBackgroundFocus, '还在防抖窗口里').not.toHaveBeenCalled()
    await flushTimers()
    expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
    expect(lastFocus().scale, '两下抵消 ⇒ 存回去的还是 1').toBe(1)
  })

  it('★ 滚轮上界：一路往上滚最多到 3×（不许越过后端边界）', async () => {
    vi.useFakeTimers()
    await mount({ background_focus: null })
    for (let i = 0; i < 12; i++) await wheel(-100)
    expect(host.querySelector('.vd-focus-zoom')!.textContent, '预览当场就该封顶').toBe('300%')
    await flushTimers()
    expect(lastFocus().scale, '存下去的也必须封顶').toBe(3)
  })

  it('★ **没有滑杆**（用户要求撤掉）：渲染里不许出现 range 输入', async () => {
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
    expect(host.querySelectorAll('input').length, '取景控件里一个 input 都不该有').toBe(0)
  })

  it('★ 引导句：还没调过时给一句（抓手光标对键盘/触控用户不存在），调过就不再出现', async () => {
    await mount({ background_focus: null })
    expect(host.querySelector('.vd-focus-hint')?.textContent).toContain('拖动平移')
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":1}' })
    expect(host.querySelector('.vd-focus-hint'), '已经有取景 ⇒ 不用再教').toBeNull()
  })

  it('★ 重置钮在框内：它自己的 pointerdown 必须被吃掉（否则按一下会顺手起一次拖拽）', async () => {
    await mount({ background_focus: '{"x":0.2,"y":0.2,"scale":2}' })
    const btn = resetBtn()
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }))
      box().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 50 }))
      box().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 140, clientY: 50 }))
      await Promise.resolve()
    })
    expect(setBackgroundFocus, '按的是重置钮，不该起拖拽').not.toHaveBeenCalled()
    expect(img().style.backgroundPosition, '也不许动取景').toBe('20% 20%')
  })

  it('★ 死区：点一下不算取景 —— 不发请求、也不动', async () => {
    await mount({ background_focus: null })
    await drag(2, 1)
    expect(setBackgroundFocus).not.toHaveBeenCalled()
    expect(img().style.backgroundPosition, '没有取景 ⇒ 居中').toBe('50% 50%')
  })

  it('拖拽**松手才存**：按下+移动期间一个请求都不发', async () => {
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
    const el = box()
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }))
      el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 130, clientY: 50 }))
    })
    expect(setBackgroundFocus).not.toHaveBeenCalled()
    expect(img().style.transform, '但预览要跟着动').toBe('scale(2)')
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 130, clientY: 50 }))
      await Promise.resolve()
    })
    expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
  })

  it('★ 关窗兜底：防抖窗口里关窗 ⇒ 最后一格补发（不然白调）', async () => {
    vi.useFakeTimers()
    await mount({ background_focus: null })
    await wheel(-100)
    expect(setBackgroundFocus).not.toHaveBeenCalled()
    expect(vi.getTimerCount(), '防抖那一发还挂着').toBe(1)
    act(() => root.unmount())
    mounted = false
    expect(vi.getTimerCount(), '兜底要把挂着的防抖清掉').toBe(0)
    await act(async () => {
      await Promise.resolve()
    })
    expect(setBackgroundFocus).toHaveBeenCalledTimes(1)
    expect(lastFocus().scale).toBeCloseTo(1.16, 2)
  })

  it('坏 JSON / 空取景 ⇒ 不生成变换（居中），也不炸', async () => {
    await mount({ background_focus: '{{{' })
    expect(img().style.backgroundPosition).toBe('50% 50%')
    expect(img().style.transform).toBe('')
    await mount({ background_focus: '{"x":0.2,"y":0.1,"scale":2}' })
    expect(img().style.backgroundPosition).toBe('20% 10%')
    expect(img().style.transformOrigin).toBe('20% 10%')
  })

  it('「重置取景」图标钮 = 删掉取景记录，**不动背景图**；没有取景时是禁用的', async () => {
    await mount({ background_focus: '{"x":0.2,"y":0.2,"scale":2}' })
    await act(async () => {
      resetBtn().click()
      await Promise.resolve()
    })
    expect(clearBackgroundFocus).toHaveBeenCalledWith(V_ID)
    expect(setBackgroundFocus, '重置不是"存一个居中值"').not.toHaveBeenCalled()
    expect(img().style.backgroundPosition, '立刻回到居中').toBe('50% 50%')
    expect(savedResult, 'onSaved 拿到的是后端返回的新 VTuber').toBeTruthy()
    await mount({ background_focus: null })
    expect(resetBtn().disabled, '本来就没有取景 ⇒ 不许点').toBe(true)
  })

  it('方向键与拖拽**同一个模型**：ArrowRight 推的是图 ⇒ 锚点 x 变小；Shift 步长 ×5', async () => {
    vi.useFakeTimers()
    await mount({ background_focus: '{"x":0.5,"y":0.5,"scale":2}' })
    const el = box()
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await flushTimers()
    expect(lastFocus().x).toBeCloseTo(0.48, 6)
    expect(lastFocus().scale, '方向键不偷偷改缩放').toBe(2)
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
    })
    await flushTimers()
    expect(lastFocus().y).toBeCloseTo(0.4, 6)
  })

  // ── 需求 9 补丁：两份取景 + 一个切换钮 + 视频首帧预览（devlog/427）──────

  const switchBtn = () => [...host.querySelectorAll<HTMLButtonElement>('.vd-focus-switch')][0]
  const previewVideo = () => host.querySelector<HTMLVideoElement>('[data-testid="focus-video"]')

  it('★ 切换钮只在**两样都有**时出现；且默认调图片', async () => {
    await mount({ background_focus: null })
    expect(switchBtn(), '只有图 ⇒ 没什么可切').toBeUndefined()
    await mount({ background_focus: null }, '/static/custom_bg/a.mp4')
    expect(switchBtn()?.textContent, '默认调的是图片').toContain('图片取景')
    expect(previewVideo(), '调图片时视频**收起来**（真实投放里它盖住图）').toBeNull()
  })

  it('★ 切到视频 ⇒ 预览换成视频**首帧**（`#t=` + 不 autoplay），存的是**另一份**', async () => {
    await mount(
      { background_focus: '{"x":0.2,"y":0.2,"scale":2}',
        background_video_focus: '{"x":0.8,"y":0.9,"scale":1.5}' },
      '/static/custom_bg/a.mp4',
    )
    await act(async () => { switchBtn().click() })
    const v = previewVideo()!
    expect(v.getAttribute('src'), '停在第一帧的媒体片段').toContain('#t=0.001')
    expect(v.preload).toBe('auto')
    expect(v.muted).toBe(true)
    expect(v.autoplay, '⚠️ 首帧预览不是"播放"').toBe(false)
    expect(v.paused, '不许自己播起来').toBe(true)
    // 预览用的是**视频那份**（0.8/0.9/1.5），不是图片那份
    expect(v.style.objectPosition).toBe('80% 90%')
    expect(v.style.transform).toBe('scale(1.5)')
    expect(img().style.backgroundPosition, '图那份原样不动').toBe('20% 20%')
    // 视频的原始尺寸由元数据给（jsdom 里 `videoWidth` 默认 0 ⇒ 必须显式喂一次）
    Object.defineProperty(v, 'videoWidth', { configurable: true, value: 900 })
    Object.defineProperty(v, 'videoHeight', { configurable: true, value: 1200 })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')) })
    // 拖动 ⇒ 存到视频那个端点，图片端点一次都不许被打
    await drag(30, 0)
    expect(setBackgroundVideoFocus, '打到视频那份').toHaveBeenCalledTimes(1)
    expect(setBackgroundFocus, '⚠️ 动视频取景不该碰图片取景').not.toHaveBeenCalled()
    // 溢出 = scale·imgW − 框宽 = 1.5×460 − 460 = 230 ⇒ Δx = −30/230（图片那条用例是同样的算法）
    expect(setBackgroundVideoFocus.mock.calls[0][1].x).toBeCloseTo(0.8 - 30 / (IMG_W * 0.5), 6)
  })

  it('★ 「重置取景」打的是**当前那一份**（切到视频 ⇒ 清视频取景）', async () => {
    await mount(
      { background_focus: '{"x":0.2,"y":0.2,"scale":2}', background_video_focus: '{"x":0.8,"y":0.9,"scale":1.5}' },
      '/static/custom_bg/a.mp4',
    )
    await act(async () => { switchBtn().click() })
    await act(async () => {
      resetBtn().click()
      await Promise.resolve()
    })
    expect(clearBackgroundVideoFocus).toHaveBeenCalledWith(V_ID)
    expect(clearBackgroundFocus, '⚠️ 清视频取景不该碰图片取景').not.toHaveBeenCalled()
    expect(previewVideo()!.style.objectPosition, '立刻回到居中').toBe('50% 50%')
  })
})
