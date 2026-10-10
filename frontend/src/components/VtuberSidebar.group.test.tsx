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

  it('手填的 `faction` 优先于自动检测的 `group_name`（用户自己写的那句最权威）', async () => {
    await mount([{ ...base, id: 10, name: '改过的', faction: '我填的', group_name: '自动的' }])
    const badge = host.querySelector<HTMLElement>('.vtuber-emblem')!
    expect(badge.getAttribute('data-group')).toBe('我填的')
  })
})

/**
 * ⚠️ **用户 2026-10-10 报的那个 bug**：筛「四禧丸子」只出恬豆发芽了一个人，
 * 而另外三人的徽章上明明写着四禧丸子。
 *
 * 根因：筛选的**选项与匹配**读 `faction`（老的手填字段），而**徽章**读 `group_name`
 * （B3 起自动填）—— 真机库里恬豆两者都有、另外三人只有 `group_name`。
 * 现在三处都走 `vtuberGroup()`（手填优先 → 否则自动），这一组就是它的回归判据。
 */
describe('左栏企划筛选（与徽章同一口径）', () => {
  const four = [
    { ...base, id: 18, name: '恬豆发芽了', faction: '四禧丸子', group_name: '四禧丸子' },
    { ...base, id: 23, name: '又一充电中', faction: null, group_name: '四禧丸子' },
    { ...base, id: 24, name: '梨安不迷路', faction: null, group_name: '四禧丸子' },
    { ...base, id: 25, name: '沐霂是MUMU呀', faction: null, group_name: '四禧丸子' },
    { ...base, id: 26, name: '露早', faction: null, group_name: 'EOE组合' },
  ]

  async function openFilter() {
    const btn = host.querySelector<HTMLButtonElement>('.list-filter-btn')
    expect(btn, '筛选入口不在（类名变了？）').toBeTruthy()
    await act(async () => { btn!.click() })
  }

  const chip = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.filter-chip')]
      .find((c) => c.textContent?.trim() === label)

  it('★ 筛「四禧丸子」要出**四个人**（一人手填、三人靠自动企划）', async () => {
    await mount(four)
    expect(host.querySelectorAll('.vtuber-item').length).toBe(5)   // 正对照：五条都在
    await openFilter()
    const c = chip('四禧丸子')
    expect(c, '企划选项里没有「四禧丸子」——选项和匹配必须与徽章同口径').toBeTruthy()
    await act(async () => { c!.click() })
    const names = [...host.querySelectorAll('.vtuber-name')].map((n) => n.textContent)
    expect(names.slice().sort())
      .toEqual(['恬豆发芽了', '又一充电中', '梨安不迷路', '沐霂是MUMU呀'].sort())
    expect(names).not.toContain('露早')
  })

  it('★ 全员都只有自动企划（`faction` 全空）时，选项里照样要出现那个企划', async () => {
    await mount(four.map((v) => ({ ...v, faction: null })))
    await openFilter()
    expect(chip('四禧丸子'), '选项只从 faction 提取 ⇒ 只有 group_name 的企划根本筛不了').toBeTruthy()
    expect(chip('EOE组合')).toBeTruthy()
  })
})
