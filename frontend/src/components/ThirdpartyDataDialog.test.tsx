// @vitest-environment jsdom
/**
 * 「第三方数据」小窗 + 数据视图那枚入口钮（2026-10-05，`devlog/354`）。
 *
 * 守的是三件用户能看到的事：
 * ① 现状**按账号分开**显示，且第三方与"本工具自己抓的"分开列（混起来就是谎报数据量）；
 * ② 源被设置关着 ⇒ 按钮**禁用并说明原因**（关着时点它一条都不会发，静默失败最气人）；
 * ③ 补拉走的是"只补这个 V"那个接口（不是全量），点完关窗并提示进度看顶栏。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ThirdpartyDataDialog from './ThirdpartyDataDialog'
import type { ThirdpartyOverview } from '../api/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const OVERVIEW: ThirdpartyOverview = {
  vtuber_id: 18,
  running: false,
  sources: [
    { name: 'zeroroku', enabled: true, jobs: [{ kind: 'fan_history', label: '粉丝历史', interval: 'daily' }] },
    { name: 'danmakus', enabled: true, jobs: [{ kind: 'live_sessions', label: '场次', interval: 'daily' }] },
  ],
  thirdparty_accounts: [
    {
      account_id: 20, platform_uid: '1660392980', display_name: '恬豆发芽了',
      fan_history: { rows: 1043, first_at: '2022-05-06T22:50:31', last_at: '2026-09-27T11:54:54' },
      fan_history_local: { rows: 553, first_at: '2026-09-03T15:19:37', last_at: '2026-10-05T11:35:26' },
      live_sessions: { rows: 458, first_at: '2022-01-19T10:40:00', last_at: '2026-10-03T13:02:17' },
      live_sessions_feed: { rows: 13, first_at: '2026-09-07T10:00:10', last_at: '2026-10-05T09:26:40' },
      gift_days: { rows: 798, first_at: '2022-08-31', last_at: '2026-10-03' },
    },
    {
      account_id: 21, platform_uid: '16548039', display_name: '普通小栗',
      fan_history: { rows: 0, first_at: null, last_at: null },
      fan_history_local: { rows: 210, first_at: '2026-09-03T15:19:41', last_at: '2026-10-04T18:10:10' },
      live_sessions: { rows: 0, first_at: null, last_at: null },
      live_sessions_feed: { rows: 0, first_at: null, last_at: null },
      gift_days: { rows: 0, first_at: null, last_at: null },
    },
  ],
}

const overviewMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('../api/api', () => ({
  api: {
    thirdpartyOverview: (...a: unknown[]) => overviewMock(...a),
    refreshThirdparty: (...a: unknown[]) => refreshMock(...a),
  },
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  overviewMock.mockReset().mockResolvedValue(OVERVIEW)
  refreshMock.mockReset().mockResolvedValue({ status: 'started', accounts: [20, 21] })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

/** 挂上并等一次拉取落地（Radix 弹窗走 portal，查 body） */
async function renderOpen(over = OVERVIEW) {
  overviewMock.mockResolvedValue(over)
  await act(async () => {
    root.render(<ThirdpartyDataDialog open onOpenChange={() => {}} vtuberId={18} name="恬豆发芽了" />)
  })
  await act(async () => { await Promise.resolve() })
  return document.querySelector<HTMLElement>('[data-thirdparty-dialog]')!
}

describe('第三方数据小窗', () => {
  it('现状**按账号分开**、第三方与本工具直采分开列', async () => {
    const dlg = await renderOpen()
    expect(overviewMock).toHaveBeenCalledWith(18)
    const blocks = [...dlg.querySelectorAll('[data-thirdparty-account]')]
    expect(blocks.map((b) => b.getAttribute('data-thirdparty-account'))).toEqual(['20', '21'])
    const txt = (el: Element) => (el.textContent || '').replace(/\s+/g, ' ')
    // 第一块：第三方场次 458 条、最新 2026-10-03（日期只显示到天）
    expect(txt(blocks[0])).toContain('458 条 · 2022-01-19 → 2026-10-03')
    expect(txt(blocks[0])).toContain('1043 条')
    // "本工具自己抓的"必须**另起一行**（553 快照 + 13 实时场次），不能并进上面那三行
    expect(txt(blocks[0])).toContain('快照 553 条 · 实时场次 13 条')
    // 第二块：全空 ⇒ 如实说"空"，而不是把第一个账号的数字抄一遍
    expect(txt(blocks[1])).toContain('空')
    expect(txt(blocks[1])).not.toContain('458')
  })

  it('补拉调的是"只补这个 V"那个接口，并提示去顶栏看进度', async () => {
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<ThirdpartyDataDialog open onOpenChange={onOpenChange} vtuberId={18} />)
    })
    await act(async () => { await Promise.resolve() })
    const btn = document.querySelector<HTMLElement>('[data-thirdparty-refresh]')!
    expect(btn).toBeTruthy()
    await act(async () => { btn.click(); await Promise.resolve() })
    expect(refreshMock).toHaveBeenCalledWith(18)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('源被设置关着 ⇒ 按钮禁用并说清原因（关着时点它一条都不会发）', async () => {
    const off = { ...OVERVIEW, sources: OVERVIEW.sources.map((s) => ({ ...s, enabled: false })) }
    const dlg = await renderOpen(off)
    const btn = dlg.querySelector<HTMLButtonElement>('[data-thirdparty-refresh]')!
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toContain('设置')
    expect(dlg.querySelector('[data-thirdparty-sources]')?.textContent).toContain('已关闭')
  })

  it('已经在跑 ⇒ 按钮禁用（不去同时打第三方站点）', async () => {
    const dlg = await renderOpen({ ...OVERVIEW, running: true })
    expect(dlg.querySelector<HTMLButtonElement>('[data-thirdparty-refresh]')!.disabled).toBe(true)
  })

  it('没有 bilibili 账号 ⇒ 说清为什么，而不是一片空白', async () => {
    const dlg = await renderOpen({ ...OVERVIEW, thirdparty_accounts: [] })
    expect(dlg.textContent).toContain('没有 bilibili 账号')
  })
})
