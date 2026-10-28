// @vitest-environment jsdom
/**
 * 工作台「隐藏昵称」在**各个组件里**是否真的生效（2026-10-28 用户口径）。
 *
 * 为什么要单独一条组件用例（`utils/hideNicknames.test.ts` 已经测过开关本体）：
 * 开关本体对、但某个组件忘了接，用户看到的仍然是"开了还在露昵称" —— 那种漏接
 * 只有真的把组件渲染出来才看得见。这里覆盖三个最容易漏的地方：
 * ① 名单表的昵称列（含头像兜底首字）；
 * ② 贡献榜饼图的图例（文字在 canvas 旁边的 HTML 图例里，`其他 N 人` 不能被替换成 uid）；
 * ③ 后端说"开"的时候（不是只在用例里手动 apply）—— 走 `api.getPrefs` 那条真路。
 *
 * ⚠️ 要在用例里"打开开关"，**两边都要设**：`prefValue = 'on'`（后端桩）+
 * `applyHideNicknames('on')`（模块级现值）。只设前者得等异步加载那一眼；只设后者会被
 * 挂载后 `getPrefs` 的回包（后端桩说"关"）覆盖回去 —— 第一次写这条用例就是这么红的
 * （症状是"明明 apply 了，还是露昵称"，很容易误判成组件没接）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 后端此刻的偏好值（用例可改） */
let prefValue = 'off'
const getPrefs = vi.fn()

vi.mock('../../api/api', () => ({
  api: {
    getPrefs: (...a: unknown[]) => getPrefs(...a),
    fanRankedCsv: () => Promise.resolve({ blob: new Blob(), filename: 'x.csv' }),
    fanSearch: () => Promise.resolve({ items: [], total_match: 0 }),
  },
  resolveAsset: (p?: string | null) => p ?? null,
}))

import RankedTable from './RankedTable'
import ResultCharts from './ResultCharts'
import type { FanRankedRow } from '../../api/types'
import { applyHideNicknames, resetHideNicknames } from '../../utils/hideNicknames'

/** 一个人：昵称「鲸鱼A」，uid 19871 */
const ROW = {
  rank: 1, uid: '19871', name: '鲸鱼A', avatar: null, type: '综合', strength: 0.9,
  axis_percentiles: { attendance: 1, interaction: 1, payment: 1 },
  att_sessions: 12, att_rate: 1, pay_total: 100, msg_total: 10, tags: [],
} as unknown as FanRankedRow

let host: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  })
}

async function mountTable(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <RankedTable
        rows={[ROW]} total={1} hasMore={false} onLoadMore={() => {}}
        vtuber="弥月Mizuki" since="2026-01-01" until="2026-10-26" ids={[]}
        onOpenMember={() => {}}
        tagOptions={[]} tagFilter={[]} onTagFilter={() => {}}
        sessionMeta={[]}
      />,
    )
  })
  await flush()
}

async function mountCharts(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <ResultCharts
        items={[]} pool={null} tab="payment"
        charts={{
          pay_split_top: {
            labels: ['鲸鱼A', '鲸鱼B', '其他 10 人'],
            values: [20000, 9000, 3000],
            uids: ['19871', '6094722', null],
          },
        }}
      />,
    )
  })
  await flush()
}

beforeEach(() => {
  prefValue = 'off'
  getPrefs.mockReset()
  getPrefs.mockImplementation(() => Promise.resolve({
    values: { hide_nicknames: prefValue }, defaults: {}, specs: [], changed: [],
  }))
  resetHideNicknames()   // 模块级状态：不清就会"上一条开着，这一条也开着"
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  resetHideNicknames()
})

describe('名单表：隐藏昵称时只显示 uid', () => {
  it('关着（默认）：显示昵称，uid 在副行', async () => {
    await mountTable()
    const cell = host.querySelector('.wb-table-name')!
    expect(cell.textContent).toContain('鲸鱼A')
    expect(cell.querySelector('.wb-table-uid-sub')?.textContent).toBe('19871')
    expect(cell.getAttribute('data-hide-nickname')).toBe('0')
  })

  it('开着：昵称消失、主文字就是 uid，副行不再重复', async () => {
    prefValue = 'on'; applyHideNicknames('on')
    await mountTable()
    const cell = host.querySelector('.wb-table-name')!
    expect(cell.textContent).toBe('19871')
    expect(cell.textContent).not.toContain('鲸鱼A')
    // 副行是"昵称下面再写一遍 uid"，开了以后主文字已经是 uid ⇒ 不该重复
    expect(cell.querySelector('.wb-table-uid-sub')).toBeNull()
    expect(cell.getAttribute('data-hide-nickname')).toBe('1')
  })

  it('头像加载失败时兜底首字也跟着换（不能漏出「鲸」）', async () => {
    prefValue = 'on'; applyHideNicknames('on')
    await mountTable()
    expect(host.querySelector('.wb-avatar-fallback')?.textContent).toBe('1')
  })

  it('后端说开：走 api.getPrefs 那条真路也生效', async () => {
    prefValue = 'on'
    await mountTable()
    await flush()   // `useHideNicknames` 的加载是异步的
    expect(host.querySelector('.wb-table-name')!.textContent).toBe('19871')
  })
})

describe('贡献榜图例：隐藏昵称时换成 uid，合计项不动', () => {
  it('关着：图例是昵称', async () => {
    await mountCharts()
    const names = [...host.querySelectorAll('.wb-pie-name')].map((n) => n.textContent)
    expect(names).toEqual(['鲸鱼A', '鲸鱼B', '其他 10 人'])
  })

  it('开着：图例是 uid，`其他 N 人` 保持原文（它不是某个人）', async () => {
    prefValue = 'on'; applyHideNicknames('on')
    await mountCharts()
    const names = [...host.querySelectorAll('.wb-pie-name')].map((n) => n.textContent)
    expect(names).toEqual(['19871', '6094722', '其他 10 人'])
  })

  it('老响应没有 uids 时退回昵称（不能渲染成 undefined）', async () => {
    prefValue = 'on'; applyHideNicknames('on')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(
        <ResultCharts
          items={[]} pool={null} tab="payment"
          charts={{ pay_split_top: { labels: ['鲸鱼A', '其他 10 人'], values: [1, 2] } }}
        />,
      )
    })
    await flush()
    const names = [...host.querySelectorAll('.wb-pie-name')].map((n) => n.textContent)
    expect(names).toEqual(['鲸鱼A', '其他 10 人'])
  })
})
