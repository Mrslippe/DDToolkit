// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fanCompareMulti = vi.fn()
vi.mock('../../api/api', () => ({
  api: { fanCompareMulti: (...a: unknown[]) => fanCompareMulti(...a) },
  resolveAsset: (p: string) => p,
}))

import ComparePanel from './ComparePanel'

const DATA = {
  window: 75, since: '2026-01-01', until: '2026-10-26',
  vtubers: [
    { name: '弥月Mizuki', short: '弥月', pool: 1880, sessions: 75, tiers: { 核心: 100 } },
    { name: '星瞳_Official', short: '星瞳', pool: 5577, sessions: 75, tiers: { 核心: 120 } },
  ],
  matrix: [[null, { pair: 0, jaccard: 0.0154, lift: 0.075, shared: 116 }],
           [{ pair: 0, jaccard: 0.0154, lift: 0.075, shared: 116 }, null]],
  pairs: [{
    a: '弥月', b: '星瞳', a_name: '弥月Mizuki', b_name: '星瞳_Official',
    size_a: 1880, size_b: 5577, intersection: 116, jaccard: 0.0154, lift: 0.075,
    p_value: 1e-8, p_adjusted: 1e-8, p_value_lower: 1.0,
    is_enriched: true, is_depleted: false,
    tier_table: { 核心: { 核心: 10 } },
    tier_moves: { '弥月核心→星瞳外层': 41 },
    reading: '两边受众高度分化',
  }],
  notes: [],
}

let host: HTMLDivElement
let root: Root

async function mount(ui: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => { fanCompareMulti.mockReset().mockResolvedValue(DATA) })
afterEach(() => { act(() => root?.unmount()); host?.remove() })

describe('ComparePanel（多主播对比）', () => {
  it('★ 渲染矩阵与配对详情，且请求带上当前主播', async () => {
    await mount(
      <ComparePanel current="弥月Mizuki" options={[{ name: '星瞳_Official', short: '星瞳' }]}
                    window={75} since="2026-01-01" until="2026-10-26" />,
    )
    // 先点「+ 星瞳」把第二个主播加进来（对比至少需要 2 个）
    const add = Array.from(document.querySelectorAll('.wb-chip-add'))
      .find((el) => el.textContent?.includes('星瞳')) as HTMLButtonElement
    await act(async () => { add.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(document.querySelector('[data-testid="compare-matrix"]')).toBeTruthy()
    const pair = document.querySelector('[data-testid="compare-pair"]') as HTMLElement
    expect(pair.textContent).toContain('共享 116')
    expect(pair.textContent).toContain('弥月核心→星瞳外层')
    const lastCall = fanCompareMulti.mock.calls[fanCompareMulti.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(['弥月Mizuki', '星瞳_Official'])
  })

  it('帖子评论模式给出明确占位（不是空白）', async () => {
    await mount(<ComparePanel current="弥月Mizuki" options={[]} window={75} since="" until="" />)
    await act(async () => {
      (document.querySelector('[data-testid="compare-mode-comment"]') as HTMLButtonElement).click()
    })
    expect(document.querySelector('[data-testid="compare-comment-todo"]')!.textContent).toContain('下一步')
  })
})
