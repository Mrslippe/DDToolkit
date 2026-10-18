// @vitest-environment jsdom
/**
 * `FloatPill` 的 DOM 契约（2026-10-15 补：`forwardRef` 那一条）。
 *
 * ## 为什么要专门钉它
 *
 * 它是全站唯一的「交互层」元件，契约写在 `docs/frontend/UI-MAP.md` §C5：
 * **必须渲染原生 `<button class="float-pill …">`** —— 斜切白卡、阴影、`focus-visible` 环
 * 全挂在 `::before` 上，所以换元素或外包一层 div 都会**静默丢样式**（jsdom 不加载 CSS，
 * 没人会发现）。
 *
 * ⚠️ 2026-10-15 加了 `forwardRef`：`<Tooltip><TooltipTrigger asChild>` 这类 Radix 组合
 * 要把 ref 挂到子元素上才算得出锚点位置，而此前它是普通函数组件 ⇒ React 报
 * "Function components cannot be given refs"、工具提示拿不到锚点。
 * **这一条不钉住，将来有人把它改回普通函数组件也不会红。**
 */
import { createRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import FloatPill from './FloatPill'

const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnv.IS_REACT_ACT_ENVIRONMENT = true

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
})

function mount(node: React.ReactNode) {
  act(() => root.render(node))
}

describe('FloatPill DOM 契约', () => {
  it('渲染**原生 button**（不是 div/a），类名以 `float-pill` 起头', () => {
    mount(<FloatPill>确定</FloatPill>)
    const el = host.firstElementChild!
    expect(el.tagName).toBe('BUTTON')
    expect((el as HTMLElement).className).toContain('float-pill')
    // `type=button`：否则落在表单里会变成提交按钮（本仓多处把它放在表单布局里）
    expect((el as HTMLButtonElement).type).toBe('button')
  })

  it('★ `forwardRef`：ref 指到那个真按钮上（Radix Tooltip/Popover 的锚点）', () => {
    const ref = createRef<HTMLButtonElement>()
    mount(<FloatPill ref={ref}>确定</FloatPill>)
    expect(ref.current).not.toBeNull()
    expect(ref.current!.tagName).toBe('BUTTON')
    expect(ref.current).toBe(host.firstElementChild)
  })

  it('尺寸 / 形态 / 危险 / 激活各自加上对应的类', () => {
    mount(<FloatPill size="md" shape="icon" danger active>×</FloatPill>)
    const cls = (host.firstElementChild as HTMLElement).className
    for (const c of ['float-pill--md', 'float-pill--icon', 'float-pill--danger', 'on']) {
      expect(cls, `缺 ${c}`).toContain(c)
    }
  })

  it('其余属性原样透传（title / disabled / aria-* / data-*）', () => {
    mount(
      <FloatPill title="提示" disabled aria-label="标签" data-testid="fp">
        确定
      </FloatPill>,
    )
    const el = host.firstElementChild as HTMLButtonElement
    expect(el.title).toBe('提示')
    expect(el.disabled).toBe(true)
    expect(el.getAttribute('aria-label')).toBe('标签')
    expect(el.getAttribute('data-testid')).toBe('fp')
  })
})
