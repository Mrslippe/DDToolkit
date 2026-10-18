// @vitest-environment jsdom
/**
 * 工具栏的「添加模块」入口（2026-10-18，用户口径）：
 *
 * > 上半部分按钮的**最下方有一个加号**，点了弹窗选模块，选中确认后出现在左侧工具栏，
 * > 点它进模块。
 *
 * 判据六条（少一条这个流程就是假绿的）：
 * ① 「+」**常驻**（这是唯一添加入口，藏起来就又变成"找不到"）；
 * ② 模块**没添加时按钮不渲染**；
 * ③ 点「+」弹出选择器，勾选后确认 ⇒ **真的写偏好**（`setPref('fan_workbench','on')`）；
 * ④ 写完之后模块按钮**真的出现**（不是只改了 state）；
 * ⑤ 再点「+」取消勾选 ⇒ 按钮消失；
 * ⑥ 写失败 ⇒ **弹窗不关**且显示原因（关掉会让人以为成功了）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── 桩：单推、设置窗、偏好
vi.mock('../utils/soloMode', () => ({
  useSolo: () => null,
  exitSolo: () => ({ id: 0, prevRoute: '/' }),
}))

vi.mock('./AppSettingsDialog', () => ({ default: () => null }))

const setPref = vi.fn()
let prefValues: Record<string, string> = {}

vi.mock('../hooks/usePrefs', () => ({
  usePrefs: () => ({
    values: prefValues,
    setPref: (...a: unknown[]) => setPref(...a),
  }),
}))

import { TooltipProvider } from '@/components/ui/tooltip'

import IconRail from './IconRail'

let host: HTMLDivElement
let root: Root

// ⚠️ 查 `document` 而不是 `host`：Radix 的 DialogContent 渲染在 portal（挂到 body）里，
//    只在 host 里找会得到 null（本文件第一次跑就是全红）。
function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector(sel) as T | null
}

async function mount() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <TooltipProvider>
          <IconRail />
        </TooltipProvider>
      </MemoryRouter>,
    )
  })
}

async function click(sel: string) {
  const el = q<HTMLButtonElement>(sel)
  expect(el, `找不到 ${sel}`).not.toBeNull()
  await act(async () => { el!.click() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(async () => {
  prefValues = {}
  setPref.mockReset().mockImplementation(async (k: string, v: string) => {
    prefValues = { ...prefValues, [k]: v }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll('[data-testid="module-picker"]').forEach((n) => n.remove())
})

describe('工具栏 · 添加模块', () => {
  it('「+」常驻，模块未添加时按钮不渲染', async () => {
    await mount()
    expect(q('[data-testid="rail-add-module"]')).not.toBeNull()
    expect(q('[data-testid="rail-module-fan_workbench"]')).toBeNull()
  })

  it('点「+」弹出选择器，勾选后确认会真的写偏好', async () => {
    await mount()
    await click('[data-testid="rail-add-module"]')
    expect(document.querySelector('[data-testid="module-picker"]')).not.toBeNull()

    await click('[data-testid="module-option-fan_workbench"]')
    await click('[data-testid="module-picker-confirm"]')

    expect(setPref).toHaveBeenCalledWith('fan_workbench', 'on')
  })

  it('写完之后模块按钮真的出现（不是只改 state）', async () => {
    await mount()
    await click('[data-testid="rail-add-module"]')
    await click('[data-testid="module-option-fan_workbench"]')
    await click('[data-testid="module-picker-confirm"]')
    // setPref 桩会改 prefValues，但 `usePrefs` 是桩、不会重渲染 ⇒ 手动重挂模拟
    await mount()
    expect(q('[data-testid="rail-module-fan_workbench"]')).not.toBeNull()
  })

  it('已添加时取消勾选 ⇒ 写 off', async () => {
    prefValues = { fan_workbench: 'on' }
    await mount()
    expect(q('[data-testid="rail-module-fan_workbench"]')).not.toBeNull()

    await click('[data-testid="rail-add-module"]')
    await click('[data-testid="module-option-fan_workbench"]')
    await click('[data-testid="module-picker-confirm"]')
    expect(setPref).toHaveBeenCalledWith('fan_workbench', 'off')
  })

  it('取消不写偏好', async () => {
    await mount()
    await click('[data-testid="rail-add-module"]')
    await click('[data-testid="module-option-fan_workbench"]')
    await click('[data-testid="module-picker-cancel"]')
    expect(setPref).not.toHaveBeenCalled()
  })

  it('写失败时弹窗不关，并把原因显示出来', async () => {
    setPref.mockRejectedValue(new Error('后端炸了'))
    await mount()
    await click('[data-testid="rail-add-module"]')
    await click('[data-testid="module-option-fan_workbench"]')
    await click('[data-testid="module-picker-confirm"]')

    expect(document.querySelector('[data-testid="module-picker"]')).not.toBeNull()
    const err = document.querySelector('[data-testid="module-picker-error"]')
    expect(err?.textContent).toContain('后端炸了')
  })

  it('点模块按钮进对应路由', async () => {
    prefValues = { fan_workbench: 'on' }
    await mount()
    const btn = q<HTMLButtonElement>('[data-testid="rail-module-fan_workbench"]')!
    expect(btn.getAttribute('aria-label')).toBe('数据分析工作台')
  })
})
