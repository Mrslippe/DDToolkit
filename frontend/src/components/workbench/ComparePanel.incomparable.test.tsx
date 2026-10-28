// @vitest-environment jsdom
/**
 * 对比页「区间不同 ⇒ 相对量不可比」（2026-10-28 用户第 3 条 + 决策 b）。
 *
 * 对比的基本单位是**各 V 自己的结果包**，所以两份包可能来自不同区间。
 * 此时：交集人数**仍然可信**（名单求交与区间无关），但 Jaccard / lift / 富集
 * **不可比**（分母不同）—— 必须标灰并写明，不能让它看起来像正常读数。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/api', () => ({
  api: {
    fanCompareMulti: () => Promise.resolve({
      basis: 'packages',
      window: 75, since: '2026-09-01', until: '2026-10-26',
      ranges_differ: true,
      vtubers: [
        { name: '弥月Mizuki', short: '弥月', pool: 100, sessions: 25,
          tiers: { 核心: 10 },
          package: { since: '2026-09-01', until: '2026-09-30', window: 25,
                     computed_at: '2026-10-28 21:00:00' } },
        { name: '星瞳', short: '星瞳', pool: 90, sessions: 75,
          tiers: { 核心: 9 },
          package: { since: '2026-06-01', until: '2026-08-31', window: 75,
                     computed_at: '2026-10-28 20:00:00' } },
      ],
      matrix: [
        [null, { pair: 0, jaccard: 0.02, lift: 1.4, shared: 12, comparable: false }],
        [{ pair: 0, jaccard: 0.02, lift: 1.4, shared: 12, comparable: false }, null],
      ],
      pairs: [{
        a: '弥月', b: '星瞳', a_name: '弥月Mizuki', b_name: '星瞳',
        size_a: 100, size_b: 90, intersection: 12,
        jaccard: 0.02, lift: 1.4, p_value: 0.01, p_adjusted: 0.02, p_value_lower: 0.9,
        is_enriched: true, is_depleted: false,
        tier_table: {}, tier_moves: { '核心→外层（降）': 3 },
        reading: '弥月 与 星瞳 的名单重叠 12 人',
        ranges_differ: true, comparable: false,
      }],
      notes: ['⚠️ 1 个配对的两份包时间区间/窗口不同 ⇒ 交集人数可信，但 Jaccard / lift / 富集与贫化不可比'],
      missing: [], needs_analysis: [],
    }),
  },
  resolveAsset: (p?: string | null) => p ?? null,
}))

import ComparePanel from './ComparePanel'

let host: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<ComparePanel current="弥月Mizuki"
                             options={[{ name: '星瞳', short: '星瞳' }]}
                             window={75}
                             since="2026-09-01" until="2026-10-26" />)
  })
  // 只选了一个主播时组件会跳过请求 ⇒ 先点「+ 星瞳」把第二个选上
  await act(async () => {
    (host.querySelector('.wb-chip-add') as HTMLButtonElement | null)?.click()
  })
  // 拉数据是 async 的（effect → await → setState）：多冲几轮 microtask 再断言
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    await Promise.resolve(); await Promise.resolve()
  })
}

const q = (sel: string) => host.querySelector(sel)

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('对比页：两包区间不同', () => {
  it('把每个包自己的区间列出来（用户要能看到冲突在哪）', async () => {
    await mount()
    const ranges = q('[data-testid="compare-ranges"]')!
    expect(ranges).toBeTruthy()
    expect(ranges.textContent).toContain('2026-09-01')
    expect(ranges.textContent).toContain('2026-06-01')
    expect(ranges.textContent).toContain('25 场')
    expect(ranges.textContent).toContain('75 场')
  })

  it('相对量标灰 + 一句明确警告；交集人数照常可读', async () => {
    await mount()
    const kpi = q('[data-testid="compare-pair-kpi"]')!
    expect(kpi.textContent).toContain('共享 12 人')
    expect(kpi.querySelector('.wb-incomparable')).toBeTruthy()
    const warn = q('[data-testid="compare-incomparable"]')!
    expect(warn.textContent).toContain('不可比')
  })

  it('矩阵格子也标成不可比（灰底）', async () => {
    await mount()
    const cell = [...host.querySelectorAll('.wb-matrix-cell')]
      .find((el) => el.textContent?.includes('%'))!
    expect(cell.className).toContain('is-incomparable')
  })
})
