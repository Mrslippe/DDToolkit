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

describe('左栏：单推时的收起与拉手', () => {
  it('不在单推 ⇒ 不收起、也没有拉手', async () => {
    await render()
    expect(shell().dataset.collapsed).toBeUndefined()
    expect(handle(), '平时这一栏常驻，不需要拉手').toBeNull()
  })

  it('★ 进单推 ⇒ 整栏 `data-collapsed="1"` + 拉手出现（文案是"展开"）', async () => {
    enterSolo(7, '/vtubers/7')
    await render()
    expect(shell().dataset.collapsed, '宽度由 CSS 收成 0').toBe('1')
    expect(handle()!.getAttribute('aria-label')).toBe('展开 V 列表')
    expect(handle()!.getAttribute('aria-expanded')).toBe('false')
  })

  it('★ 拉手只是**临时展开**：收起标记消失、文案翻转，**列表内容一个字没变**', async () => {
    enterSolo(7, '/vtubers/7')
    await render()
    const before = names()
    expect(before.join('|'), '正对照：列表里确实有两个 V').toContain('柚子')
    await act(async () => { handle()!.click(); await Promise.resolve() })
    expect(shell().dataset.collapsed, '展开').toBeUndefined()
    expect(handle()!.getAttribute('aria-label')).toBe('收起 V 列表')
    expect(names(), '⚠️ 用户口径：v 列表不变化').toEqual(before)
    // 再点一次收回去
    await act(async () => { handle()!.click(); await Promise.resolve() })
    expect(shell().dataset.collapsed).toBe('1')
  })

  it('★ 退出单推 ⇒ 收起标记与拉手一起消失（状态不留痕）', async () => {
    enterSolo(7, '/vtubers/7')
    await render()
    expect(handle()).not.toBeNull()
    await act(async () => { exitSolo(); await Promise.resolve() })
    expect(shell().dataset.collapsed).toBeUndefined()
    expect(handle()).toBeNull()
  })
})
