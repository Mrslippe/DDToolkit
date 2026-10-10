// @vitest-environment jsdom
/**
 * 左栏**企划徽章**的接线判据（需求 6，B3，`devlog/457`）。
 *
 * 纯函数那半边（slug / 标签截断 / 没图标退文字）在 `utils/groupBadge.test.ts`，
 * 这里钉的是**接线**：`/vtuber/list` 里的 `group_name` 真的走到了左栏那一行、渲染成了什么、
 * 以及"没有企划就不摆空壳"。⚠️ 只测纯函数的话，"组件压根没读这个字段"照样绿。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listVtubers = vi.fn()
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

const base = { accounts: [], sign_override: null, sign_source_account_id: null }
const WITH_GROUP = { ...base, id: 7, name: '泠鸢', group_name: 'VirtuaReal', group_uuid: 'g-1' }
const NO_GROUP = { ...base, id: 8, name: '散人', group_name: null, group_uuid: null }

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
  vi.clearAllMocks()
})

async function mount(vtubers: unknown[]) {
  listVtubers.mockResolvedValue(vtubers)
  await act(async () => {
    root.render(<MemoryRouter><VtuberSidebar /></MemoryRouter>)
  })
  await act(async () => { await Promise.resolve() })
}

describe('左栏企划徽章', () => {
  it('★ 有企划：渲染文字胶囊（素材未制作时的默认形态），带 `data-group` 与全名 title', async () => {
    await mount([WITH_GROUP])
    const badge = host.querySelector<HTMLElement>('.vtuber-item .vtuber-emblem')
    expect(badge, '`group_name` 没走到左栏（组件没读这个字段？）').toBeTruthy()
    expect(badge!.getAttribute('data-group')).toBe('VirtuaReal')
    expect(badge!.getAttribute('title')).toContain('VirtuaReal')
    // 没图标素材 ⇒ 文字胶囊（不是空的 <img>）
    expect(badge!.querySelector('.vtuber-emblem-text')?.textContent).toBe('Virtua…')
    expect(badge!.querySelector('img')).toBeNull()
  })

  it('★ 没有企划：**什么都不渲染**（不摆空壳，否则名字与右缘之间多一截空白）', async () => {
    await mount([NO_GROUP])
    expect(host.querySelector('.vtuber-item')).toBeTruthy()          // 正对照：行本身在
    expect(host.querySelector('.vtuber-emblem')).toBeNull()
  })

  it('两种混着来也只给有企划的那一条加徽章', async () => {
    await mount([WITH_GROUP, NO_GROUP])
    const badges = host.querySelectorAll('.vtuber-item .vtuber-emblem')
    expect(badges.length).toBe(1)
    expect(badges[0].getAttribute('data-group')).toBe('VirtuaReal')
  })

  it('企划名是空白串时也按"没有企划"处理（库里被手工改坏的那种值）', async () => {
    await mount([{ ...base, id: 9, name: '空值', group_name: '   ', group_uuid: null }])
    expect(host.querySelector('.vtuber-emblem')).toBeNull()
  })
})
