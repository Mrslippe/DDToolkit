// @vitest-environment jsdom
/**
 * 单推模式的**入口/出口**（需求 6，`devlog/429`）：最左侧工具栏底部、齿轮上方那枚按钮。
 *
 * 三条判据：
 * ① 没选中 V（路由是 `/`）⇒ 按钮**禁用**（单推没有对象，点了也没意义）；
 * ② 点一次进入 ⇒ 记下"这个 V"与"当前路由"；再点一次退出；
 * ③ ★**退出要回到进入前那条路由** —— 进单推后如果位置变了（比如在单推里又点了别的帖子链接），
 *    退出时仍然回"进去之前"那儿，这就是需求里的"退出回到进入前的状态"。
 *
 * ⚠️ `AppSettingsDialog` 被替成空组件：它自己会去取设置，与本文件要判的东西无关。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./AppSettingsDialog', () => ({ default: () => null }))

import IconRail from './IconRail'
import { TooltipProvider } from '@/components/ui/tooltip'
import { enterSolo, exitSolo, soloState } from '../utils/soloMode'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

/** 当前路由的探针（断言"退出回到哪儿"） */
function Probe() {
  const loc = useLocation()
  return <span data-testid="loc">{loc.pathname}</span>
}

const toggle = () => host.querySelector<HTMLButtonElement>('[data-testid="solo-toggle"]')!
const posts = () => host.querySelector<HTMLButtonElement>('[aria-label="帖子浏览"]')!
const loc = () => host.querySelector('[data-testid="loc"]')!.textContent

async function render(route: string) {
  await act(async () => {
    root.render(
      // ⚠️ `TooltipProvider` 在真应用里由 `main.tsx` 提供（radix 的 Tooltip 需要祖先 provider）
      <TooltipProvider>
        <MemoryRouter initialEntries={[route]}>
          <IconRail />
          <Probe />
        </MemoryRouter>
      </TooltipProvider>,
    )
    await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
  exitSolo()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  localStorage.clear()
  exitSolo()
})

describe('工具栏：单推的入口与出口', () => {
  it('没选中 V ⇒ 禁用（单推总得有个对象）', async () => {
    await render('/')
    expect(toggle().disabled).toBe(true)
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('★ 进入：记下这个 V 与当前路由；按钮转成"已按下"', async () => {
    await render('/vtubers/7')
    expect(toggle().disabled).toBe(false)
    await act(async () => { toggle().click(); await Promise.resolve() })
    expect(soloState()).toEqual({ id: 7, prevRoute: '/vtubers/7' })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(toggle().getAttribute('aria-label'), '同一个钮，出去时改叫"退出单推"').toBe('退出单推')
    expect(loc(), '进入本身不换位置').toBe('/vtubers/7')
  })

  it('★ **退出回到进入前那条路由**（即便单推期间位置又变过）', async () => {
    await render('/vtubers/7')
    await act(async () => { toggle().click(); await Promise.resolve() })
    // 单推期间位置变了（真实里可能是点了帖子里的链接）
    await act(async () => { posts().click(); await Promise.resolve() })
    expect(loc(), '单推时"帖子浏览"直接去单推那个 V（`/` 在单推下没有内容）').toBe('/vtubers/7')
    await act(async () => { toggle().click(); await Promise.resolve() })
    expect(soloState()).toBeNull()
    expect(loc(), '回到进入前那条路由').toBe('/vtubers/7')
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('非单推时"帖子浏览"照旧去 `/`（别把新的兜底逻辑漏到平时）', async () => {
    await render('/vtubers/5')
    await act(async () => { posts().click(); await Promise.resolve() })
    expect(loc()).toBe('/')
  })

  it('已经在单推里（持久化的）⇒ 冷启动时按钮就是选中态', async () => {
    enterSolo(3, '/vtubers/3')
    await render('/')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(toggle().disabled, '单推中不许因为"没路由"而禁用（否则退不出去）').toBe(false)
  })
})
