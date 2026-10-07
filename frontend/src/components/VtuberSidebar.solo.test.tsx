// @vitest-environment jsdom
/**
 * 左栏在**单推模式**下的收起与拉手（需求 6，`devlog/429`）。
 *
 * 用户口径：「左栏整个收起，给一个**常态隐藏的拉手**支持展开收起，**v 列表不变化**」。
 * 三条判据：
 * ① 不在单推 ⇒ **没有拉手**（这一栏本来就常驻，不需要它）；
 * ② 进单推 ⇒ 整栏 `data-collapsed="1"`（宽度由 CSS 收成 0）+ 拉手在、`aria-label` 是"展开"；
 * ③ 点拉手 ⇒ **只是临时展开**（`data-collapsed` 消失、`aria-label` 变"收起"），
 *    **列表内容一个字没变**（用户口径），退出单推后又没有拉手了。
 *
 * ⚠️ `listVtubers` 被替成两个 V 的假数据 —— 本文件判的是"栏怎么收"，不是取数。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listVtubers = vi.fn()
// ⚠️ 用"真模块 + 覆盖"的写法（`VideoPlayer.keys.test.tsx` 那套）：只写两个函数的话，
//    组件树里别处（如 `ProxyImage`）调的 `api.capabilities` 会变成 undefined ⇒
//    一串 **unhandled error**，vitest 会警告"可能造成假阳性"。
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
import { enterSolo, exitSolo } from '../utils/soloMode'
import { railCollapsed, setRailCollapsed } from '../utils/railCollapsed'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const V7 = { id: 7, name: '柚子', accounts: [], sign_override: null, sign_source_account_id: null }
const V9 = { id: 9, name: '梨安', accounts: [], sign_override: null, sign_source_account_id: null }

let host: HTMLDivElement
let root: Root

const shell = () => host.querySelector<HTMLElement>('.sidebar-shell')!
const handle = () => host.querySelector<HTMLButtonElement>('[data-testid="solo-rail-handle"]')
const names = () => [...host.querySelectorAll('.vtuber-item')].map((el) => el.textContent)

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/vtubers/7']}>
        <VtuberSidebar />
      </MemoryRouter>,
    )
    await Promise.resolve()
  })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  localStorage.clear()
  exitSolo()
  setRailCollapsed(false)
  listVtubers.mockReset().mockResolvedValue([V7, V9])
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

describe('左栏：收起与拉手（常驻功能）', () => {
  it('★ 拉手**常驻**（不在单推里也在，用户口径"收起展开是常驻功能"），但不收起时不显示为收起态', async () => {
    await render()
    expect(handle(), '常驻功能 ⇒ 平时也有拉手').not.toBeNull()
    expect(handle()!.getAttribute('aria-label')).toBe('收起 V 列表')
    expect(shell().dataset.collapsed).toBeUndefined()
  })

  it('★ 不在单推里点拉手 ⇒ 收起这一栏，且**记进偏好**（跨启动还在）', async () => {
    await render()
    await act(async () => { handle()!.click(); await Promise.resolve() })
    expect(shell().dataset.collapsed).toBe('1')
    expect(railCollapsed(), '偏好要落盘').toBe(true)
    await act(async () => { handle()!.click(); await Promise.resolve() })
    expect(shell().dataset.collapsed).toBeUndefined()
    expect(railCollapsed()).toBe(false)
  })

  it('★ 进单推 ⇒ 整栏 `data-collapsed="1"` + 拉手文案是"展开"，但**偏好不动**（退出回原样）', async () => {
    enterSolo(7, '/vtubers/7')
    await render()
    expect(shell().dataset.collapsed, '单推强制收起').toBe('1')
    expect(handle()!.getAttribute('aria-label')).toBe('展开 V 列表')
    expect(railCollapsed(), '⚠️ 单推不改用户偏好 —— 退出才能"回到进入前的状态"').toBe(false)
  })

  it('★ 单推里点拉手只是**临时展开**：收起标记消失、**列表内容一个字没变**，退出后回到用户偏好', async () => {
    enterSolo(7, '/vtubers/7')
    await render()
    const before = names()
    expect(before.join('|'), '正对照：列表里确实有两个 V').toContain('柚子')
    await act(async () => { handle()!.click(); await Promise.resolve() })
    expect(shell().dataset.collapsed, '临时展开').toBeUndefined()
    expect(handle()!.getAttribute('aria-label')).toBe('收起 V 列表')
    expect(names(), '⚠️ 用户口径：v 列表不变化').toEqual(before)
    await act(async () => { handle()!.click(); await Promise.resolve() })
    expect(shell().dataset.collapsed).toBe('1')
    // 退出单推 ⇒ 回到"用户自己的偏好"（这里没手动收起过 ⇒ 展开）
    await act(async () => { exitSolo(); await Promise.resolve() })
    expect(shell().dataset.collapsed).toBeUndefined()
    expect(handle(), '拉手是常驻功能 ⇒ 还在').not.toBeNull()
  })
})
