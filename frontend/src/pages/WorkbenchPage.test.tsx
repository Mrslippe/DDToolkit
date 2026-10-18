// @vitest-environment jsdom
/**
 * 数据分析工作台单屏（2026-10-18，用户口径：**1 屏** —— 选主播 → 选区间 → 确认采集 → 看名单）。
 *
 * 判据钉五件事（少一件这个模块就是"假的"）：
 * ① **模块没启用 ⇒ 只显示去设置的提示**，不渲染任何选择器/按钮；
 * ② 预估数字来自后端（`to_collect`），且**待采 0 场时「开始采集」是禁用的**；
 * ③ 点「开始采集」⇒ **真的调 `fanCollect`**（带对的主播与区间）；
 * ④ 采集跑起来后**轮询进度**，结束后自动刷新预估；
 * ⑤ 「查看名单」渲染表格，**标签按 chip 显示**、`by` 传的是 `strength`（不是后端默认——后端没有默认）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fanVtubers = vi.fn()
const fanSessions = vi.fn()
const fanCollect = vi.fn()
const fanCollectStatus = vi.fn()
const fanCollectCancel = vi.fn()
const fanRanked = vi.fn()

vi.mock('../api/api', () => ({
  api: {
    fanVtubers: () => fanVtubers(),
    fanSessions: (...a: unknown[]) => fanSessions(...a),
    fanCollect: (...a: unknown[]) => fanCollect(...a),
    fanCollectStatus: (...a: unknown[]) => fanCollectStatus(...a),
    fanCollectCancel: (...a: unknown[]) => fanCollectCancel(...a),
    fanRanked: (...a: unknown[]) => fanRanked(...a),
  },
}))

import WorkbenchPage from './WorkbenchPage'

const VTUBERS = {
  items: [
    { name: '弥月Mizuki', short: '弥月', mid: '1', subdir: 'a', has_data: true, sessions: 75 },
    { name: '明前奶绿', short: '明前奶绿', mid: '2', subdir: 'b', has_data: false, sessions: 0 },
  ],
  count: 2, enabled: true, data_root: '/tmp', error: null,
}

const PREVIEW = {
  vtuber: '弥月Mizuki', since: '2026-09-01', until: '2026-09-30',
  total: 12, already: 4, to_collect: 8,
  first: '2026-09-02 20:00:00', last: '2026-09-28 20:00:00',
}

const RANKED = {
  vtuber: '弥月Mizuki', window: 75, sessions: 12,
  since: '2026-09-01', until: '2026-09-30', by: 'strength',
  purity_threshold: 0.15, total_in_pool: 3, count: 2,
  items: [
    { rank: 1, uid: '19871', type: '综合', strength: 0.9994,
      axis_percentiles: { attendance: 1, interaction: 1, payment: 1 },
      att_sessions: 12, att_rate: 1, pay_total: 26660, msg_total: 4159,
      tags: ['满勤', '大额打米'] },
    { rank: 2, uid: '6094722', type: '出勤', strength: 0.71,
      axis_percentiles: { attendance: 1, interaction: 0.4, payment: 0.1 },
      att_sessions: 9, att_rate: 0.75, pay_total: 0, msg_total: 2, tags: [] },
  ],
}

let host: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>,
    )
  })
  // 让 useEffect 里的 promise 链跑完
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector(sel) as T | null
}

beforeEach(() => {
  fanVtubers.mockReset().mockResolvedValue(VTUBERS)
  fanSessions.mockReset().mockResolvedValue(PREVIEW)
  fanCollect.mockReset().mockResolvedValue({ ok: true, vtuber: '弥月Mizuki',
                                             since: '2026-09-01', until: '2026-09-30',
                                             state: 'running' })
  fanCollectStatus.mockReset().mockResolvedValue({ items: [], count: 0 })
  fanCollectCancel.mockReset().mockResolvedValue({ ok: true })
  fanRanked.mockReset().mockResolvedValue(RANKED)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('数据分析工作台', () => {
  it('模块没启用时只说怎么开，不渲染任何选择器', async () => {
    fanVtubers.mockResolvedValue({ ...VTUBERS, enabled: false })
    await mount()
    expect(host.textContent).toContain('未启用')
    expect(host.textContent).toContain('设置')
    expect(q('[data-testid="workbench-setup"]')).toBeNull()
    expect(q('[data-testid="workbench-collect"]')).toBeNull()
    expect(fanSessions).not.toHaveBeenCalled()
  })

  it('启用后渲染主播选择器与区间，并显示后端的预估', async () => {
    await mount()
    const sel = q<HTMLSelectElement>('[data-testid="workbench-vtuber"]')
    expect(sel).not.toBeNull()
    expect(sel!.options.length).toBe(2)
    expect(sel!.value).toBe('弥月Mizuki')     // 优先选已有数据的那个
    expect(q('[data-testid="workbench-preview"]')!.textContent).toContain('12')
    expect(q('[data-testid="workbench-preview"]')!.textContent).toContain('待采')
    expect(fanSessions).toHaveBeenCalled()
  })

  it('待采为 0 时「开始采集」是禁用的', async () => {
    fanSessions.mockResolvedValue({ ...PREVIEW, already: 12, to_collect: 0 })
    await mount()
    const btn = q<HTMLButtonElement>('[data-testid="workbench-collect"]')
    expect(btn!.disabled).toBe(true)
  })

  it('点「开始采集」真的调接口，参数是选中的主播与区间', async () => {
    await mount()
    const btn = q<HTMLButtonElement>('[data-testid="workbench-collect"]')!
    expect(btn.disabled).toBe(false)
    await act(async () => { btn.click() })
    await act(async () => { await Promise.resolve() })
    expect(fanCollect).toHaveBeenCalledTimes(1)
    const [name, since, until] = fanCollect.mock.calls[0] as [string, string, string]
    expect(name).toBe('弥月Mizuki')
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // 进度那一行要出现
    expect(q('[data-testid="workbench-progress"]')).not.toBeNull()
  })

  it('采集中会轮询进度（running ⇒ 至少查一次状态）', async () => {
    await mount()
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="workbench-collect"]')!.click()
    })
    await act(async () => { await Promise.resolve() })
    // 让轮询的 setInterval 触发一次
    await act(async () => { await new Promise((r) => setTimeout(r, 1200)) })
    expect(fanCollectStatus.mock.calls.length).toBeGreaterThan(0)
  })

  it('「查看名单」按 strength 取，表格与标签都渲染出来', async () => {
    await mount()
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="workbench-load"]')!.click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(fanRanked).toHaveBeenCalledTimes(1)
    const [name, by] = fanRanked.mock.calls[0] as [string, string]
    expect(name).toBe('弥月Mizuki')
    expect(by).toBe('strength')      // 后端没有默认口径，前端必须显式给

    const table = q('[data-testid="workbench-table"]')
    expect(table).not.toBeNull()
    expect(table!.textContent).toContain('19871')
    expect(table!.textContent).toContain('满勤')       // 标签 chip
    expect(table!.textContent).toContain('大额打米')
    expect(table!.textContent).toContain('100%')        // 出席率
  })

  it('接口报错时把话说清楚，而不是空白', async () => {
    fanRanked.mockRejectedValue(new Error('数据分析工作台未启用'))
    await mount()
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="workbench-load"]')!.click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(q('[data-testid="workbench-error"]')!.textContent).toContain('未启用')
  })
})
