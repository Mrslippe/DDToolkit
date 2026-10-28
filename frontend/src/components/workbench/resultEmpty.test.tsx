// @vitest-environment jsdom
/**
 * 结果区**空态卡片**（2026-10-28 用户口径）：还没分析时也沿用有结果时的那套卡片样式，
 * 只把卡片内容换成空态文本。
 *
 * 钉两件事：
 * ① **两种状态长得一样**：`EMPTY_CARDS` 里的标题必须与真实渲染出来的卡片标题逐字一致
 *    （否则空态一套、有结果一套，切个页签像换了页面）；
 * ② **空态不摆假按钮**：名单卡保留外壳，但不渲染搜索/导出，也不渲染空表格。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/api', () => ({
  api: {
    getPrefs: () => Promise.resolve({ values: {}, defaults: {}, specs: [], changed: [] }),
    fanRankedCsv: () => Promise.resolve({ blob: new Blob(), filename: 'x.csv' }),
    fanSearch: () => Promise.resolve({ items: [], total_match: 0 }),
  },
  resolveAsset: (p?: string | null) => p ?? null,
}))

import ResultCharts, { EMPTY_CARDS, EMPTY_TEXT, type RankedTab } from './ResultCharts'
import RankedTable from './RankedTable'
import type { FanRankedRow } from '../../api/types'

let host: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  })
}

function mount(el: React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return act(async () => { root.render(el) })
}

/** 卡片标题的**第一段文本**（`.wb-card-title` 里还跟着一个 `.wb-card-note`，要去掉） */
function titles(): string[] {
  return [...host.querySelectorAll('.wb-card-title')].map(
    (el) => (el.childNodes[0]?.textContent ?? '').trim(),
  )
}

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('空态卡片与真实卡片的标题必须一致', () => {
  const POOL = {
    size: 100,
    tiers: { 核心: 10, 次核心: 20, 外层: 70 },
    bins: { lo: 0, hi: 1, counts: [3, 2, 1] },
    pay_split: { gift: 100, guard: 200, sc: 300 },
  }
  const CASES: { tab: RankedTab; charts: Record<string, unknown>; pool: boolean }[] = [
    { tab: 'overview', pool: true,
      charts: { pool_trend: [{ end: 5, size: 10, new: 10, left: 0, same: 0 }] } },
    { tab: 'attendance', pool: false,
      charts: { lag_hist: { labels: ['<5', '5–10'], counts: [10, 5] } } },
    { tab: 'interaction', pool: false,
      charts: { msg_split_top: { labels: ['话痨A'], values: [100] },
                msg_pct: { pcts: [0.5], means: [10] } } },
    { tab: 'payment', pool: true,
      charts: { pay_split_top: { labels: ['鲸鱼A'], values: [100] } } },
  ]

  for (const c of CASES) {
    it(`${c.tab}：EMPTY_CARDS 与真实卡片的标题逐字一致`, async () => {
      await mount(
        <ResultCharts
          items={[]} pool={c.pool ? POOL : null} tab={c.tab}
          attBins={{ max: 3, counts: [0, 10, 20, 30] }}
          charts={c.charts as never}
        />,
      )
      await flush()
      const real = titles()
      expect(real.length).toBeGreaterThan(0)
      // 真实卡片是**两卡一页**（只有当前页渲染）⇒ 比对目录的前 N 项，
      // 同时目录不能比实际页短（少了就是空态里凭空少一张卡）。
      expect(EMPTY_CARDS[c.tab].length).toBeGreaterThanOrEqual(real.length)
      expect(real).toEqual(EMPTY_CARDS[c.tab].slice(0, real.length).map((x) => x.title))
    })
  }
})

describe('空态渲染：卡片框在、内容换成文本、不摆假控件', () => {
  it('图表卡：该页签的卡**一次全列**（不翻页）+ 空态文本 + 没有箭头', async () => {
    await mount(<ResultCharts items={[]} pool={null} tab="overview" empty />)
    await flush()
    expect(host.querySelector('[data-testid="result-charts-empty"]')).toBeTruthy()
    // 空态没有"第几页"的概念 ⇒ 该页签的卡全列出来（用户一眼看到将来会出现什么）
    expect(titles()).toEqual(EMPTY_CARDS.overview.map((x) => x.title))
    expect(host.querySelectorAll('.wb-chart-card').length).toBe(EMPTY_CARDS.overview.length)
    expect(host.textContent).toContain(EMPTY_TEXT.title)
    expect(host.textContent).toContain(EMPTY_TEXT.hint)
    expect(host.querySelector('[data-testid="charts-prev"]')).toBeNull()
    expect(host.querySelector('[data-testid="charts-next"]')).toBeNull()
  })

  it('名单卡：保留标题与卡壳，不渲染表格/搜索/导出', async () => {
    const row = { rank: 1, uid: '1', name: 'x', strength: 1, axis_percentiles: {},
      tags: [] } as unknown as FanRankedRow
    await mount(
      <RankedTable
        rows={[row]} total={1} hasMore={false} onLoadMore={() => {}}
        vtuber="弥月Mizuki" since="2026-01-01" until="2026-10-26" ids={[]}
        onOpenMember={() => {}} tagOptions={[]} tagFilter={[]} onTagFilter={() => {}}
        sessionMeta={[]} empty
      />,
    )
    await flush()
    const card = host.querySelector('[data-testid="ranked-table-card"]')
    expect(card).toBeTruthy()
    expect(card!.getAttribute('data-empty')).toBe('1')
    expect(titles()).toEqual(['名单'])
    expect(card!.textContent).toContain(EMPTY_TEXT.hint)
    expect(host.querySelector('[data-testid="ranked-table"]')).toBeNull()
    expect(host.querySelector('[data-testid="export-csv"]')).toBeNull()
    expect(host.querySelector('[data-testid="ranked-search"]')).toBeNull()
  })
})
