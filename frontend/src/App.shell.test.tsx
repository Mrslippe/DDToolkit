// @vitest-environment jsdom
/**
 * V1 壳层分叉（2026-10-18 用户口径）：
 *
 * > 「帖子浏览界面和数据分析工作台界面不共用左栏，左栏是帖子浏览界面的专有元素」
 *
 * 判据三条：
 * ① `/workbench` 下**不渲染**主播左栏；
 * ② 帖子浏览（`/` 与 `/vtubers/:id`）下**仍然渲染**；
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
  it('工作台路由：没有主播栏，但有工具栏与工作台页', async () => {
    await mount('/workbench')
    expect(has('sidebar')).toBe(false)
    expect(has('rail')).toBe(true)
    expect(has('workbench')).toBe(true)
  })

  it('帖子浏览（根路由）：主播栏在', async () => {
    await mount('/')
    expect(has('sidebar')).toBe(true)
    expect(has('rail')).toBe(true)
  })

  it('帖子浏览（某个 V）：主播栏仍在', async () => {
    await mount('/vtubers/16')
    expect(has('sidebar')).toBe(true)
    expect(has('posts')).toBe(true)
  })

  it('工作台下面再深的路径也算工作台（前缀判定）', async () => {
    await mount('/workbench/anything')
    expect(has('sidebar')).toBe(false)
  })
})
