// @vitest-environment jsdom
/**
 * V1 壳层分叉（2026-10-18 用户口径）：
 *
 * > 「帖子浏览界面和数据分析工作台界面不共用左栏，左栏是帖子浏览界面的专有元素」
 *
 * 判据三条（2026-10-18 第二版：左栏改成**挂载但隐藏**，不再卸载）：
 * ① `/workbench` 下左栏**仍然挂载**（卸载会让切回帖子浏览时先空一片、再等列表拉回来
 *    —— 用户实测约 0.8s 的空白），但 `.app-body` 带 `data-bare="1"`，由 CSS 隐藏；
 * ② 帖子浏览（`/` 与 `/vtubers/:id`）下没有 `data-bare`，左栏可见；
 * ③ 工具栏（`IconRail`）在两种路由下**都在** —— 它是全站导航，不属于任何一个界面。
 *
 * ⚠️ ③ 是这条纪律的另一半：只把左栏拿掉、不要把导航也一起拿掉。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./components/TopBar', () => ({ default: () => <div data-testid="topbar" /> }))
vi.mock('./components/IconRail', () => ({ default: () => <div data-testid="rail" /> }))
vi.mock('./components/VtuberSidebar', () => ({ default: () => <div data-testid="sidebar" /> }))
vi.mock('./components/LegalNotice', () => ({ default: () => null }))
vi.mock('./pages/EmptyState', () => ({ default: () => <div data-testid="empty" /> }))
vi.mock('./pages/PostsPage', () => ({ default: () => <div data-testid="posts" /> }))
vi.mock('./pages/WorkbenchPage', () => ({ default: () => <div data-testid="workbench" /> }))
vi.mock('./hooks/useIsMaximized', () => ({ useIsMaximized: () => false }))
vi.mock('./utils/emojiSize', () => ({ useEmojiBigSize: () => {} }))
vi.mock('./utils/groupBadgePref', () => ({ useGroupBadge: () => {} }))
vi.mock('./utils/soloMode', () => ({ useSolo: () => null }))
vi.mock('./utils/soloPeek', () => ({
  useSoloIdle: () => false,
  useSoloPeek: () => 'center',
}))
vi.mock('./utils/shellState', () => ({
  clearShellState: () => {},
  loadShellState: () => null,
  shouldRestoreFromTray: () => false,
}))
vi.mock('./api/api', () => ({ api: { getAgreement: async () => ({ needed: false }) } }))

import App from './App'

let host: HTMLDivElement
let root: Root

async function mount(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )
  })
  // 让 App 里那次 `getAgreement()` 的 promise 落地
  await act(async () => { await Promise.resolve() })
}

const has = (id: string) => document.querySelector(`[data-testid="${id}"]`) !== null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('壳层 · 工作台不共用主播左栏', () => {
  it('工作台路由：左栏挂载但被隐藏（不是卸载），工具栏与工作台页都在', async () => {
    await mount('/workbench')
    // 仍然挂载 —— 这样切回帖子浏览是"立刻有内容"，不是"空 0.8s 再渐显"
    expect(has('sidebar')).toBe(true)
    expect(document.querySelector('.app-body')?.getAttribute('data-bare')).toBe('1')
    expect(has('rail')).toBe(true)
    expect(has('workbench')).toBe(true)
  })

  it('帖子浏览（根路由）：主播栏可见', async () => {
    await mount('/')
    expect(has('sidebar')).toBe(true)
    expect(document.querySelector('.app-body')?.getAttribute('data-bare')).toBeNull()
    expect(has('rail')).toBe(true)
  })

  it('帖子浏览（某个 V）：主播栏仍在', async () => {
    await mount('/vtubers/16')
    expect(has('sidebar')).toBe(true)
    expect(document.querySelector('.app-body')?.getAttribute('data-bare')).toBeNull()
    expect(has('posts')).toBe(true)
  })

  it('工作台下面再深的路径也算工作台（前缀判定）', async () => {
    await mount('/workbench/anything')
    expect(document.querySelector('.app-body')?.getAttribute('data-bare')).toBe('1')
  })
})
