// @vitest-environment jsdom
/**
 * 单推的**出口**（需求 6 `devlog/429`；出入口改版 `devlog/450`）：最左侧工具栏底部、齿轮上方那枚按钮。
 *
 * 2026-10-08 用户口径：**进入**改成"拖到左栏首位 + 3 秒内连点 10 次"（判据在
 * `VtuberSidebar.solo.test.tsx`），这枚按钮**只在单推模式下显示、只负责退出**。
 *
 * 三条判据：
 * ① 正常模式（不管路由上有没有 V）⇒ 这个按钮**根本不渲染**；
 * ② 单推中 ⇒ 在、是选中态、点一次退出；
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

const maybeToggle = () => host.querySelector<HTMLButtonElement>('[data-testid="solo-toggle"]')
const toggle = () => maybeToggle()!
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

describe('工具栏：单推的出口（入口已改成左栏连点手势）', () => {
  it('★ 正常模式**不渲染**这枚按钮（入口不在这里了）—— 正对照：帖子浏览钮还在', async () => {
    await render('/vtubers/7')
    expect(maybeToggle(), '需求 1：正常模式下按钮隐藏').toBeNull()
    expect(posts(), '正对照：工具栏本身渲染了，不是"整个组件没出来"').toBeTruthy()
  })

  it('★ 正常模式带 V 的路由也一样不渲染（别把"没选中 V"当成隐藏条件）', async () => {
    await render('/')
    expect(maybeToggle()).toBeNull()
  })

  it('★ 单推中 ⇒ 按钮在、是选中态、文案是"退出单推"', async () => {
    enterSolo(7, '/vtubers/7')
    await render('/vtubers/9')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(toggle().getAttribute('aria-label')).toBe('退出单推')
    expect(toggle().disabled, '单推中不许因为"路由上没有 V"而禁用（否则退不出去）').toBe(false)
  })

  it('★ **退出回到进入前那条路由**（即便单推期间位置又变过）', async () => {
    enterSolo(7, '/vtubers/7')
    await render('/vtubers/7')
    // 单推期间位置变了（真实里可能是点了帖子里的链接）
    await act(async () => { posts().click(); await Promise.resolve() })
    expect(loc(), '单推时"帖子浏览"直接去单推那个 V（`/` 在单推下没有内容）').toBe('/vtubers/7')
    await act(async () => { toggle().click(); await Promise.resolve() })
    expect(soloState()).toBeNull()
    expect(loc(), '回到进入前那条路由').toBe('/vtubers/7')
  })

  it('非单推时"帖子浏览"照旧去 `/`（别把新的兜底逻辑漏到平时）', async () => {
    await render('/vtubers/5')
    await act(async () => { posts().click(); await Promise.resolve() })
    expect(loc()).toBe('/')
  })
})
