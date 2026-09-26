// @vitest-environment jsdom
/**
 * 工具条显隐状态机的**行为**判据（M4，批次 12，devlog/218）。
 *
 * 为什么必须有这一组：计划对 M4 的硬要求是"**抽 hook 同时带出 hook 测试**，否则不做"。
 * 而原来的判据只有 `ui_probe.py --toolbar`（真浏览器 + 虚拟时间），它钉的是**机制**
 * （`data-shown` 与 opacity），量不到"140ms 的 dwell 到底有没有挡住路过"这种边沿行为。
 *
 * 这一组用 jsdom + `react-dom/client` + `act`（不引 Testing Library），假定时器推进时间。
 * ⚠️ **`flashedThisSession` 是模块级的**（抽 hook 时逐字保留的硬约束之一）⇒ 用例之间
 * 会互相影响：每个用例用 `vi.resetModules()` + 动态 `import` 拿一份**全新的模块**。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })

const BAR_DWELL_MS = 140
const BAR_GRACE_MS = 900
const BAR_FLASH_MS = 1200

let host: HTMLDivElement
let root: Root
let switchEl: HTMLDivElement
let toolsEl: HTMLDivElement

/** 热区矩形：`switchEl` 与 `toolsEl` 各自 100×26，摆在顶部（左 / 右） */
function rect(x: number): DOMRect {
  return { x, y: 6, width: 100, height: 26, top: 6, left: x, right: x + 100,
           bottom: 32, toJSON: () => ({}) } as DOMRect
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  switchEl = document.createElement('div')
  toolsEl = document.createElement('div')
  switchEl.getBoundingClientRect = () => rect(0)
  toolsEl.getBoundingClientRect = () => rect(400)
  document.body.append(switchEl, toolsEl)
  root = createRoot(host)
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  switchEl.remove()
  toolsEl.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 渲染一个最小宿主，并拿到 hook 最新一次返回值（`latest`） */
let latest: { barShown: boolean; onPanelMouseMove: (e: { clientX: number; clientY: number }) => void }

async function mount(): Promise<HTMLElement> {
  vi.resetModules()
  const { useToolbarVisibility } = await import('./useToolbarVisibility')
  const { useRef } = await import('react')
  const panel = document.createElement('div')
  document.body.append(panel)

  function Harness({ restored = false }: { restored?: boolean }) {
    const panelRef = useRef<HTMLElement | null>(panel)
    const switchRef = useRef<HTMLElement | null>(switchEl)
    const toolsRef = useRef<HTMLElement | null>(toolsEl)
    const restoredRef = useRef(restored)
    latest = useToolbarVisibility({ panelRef, switchRef, toolsRef, restoredRef })
    return <div id="probe-shown" data-shown={latest.barShown ? '1' : '0'} />
  }
  act(() => { root.render(<Harness />) })
  return panel
}

const shown = () => document.getElementById('probe-shown')!.getAttribute('data-shown') === '1'
const move = (x: number, y: number) => act(() => { latest.onPanelMouseMove({ clientX: x, clientY: y }) })
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
/**
 * ⚠️ **必须 async act**：`MutationObserver` 的回调是**微任务**，同步 `act` 不会 flush 它，
 * 断言就会看到"属性已经改了、但状态没动"（本批实测踩到三次）。
 * StrictMode 那条同理 —— 双渲染的收尾在微任务里。
 */
const settle = () => act(async () => { await Promise.resolve() })
async function setScrollDir(el: HTMLElement, value: string) {
  await act(async () => {
    el.setAttribute('data-scroll-dir', value)
    await Promise.resolve()
  })
}

describe('① 冷启动闪现一次（模块级标记，切 V 重挂不再闪）', () => {
  it('首挂闪 1200ms 后自动收回', async () => {
    await mount()
    expect(shown(), '首挂该立刻闪').toBe(true)

    advance(BAR_FLASH_MS - 1)
    expect(shown()).toBe(true)
    advance(1)
    expect(shown(), '闪现该在 1200ms 时收回').toBe(false)
  })

  it('**同一会话内再次挂载不再闪**（切 V 重挂是常态，闪一次就够）', async () => {
    await mount()
    advance(BAR_FLASH_MS)
    expect(shown()).toBe(false)

    // 重挂（不 resetModules ⇒ 模块级标记还留着）
    act(() => root.unmount())
    root = createRoot(host)
    const { useToolbarVisibility } = await import('./useToolbarVisibility')
    const { useRef } = await import('react')
    const panel2 = document.createElement('div')
    document.body.append(panel2)
    function Again() {
      const panelRef = useRef<HTMLElement | null>(panel2)
      const switchRef = useRef<HTMLElement | null>(switchEl)
      const toolsRef = useRef<HTMLElement | null>(toolsEl)
      const restoredRef = useRef(false)
      latest = useToolbarVisibility({ panelRef, switchRef, toolsRef, restoredRef })
      return <div id="probe-shown" data-shown={latest.barShown ? '1' : '0'} />
    }
    act(() => { root.render(<Again />) })

    expect(shown(), '第二次挂载不该再闪现（否则每次切 V 都闪一下 = 噪音）').toBe(false)
  })
})

describe('② StrictMode 双 effect 下不许"永久停住"', () => {
  it('闪现窗口过完之后必须收回，且指针路径照常可用', async () => {
    // 这条对应一个真实事故（hook 文件头约束 2）：判断若放进 effect，
    // StrictMode 的第二次 setup 会因为"本会话已闪过"而早退 ⇒ 定时器没人装
    // ⇒ **永久停在 shown=1**（`ui_probe.py --toolbar` 实测抓到 `rest: shown=1 opacity=1`）。
    //
    // ⚠️ 不断言"挂载那一刻一定闪了"：jsdom + 假定时器下 StrictMode 的双渲染时序
    //    观察不到稳定的中间态（实测挂载后直接就是 false）。事故的形态是**永久停住**，
    //    所以判据钉的是"窗口过完必须收回 + 指针路径没坏"这两条。
    vi.resetModules()
    const { useToolbarVisibility } = await import('./useToolbarVisibility')
    const { useRef, StrictMode } = await import('react')
    const panel = document.createElement('div')
    document.body.append(panel)

    function Harness() {
      const panelRef = useRef<HTMLElement | null>(panel)
      const switchRef = useRef<HTMLElement | null>(switchEl)
      const toolsRef = useRef<HTMLElement | null>(toolsEl)
      const restoredRef = useRef(false)
      latest = useToolbarVisibility({ panelRef, switchRef, toolsRef, restoredRef })
      return <div id="probe-shown" data-shown={latest.barShown ? '1' : '0'} />
    }
    act(() => { root.render(<StrictMode><Harness /></StrictMode>) })
    await settle()

    advance(BAR_FLASH_MS + 50)
    expect(shown(), '闪现窗口过完还亮着 = 永久停住（探针的 rest 那一格会红）').toBe(false)

    move(50, 20)
    advance(BAR_DWELL_MS)
    expect(shown(), '指针路径也被 StrictMode 弄坏了？').toBe(true)
    move(50, 600)
    advance(BAR_GRACE_MS)
    expect(shown()).toBe(false)
  })
})

describe('③ 指针热区：dwell 过滤"路过"、离开后 grace 收回', () => {
  it('停留 140ms 才呼出；快速穿过（<140ms）不呼出', async () => {
    await mount()
    advance(BAR_FLASH_MS)                    // 先把首挂闪现用掉
    expect(shown()).toBe(false)

    move(50, 20)                             // 进入热区
    advance(BAR_DWELL_MS - 1)
    expect(shown(), '不到 140ms 不该呼出（过滤"路过"）').toBe(false)
    advance(1)
    expect(shown()).toBe(true)
  })

  it('离开热区 900ms 后收回', async () => {
    await mount()
    advance(BAR_FLASH_MS)
    move(50, 20)
    advance(BAR_DWELL_MS)
    expect(shown()).toBe(true)

    move(50, 600)                            // 移出热区
    advance(BAR_GRACE_MS - 1)
    expect(shown()).toBe(true)
    advance(1)
    expect(shown(), 'grace 到点该收回').toBe(false)
  })

  it('指针原地不动（不产生 mousemove）不会自己弹出来 —— 数据视图滚轮翻转不误弹', async () => {
    await mount()
    advance(BAR_FLASH_MS)
    move(50, 20)
    advance(BAR_DWELL_MS)
    move(50, 600)
    advance(BAR_GRACE_MS)
    expect(shown()).toBe(false)

    advance(5000)                            // 什么都不做
    expect(shown()).toBe(false)
  })
})

describe('④ 向下滚动立即让位（R45-G）', () => {
  it('`data-scroll-dir=down` 立刻收起，且**指针还在热区时不许弹回**（要等先离开）', async () => {
    const panel = await mount()
    advance(BAR_FLASH_MS)
    move(50, 20)
    advance(BAR_DWELL_MS)
    expect(shown()).toBe(true)

    // 模拟 OverlayScroll 挂属性（观察者看的是子树里的任意节点）
    const rootEl = document.createElement('div')
    rootEl.className = 'os-root'
    panel.append(rootEl)
    await setScrollDir(rootEl, 'down')
    expect(shown(), '向下滚动该立即让位').toBe(false)

    // 指针还在热区里：不允许因为"边沿没变"之外的任何路径弹回来
    move(60, 20)
    advance(BAR_DWELL_MS + 10)
    expect(shown(), '抑制位没生效 ⇒ 指针停在热区就会把条弹回来（R45-G 的坑）').toBe(false)

    // 先离开热区（解除抑制），再进来 ⇒ 才准重新呼出
    move(50, 600)
    move(50, 20)
    advance(BAR_DWELL_MS)
    expect(shown()).toBe(true)
  })

  it('属性挂到**之后才挂载**的子树节点上也认（`subtree: true`）', async () => {
    // 这条对应另一个真实事故（约束 3）：预先 querySelectorAll 抓快照 ⇒ 视图后挂 ⇒
    // 一个都没 observe 上 ⇒ 功能静默失效。
    const panel = await mount()
    advance(BAR_FLASH_MS)
    move(50, 20)
    advance(BAR_DWELL_MS)
    expect(shown()).toBe(true)

    const late = document.createElement('div')
    panel.append(late)                       // 先挂节点……
    await setScrollDir(late, 'down')         // ……再改属性
    expect(shown()).toBe(false)
  })
})
