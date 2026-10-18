// @vitest-environment jsdom
/**
 * 导航下拉栏 `<NavMenu>`（B4，`docs/plans/vod-autofill.md`）。
 *
 * 用户 2026-10-15 的口径是这条组件存在的全部理由：
 *
 * > 图一红框那个按钮「我希望打开的是下拉栏而不是独立窗口，因为详情页本身已经是独立窗口，
 * > 如果再打开一个小窗会显得层级关系混乱，**背景遮罩颜色也不对劲**」
 *
 * 所以判据盯四件事（都是"坏了会静默错"或"用户直接看不见"的）：
 *
 * | 判据 | 坏了会怎样 |
 * |---|---|
 * | 点触发钮开、再点关 | 菜单打不开或关不掉 |
 * | 选中一项**自动关闭** | 点完还得手动关，最烦人 |
 * | Esc / 点外部关闭 | 只能靠再点一次触发钮 |
 * | 禁用项**有 `disabled` 且有原因** | 要么是"点了没反应"的假入口，要么该禁的没禁 |
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NavMenu, { type NavMenuItem } from './NavMenu'

const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnv.IS_REACT_ACT_ENVIRONMENT = true

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function items(over: Partial<NavMenuItem>[] = []): NavMenuItem[] {
  const base: NavMenuItem[] = [
    { key: 'edit', label: '编辑这一场', onSelect: vi.fn() },
    { key: 'vod', label: '添加录播', hint: 'BV1xx', onSelect: vi.fn() },
    {
      key: 'delete', label: '删除这一场', danger: true, disabled: true,
      disabledReason: '只有手动记录的场次能删', onSelect: vi.fn(),
    },
  ]
  return base.map((b, i) => ({ ...b, ...(over[i] ?? {}) }))
}

function render(list: NavMenuItem[] = items(), align?: 'start' | 'end') {
  act(() => {
    root.render(<NavMenu label="这一场的操作" icon={<span />} items={list} align={align} />)
  })
  return list
}

const trigger = () => host.querySelector<HTMLButtonElement>('[data-nav-trigger]')!
const pop = () => host.querySelector('.nav-menu-pop')
const itemEl = (key: string) =>
  host.querySelector<HTMLButtonElement>(`[data-nav-item="${key}"]`)
const state = () => host.querySelector('[data-nav-menu]')?.getAttribute('data-nav-menu')

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

describe('① 开合', () => {
  it('初始是关的，点触发钮打开、再点关闭', async () => {
    render()
    expect(state()).toBe('closed')
    expect(pop()).toBeNull()

    await click(trigger())
    expect(state()).toBe('open')
    expect(pop()).not.toBeNull()
    expect(itemEl('edit')).not.toBeNull()

    await click(trigger())
    expect(state()).toBe('closed')
    expect(pop()).toBeNull()
  })

  it('★ 选中一项**自动关闭**（点完还得手动关的菜单最烦人）', async () => {
    const list = render()
    await click(trigger())
    await click(itemEl('edit')!)
    expect(list[0].onSelect).toHaveBeenCalledTimes(1)
    expect(state()).toBe('closed')
    expect(pop()).toBeNull()
  })

  it('触发钮带 `aria-haspopup` / `aria-expanded`（读屏与探针都靠它）', async () => {
    render()
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })
})

describe('② 关闭通道', () => {
  it('Esc 关闭', async () => {
    render()
    await click(trigger())
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(state()).toBe('closed')
  })

  it('点外部关闭；点容器内部**不**关（否则点按钮会先关再开）', async () => {
    render()
    await click(trigger())
    // 容器内部（菜单里的一项）—— 不该因 mousedown 就先关掉
    await act(async () => {
      itemEl('vod')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(state()).toBe('open')

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(state()).toBe('closed')
  })

  it('关着的时候不监听（不留悬空的 document 监听器）', async () => {
    const spy = vi.spyOn(document, 'addEventListener')
    render()
    expect(spy.mock.calls.filter(([t]) => t === 'keydown')).toHaveLength(0)
    await click(trigger())
    expect(spy.mock.calls.filter(([t]) => t === 'keydown').length).toBeGreaterThan(0)
    spy.mockRestore()
  })
})

describe('③ 禁用项：不给假入口', () => {
  it('禁用项带 `disabled`，点了**不**触发 onSelect', async () => {
    const list = render()
    await click(trigger())
    const del = itemEl('delete')!
    expect(del.disabled).toBe(true)
    await click(del)
    expect(list[2].onSelect).not.toHaveBeenCalled()
  })

  it('禁用项把**原因**显示出来（不是藏起来，也不是静默禁用）', async () => {
    render()
    await click(trigger())
    expect(pop()!.textContent).toContain('只有手动记录的场次能删')
  })

  it('危险项带 `danger` 类（红字），普通项不带', async () => {
    render()
    await click(trigger())
    expect(itemEl('delete')!.className).toContain('danger')
    expect(itemEl('edit')!.className).not.toContain('danger')
  })
})

describe('⑤ 触发钮的两种形态（用户 2026-10-15：详情页那枚要「原本纯图标样式」）', () => {
  it('默认（日历工具栏）是**浮片**：`float-pill` 那个类还在', () => {
    render()
    const t = trigger()
    expect(t.className).toContain('float-pill')
    expect(t.className).not.toContain('nav-menu-trigger')
  })

  it('★ `bare`（弹窗头部）是**纯图标钮**：不带 `float-pill`（斜切白卡/阴影正是要去掉的）', () => {
    act(() => {
      root.render(
        <NavMenu label="这一场的操作" icon={<span />} items={items()} bare />,
      )
    })
    const t = trigger()
    expect(t.className).toContain('nav-menu-trigger')
    expect(t.className).not.toContain('float-pill')
    // 仍然是个带无障碍名的真按钮（换样式不能把可用性一起换掉）
    expect(t.tagName).toBe('BUTTON')
    expect(t.getAttribute('aria-label')).toBe('这一场的操作')
    expect(t.getAttribute('aria-haspopup')).toBe('menu')
  })

  it('`bare` 也不影响开合与选中即关', async () => {
    const list = items()
    act(() => {
      root.render(<NavMenu label="x" icon={<span />} items={list} bare />)
    })
    await click(trigger())
    expect(pop()).not.toBeNull()
    await click(itemEl('edit')!)
    expect(list[0].onSelect).toHaveBeenCalledTimes(1)
    expect(state()).toBe('closed')
  })
})

describe('④ 对齐', () => {  it('`align="end"` 给靠右的按钮（详情弹窗铅笔）加 `end` 类，默认不加', async () => {
    render(items(), 'end')
    await click(trigger())
    expect(pop()!.className).toContain('end')

    // ⚠️ 换 props 重新 render 时 **React 会复用同一个实例**（`open` 这些 state 留着），
    //    所以要真的拿到"默认对齐"那一态，必须换一个根重挂。
    act(() => root.unmount())
    host.remove()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    render(items())
    await click(trigger())
    expect(pop()!.className).not.toContain('end')
  })
})
