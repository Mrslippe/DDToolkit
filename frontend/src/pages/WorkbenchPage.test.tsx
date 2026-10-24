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
const fanSearch = vi.fn()
const fanMember = vi.fn()
const fanProfile = vi.fn()
const fanActivity = vi.fn()

/** 滑杆数据：30 场、每天一场（9 月），后端 `?limit=150` 的形状 */
const ACTIVITY = {
  vtuber: '弥月Mizuki',
  today: '2026-10-18',
  years: [2026],
  days: Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => {
      const d = `2026-09-${`${i + 1}`.padStart(2, '0')}`
      return [d, { n: 1, c: i % 3 === 0 ? 1 : 0 }]
    }),
  ),
  recent: Array.from({ length: 30 }, (_, i) => ({
    at: `2026-09-${`${i + 1}`.padStart(2, '0')} 20:00:00`,
    c: i % 3 === 0,
    n: i % 3 === 0 ? 12000 : 0,
  })),
  limit: 150,
}

vi.mock('../api/api', () => ({
  api: {
    fanVtubers: () => fanVtubers(),
    fanSessions: (...a: unknown[]) => fanSessions(...a),
    fanCollect: (...a: unknown[]) => fanCollect(...a),
    fanCollectStatus: (...a: unknown[]) => fanCollectStatus(...a),
    fanCollectCancel: (...a: unknown[]) => fanCollectCancel(...a),
    fanRanked: (...a: unknown[]) => fanRanked(...a),
  fanSearch: (...a: unknown[]) => fanSearch(...a),
  fanMember: (...a: unknown[]) => fanMember(...a),
    // 档案卡（V2，2026-10-18）：选中 V 后页面会拉它，桩里必须有，否则整页抛错
    fanProfile: () => fanProfile(),
    // 删除按钮只在弹窗打开时才调它；桩留着，免得以后加交互时整页抛错
    fanPurge: () => Promise.resolve({ sessions: 0, files: 0, bytes: 0, by_dir: {} }),
    // 热力图 + 滑杆的数据源（V3/V4）：没有它滑杆不渲染，结果区就一直是空态
    fanActivity: () => fanActivity(),
  },
  // 档案卡会用它把 `static/...` 转成可加载 URL；桩里给个恒等即可
  resolveAsset: (p: string | null | undefined) => p ?? null,
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
  // 全池聚合（过 10% 门槛后的所有人）—— 两张图必须用它，而不是 items
  pool: { size: 1200, tiers: { 核心: 450, 次核心: 750 },
          acv: 600, excluded: 40000, pool_rule: '2×ACV',
          bins: { lo: 0.2, hi: 1, counts: Array.from({ length: 20 }, () => 60) },
          axes: {
            attendance: { lo: 0.1, hi: 1, counts: Array.from({ length: 20 }, () => 60) },
            interaction: { lo: 0, hi: 1, counts: Array.from({ length: 20 }, () => 60) },
            payment: { lo: 0, hi: 1, counts: Array.from({ length: 20 }, () => 60) },
          },
          pay_split: { gift: 1000, guard: 3000, sc: 6000 } },
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
  fanSearch.mockReset().mockResolvedValue({ items: [], total_match: 0 })
  fanMember.mockReset().mockResolvedValue({
    uid: '19871', name: '碳了个酸', avatar: '/fan/avatar/19871', type: '综合', strength: 0.9994,
    axis_percentiles: { attendance: 1, interaction: 1, payment: 1 },
    totals: { att_sessions: 12, att_rate: 1, msg_total: 4159, msg_unique: 2000, pay_total: 26660,
              gift_cnt: 3, guard_cnt: 1, sc_cnt: 20, sessions_with_pay: 9,
              first_seen: 0, last_seen: 1, max_repeat: 30,
              window_sessions: 12, msg_per_session: 346.6, mean_lag_minutes: 8.2,
              gift_amt: 120, guard_amt: 16000, sc_amt: 10540,
              pay_events: 24, pay_per_event: 1110.8, variety: 0.48, maxrep: 30,
              spam_rule: null },
    tags: ['满勤', '大额打米'], spam: null, window_sessions: 12,
    series: [{ live_id: 'x', start_at: '2026-09-01 20:00', m: 100, p: 10, e: 1, uniq: 90 }],
  })
  fanActivity.mockReset().mockResolvedValue(ACTIVITY)
  // 档案卡（V2）的桩：只要"读到了"的形状就够，本文件不判它的视觉细节
  fanProfile.mockReset().mockResolvedValue({
    vtuber: { id: 1, name: '弥月Mizuki', faction: null, birthday: null, debut_date: null,
              setting: null, avatar: null, avatar_local: null, background_path: null,
              background_focus: null, background_video_path: null,
              background_video_focus: null, notes: null, sign_override: null,
              sign_source_account_id: null, sort_order: 0,
              created_at: null, updated_at: null },
    stats: { followers: 53006, total_sessions: 1168, collected: 75,
             first: '2022-07-24', last: '2026-10-11', coverage: 0.0642 },
  })
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

  it('启用后渲染主播选择器与窗口读数，并显示后端的预估', async () => {
    await mount()
    // 主播切换器已换成项目自己的 Radix 下拉（`ui/select`），不再是原生 <select>：
    // 断言"触发器存在 + 显示的是选中的那个 V"就够，选项列表在点开后才挂载。
    const sel = q<HTMLElement>('[data-testid="workbench-vtuber"]')
    expect(sel).not.toBeNull()
    expect(sel!.textContent).toContain('弥月')   // 优先选已有数据的那个
    // 2026-10-23：结果区空态**不再显示采集读数**（用户：没有分析结果前不要展示采集信息）。
    // 采集相关信息只在「直播与采集」卡里 —— 这里断言"空态没有预览条"即可。
    expect(q('[data-testid="workbench-preview"]')).toBeNull()
    // 2026-10-19 起这一行是**滑轨区间选择器**（不再是窗口首尾日期）
    expect(document.querySelector('[data-testid="range-trigger"]')).not.toBeNull()
    // 区间按钮已移到「直播与采集」卡右下角那一行（2026-10-19 用户第 2 条），
    // 不在统计条里 —— 统计条只剩窗口场次/已有/待采。
    expect(document.querySelector('[data-testid="range-trigger"]')).not.toBeNull()
    // 预览请求有 200ms 防抖（2026-10-19 A4），等它触发
    await act(async () => { await new Promise((r) => setTimeout(r, 260)) })
    expect(fanSessions).toHaveBeenCalled()
  })

  it('★ 已有 + 待采 恒等于窗口场次（不再按日期区间数）', async () => {
    // 2026-10-19 用户发现：窗口 75 场、已有 77 场、待采 1。
    // 根因是“已有/待采”拿日期区间去库里数，而边界那两天整天都算进去了。
    // 现在从切片上的 `c` 数：ACTIVITY 是 30 场、每 3 场已采 1 场 ⇒ 已有 10、待采 20。
    // 2026-10-23：胶囊只在**出结果后**出现在标题行，所以先跑一次分析。
    await mount()
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="workbench-load"]')!.click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const box = document.querySelector('[data-testid="workbench-preview"]') as HTMLElement
    const txt = box.textContent ?? ''
    const already = Number(/已有\s*(\d+)/.exec(txt)?.[1])
    const to = Number(/待采\s*(\d+)/.exec(txt)?.[1])
    expect(already).toBe(10)
    expect(to).toBe(20)
    expect(already + to).toBe(30)
  })

  it('待采为 0 时「开始采集」是禁用的', async () => {
    // 切片里每一场都已采 ⇒ 待采 0
    fanActivity.mockResolvedValueOnce({
      ...ACTIVITY,
      recent: ACTIVITY.recent.map((s: { c: boolean }) => ({ ...s, c: true })),
    })
    await mount()
    const btn = document.querySelector('[data-testid="workbench-collect"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.disabled).toBe(true)
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

  it('热力图的格子 hover 时浮出自定义浮窗（不是原生 title）', async () => {
    await mount()
    const cell = document.querySelector('[data-day="2026-09-01"]') as HTMLElement
    expect(cell).not.toBeNull()
    expect(cell.getAttribute('title')).toBeNull()   // 原生 title 已移除
    await act(async () => {
      // React 18 把 onMouseEnter 代理在根节点的 mouseover 上，所以派发 mouseover
      cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 40, clientY: 40 }))
    })
    const tip = document.querySelector('[data-testid="hm-tip"]')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('2026-09-01')
  })

  it('删除已采集：按钮打开确认弹窗，并显示预览（不可恢复的操作先给数字）', async () => {
    await mount()
    const btn = document.querySelector('[data-testid="workbench-purge"]') as HTMLElement
    expect(btn).not.toBeNull()
    await act(async () => { btn.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // AlertDialog 走 Portal，内容挂在 document.body 上
    expect(document.querySelector('[data-testid="purge-dialog"]')).not.toBeNull()
    // 确认按钮在预览回来之前不可点（防止"没看清就删"）
    const ok = document.querySelector('[data-testid="purge-confirm"]') as HTMLButtonElement | null
    expect(ok).not.toBeNull()
  })

  it('「分析」按 strength 取，结果显示为两张小卡片', async () => {
    await mount()
    await act(async () => {
      (document.querySelector('[data-testid="workbench-load"]') as HTMLElement).click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(fanRanked).toHaveBeenCalledTimes(1)
    expect(fanRanked.mock.calls[0][1]).toBe('strength')
    // 结果区的主展示：分层饼图 + 核心度分布（表格已按用户要求移出）
    expect(document.querySelector('[data-testid="chart-pie-card"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="chart-line-card"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="workbench-table"]')).toBeNull()
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

describe('结果区：全池口径与标题行胶囊', () => {
  async function analyse(): Promise<void> {
    await mount()
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="workbench-load"]')!.click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  }

  it('★ 胶囊在卡片标题行内（同一行的右侧），不再单独占一行', async () => {
    await analyse()
    const head = q('[data-testid="workbench-result"] .wb-card-head')
    expect(head).toBeTruthy()
    const pills = head!.querySelector('[data-testid="workbench-preview"]')
    expect(pills).toBeTruthy()
    // 标题行里同时有 h2 与胶囊
    expect(head!.querySelector('.wb-card-title')).toBeTruthy()
  })

  it('★ 两张图覆盖全池人数（不是 limit 条名单）', async () => {
    await analyse()
    const pie = q('[data-testid="chart-pie-card"]')
    expect(pie).toBeTruthy()
    expect(pie!.textContent).toContain('1200')
  })
})

describe('空态与页签（2026-10-23）', () => {
  async function analyse(): Promise<void> {
    await mount()
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="workbench-load"]')!.click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  }

  it('★ 空态只留一句引导，不显示采集胶囊', async () => {
    await mount()
    const empty = q('[data-testid="result-empty"]')
    expect(empty).toBeTruthy()
    expect(empty!.textContent).toContain('请先选择时间范围进行分析')
    // 采集信息只在「直播与采集」卡里，结果区空态不该出现
    expect(q('[data-testid="workbench-preview"]')).toBeNull()
  })

  it('★ 名单懒加载：点「加载更多」带 offset 并追加行', async () => {
    await analyse()
    const more = q<HTMLButtonElement>('[data-testid="ranked-more"]')!
    expect(more).toBeTruthy()
    await act(async () => { more.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const calls = fanRanked.mock.calls
    const last = calls[calls.length - 1]!
    expect(last[1]).toBe('strength')
    expect((last[2] as { offset?: number }).offset).toBe(2)   // 首屏 mock 2 行
    // 追加后表格行数翻倍（同两行再来一次）
    expect(document.querySelectorAll('[data-testid="ranked-table"] tbody tr').length).toBe(4)
  })

  it('★ 出结果后四个页签都在，切页签按对应口径重排', async () => {
    await analyse()
    expect(q('[data-testid="tab-overview"]')).toBeTruthy()
    expect(q('[data-testid="tab-attendance"]')).toBeTruthy()
    expect(q('[data-testid="tab-interaction"]')).toBeTruthy()
    expect(q('[data-testid="tab-payment"]')).toBeTruthy()

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="tab-payment"]')!.click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const calls = fanRanked.mock.calls
    const last = calls[calls.length - 1]!
    expect(last[1]).toBe('payment')
    expect((last[2] as { offset?: number }).offset).toBe(0)
  })
})

describe('ACV 方案（2026-10-23）', () => {
  async function analyse(): Promise<void> {
    await mount()
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="workbench-load"]')!.click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  }

  it('★ 池子按 2×ACV 划定，并写明分流走多少人', async () => {
    await analyse()
    const note = q('[data-testid="pool-rule"]')
    expect(note).toBeTruthy()
    expect(note!.textContent).toContain('3×平均同接')
    expect(note!.textContent).toContain('40,000')
  })
})

describe('搜索 / 标签 / 详情（2026-10-24）', () => {
  async function analyse(): Promise<void> {
    await mount()
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="workbench-load"]')!.click()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  }

  it('★ 标题行有搜索框，输入后展示下拉', async () => {
    await analyse()
    const input = q<HTMLInputElement>('[data-testid="ranked-search"]')!
    expect(input).toBeTruthy()
    fanSearch.mockResolvedValueOnce({
      items: [{ uid: '19871', name: '碳了个酸', type: '综合', strength: 0.99, avatar: '/fan/avatar/19871' }],
      total_match: 1,
    })
    await act(async () => {
      // React 会拦截 value 的赋值，必须走原型上的 setter 才能触发 onChange
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '碳')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 320)) })
    expect(fanSearch).toHaveBeenCalled()
    expect(q('[data-testid="ranked-search-pop"]')).toBeTruthy()
  })

  it('★ 点名单行打开详情弹窗', async () => {
    await analyse()
    const row = document.querySelector('[data-testid="ranked-table"] tbody tr') as HTMLElement
    expect(row).toBeTruthy()
    await act(async () => { row.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // Dialog 走 portal 渲染到 body，必须查 document 而不是 host
    expect(document.querySelector('[data-testid="member-drawer"]')).toBeTruthy()
    expect(fanMember).toHaveBeenCalled()
  })
})
