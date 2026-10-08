// @vitest-environment jsdom
/**
 * 左栏在**单推模式**下的收起、拉手与**新入口**（需求 6 `devlog/429`；入口改版 `devlog/450`）。
 *
 * 用户口径：「左栏整个收起，给一个**常态隐藏的拉手**支持展开收起，**v 列表不变化**」
 * ＋ 2026-10-08 的新口径：**进单推 = 把 V 拖到首位 + 3 秒内在那一条上连点 10 次**，
 * 拉手**在单推模式下不显示**（需求 1.1）。
 *
 * 判据：
 * ① 正常模式：拉手在（常驻功能）、点它收起/展开并落偏好；
 * ② 进单推：整栏 `data-collapsed="1"`、**拉手不渲染**、偏好不动；
 * ③ 退出单推：拉手回来、按用户偏好展开、**列表内容一个字没变**；
 * ④ 连点手势：首位 3 秒内 10 次才进；非首位不进；超窗不进。
 *
 * ⚠️ `listVtubers` 被替成两个 V 的假数据 —— 本文件判的是"栏怎么收"与"手势怎么算"，不是取数。
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
import { enterSolo, exitSolo, soloState } from '../utils/soloMode'
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

  it('★ 进单推 ⇒ 整栏 `data-collapsed="1"` 且**拉手不渲染**（需求 1.1），偏好不动（退出回原样）', async () => {
    enterSolo(7, '/vtubers/7')
    await render()
    expect(shell().dataset.collapsed, '单推强制收起').toBe('1')
    expect(handle(), '⚠️ 单推模式下不显示提手（用户 2026-10-08 口径：需求 1.1）').toBeNull()
    expect(railCollapsed(), '⚠️ 单推不改用户偏好 —— 退出才能"回到进入前的状态"').toBe(false)
  })

  it('★ 退出单推 ⇒ 拉手回来、整栏按**用户自己的偏好**展开（这里没手动收起过）', async () => {
    enterSolo(7, '/vtubers/7')
    await render()
    const before = names()
    expect(before.join('|'), '正对照：列表里确实有两个 V').toContain('柚子')
    await act(async () => { exitSolo(); await Promise.resolve() })
    expect(shell().dataset.collapsed).toBeUndefined()
    expect(handle(), '拉手是常驻功能 ⇒ 退出后回来').not.toBeNull()
    expect(handle()!.getAttribute('aria-label')).toBe('收起 V 列表')
    expect(names(), '⚠️ 用户口径：v 列表不变化').toEqual(before)
  })
})

// ── 新入口：首位条目上 3 秒内连点 10 次（需求 1，`devlog/450`）─────────────
describe('左栏：连点进单推的手势', () => {
  const items = () => [...host.querySelectorAll<HTMLElement>('.vtuber-item')]
  const clickItem = async (el: HTMLElement) => {
    await act(async () => { el.click(); await Promise.resolve() })
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('★ 首位条目 3 秒内点 10 次 ⇒ 进单推（对象是那一条；前 9 次不进）', async () => {
    await render()
    const first = items()[0]
    for (let i = 0; i < 9; i++) await clickItem(first)
    expect(soloState(), '★ 前 9 次一次都不许进（不是"点够几次就进"）').toBeNull()
    await clickItem(first)
    expect(soloState()).toEqual({ id: V7.id, prevRoute: '/vtubers/7' })
  })

  it('★ 非首位条目点 10 次 ⇒ **不进**（口径是"先拖到首位"）+ 正对照', async () => {
    await render()
    const second = items()[1]
    for (let i = 0; i < 10; i++) await clickItem(second)
    expect(soloState(), '第二条上连点不该进单推').toBeNull()
    // 正对照：同样的连点打在**首位**就进（否则上面那句可能只是"手势整个没接线"）
    const first = items()[0]
    for (let i = 0; i < 10; i++) await clickItem(first)
    expect(soloState()).not.toBeNull()
  })

  it('★ 10 次里超过 3 秒窗口 ⇒ 不进（窗口量的是**距第一次**）', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await render()
    const first = items()[0]
    for (let i = 0; i < 10; i++) {
      now += 400                     // 10 × 400ms = 4s > 3s
      await clickItem(first)
    }
    expect(soloState(), '超窗 ⇒ 每次点击都重新数，永远到不了 10').toBeNull()
  })

  it('★ 进单推后那一条的连点计数**清零**（命中即重置，不会"再点一次又进"）', async () => {
    await render()
    const first = items()[0]
    for (let i = 0; i < 10; i++) await clickItem(first)
    expect(soloState()).not.toBeNull()
    await act(async () => { exitSolo(); await Promise.resolve() })
    // 退出后只点 9 次 ⇒ 不该进（若命中时没清零，这里第 1 次就会凑成第 11 次）
    for (let i = 0; i < 9; i++) await clickItem(first)
    expect(soloState()).toBeNull()
  })
})
