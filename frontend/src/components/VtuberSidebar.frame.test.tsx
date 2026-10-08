// @vitest-environment jsdom
/**
 * 左栏**结构契约**：`.sidebar-shell` 只有一个，且滚动体是它的**直接子元素**。
 *
 * ## 为什么要专门为"结构"写一条（2026-10-08 用户实测，`devlog/448`）
 *
 * 症状：左栏最下面那条 V 被窗口裁掉一半、**滚轮推不动、滚动条也不出现**。
 * 根因不是滚动条组件（`OverlayScroll` 一切正常），而是 **DOM 多套了一层同名的外壳**：
 *
 * ```
 * .sidebar-shell            ← SidebarFrame 的（flex item of .app-body，高度被撑满 ✓）
 *   └ .sidebar-shell        ← VtuberSidebarInner 的（多余！）
 *       └ .os-root.sidebar-list > .os-scroll   ← 滚动体
 * ```
 *
 * 内层那层**继承了 `.sidebar-shell` 自己的 `flex-shrink: 0`**（那条本意是"横向别被压窄"），
 * 于是它在纵向**不收缩、被内容撑开** ⇒ `.os-scroll` 的 `scrollHeight` 恒等于 `clientHeight`
 * ⇒ 「没有溢出」⇒ 滚轮无效 + 拇指 `display:none` + 条目溢出到窗外被 `.app-shell` 裁掉。
 *
 * ⚠️ 这类 bug 的**判据没法靠 jsdom 量**（没有布局），但它有一个**纯结构**的等价物：
 * 「外壳与滚动体之间不许夹任何元素，外壳也不许有两个」。这一条就是它。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listVtubers = vi.fn()
// ⚠️ "真模块 + 覆盖"（同 `VtuberSidebar.solo.test.tsx`）：只写两个函数会让别处的
//    `api.capabilities` 变成 undefined ⇒ 一串 unhandled error。
vi.mock('../api/api', async (orig) => {
  const real = await orig<typeof import('../api/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      listVtubers: (...a: unknown[]) => listVtubers(...a),
      reorderVtubers: () => Promise.resolve(),
      capabilities: () => Promise.resolve(null),
    },
  }
})

import VtuberSidebar from './VtuberSidebar'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const V7 = { id: 7, name: '柚子', accounts: [], sign_override: null, sign_source_account_id: null }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  listVtubers.mockResolvedValue([V7])
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

async function mount() {
  await act(async () => {
    root.render(<MemoryRouter><VtuberSidebar /></MemoryRouter>)
  })
  await act(async () => { await Promise.resolve() })
}

describe('左栏结构：外壳只有一个、滚动体是它的直接子元素', () => {
  it('★ `.sidebar-shell` 全树只有一个（嵌套同名外壳会让列表永远不滚，devlog/448）', async () => {
    await mount()
    expect(host.querySelectorAll('.sidebar-shell').length,
      '多一层同名的外壳 ⇒ 内层继承 flex-shrink:0 ⇒ 高度被内容撑开 ⇒ 列表不再滚动').toBe(1)
    // 正对照：外壳与列表**都真的在**（否则"只有一个"可能只是"整个组件没渲染"）
    expect(host.querySelector('.sidebar-shell')).toBeTruthy()
    expect(host.querySelector('.os-root.sidebar-list')).toBeTruthy()
  })

  it('★ 滚动体（`.os-root.sidebar-list`）是外壳的**直接子元素** —— 中间夹一层就断了 flex 高度链', async () => {
    await mount()
    const shell = host.querySelector('.sidebar-shell')!
    const list = shell.querySelector(':scope > .os-root.sidebar-list')
    expect(list, '中间夹了别的元素 ⇒ 那一层高度 auto ⇒ 列表拿到的高度 = 内容高度').toBeTruthy()
    // 滚动体自己那一层再往下是 `.os-scroll`（OverlayScroll 内部，见 `.os-scroll{flex:1;min-height:0}`）
    expect(list!.querySelector(':scope > .os-scroll')).toBeTruthy()
  })

  it('加载中 / 加载失败两条分支也不许自带外壳（三处 return 曾经各带一层）', async () => {
    // 加载中：把列表请求挂住不 resolve
    listVtubers.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      root.render(<MemoryRouter><VtuberSidebar /></MemoryRouter>)
    })
    expect(host.querySelectorAll('.sidebar-shell').length).toBe(1)
    expect(host.querySelector('.sidebar-skeleton, .os-root.sidebar-list')).toBeTruthy()

    // 加载失败
    listVtubers.mockRejectedValueOnce(new Error('boom'))
    await act(async () => { root.render(<MemoryRouter><VtuberSidebar /></MemoryRouter>) })
    await act(async () => { await Promise.resolve() })
    expect(host.querySelectorAll('.sidebar-shell').length).toBe(1)
  })
})
