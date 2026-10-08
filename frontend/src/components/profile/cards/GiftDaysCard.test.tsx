// @vitest-environment jsdom
/**
 * 「直播收益」卡（需求 5，`devlog/452`）。
 *
 * 判据对着三个**会静默出错**的地方：
 * ① 脏金额不许被当成 0（`Number("") === 0`）—— 由 `utils/giftTrend.test.ts` 钉住解析，
 *    这里钉"卡片真的走了那条口径"（脏值 ⇒ 那一段柱子不存在，而不是 0 高度的柱）；
 * ② **整份没数据 ⇒ 说"还没有记录"，不画 0 线**（画出来是一句假话）；
 * ③ 三段堆叠：礼物 / 舰长 / SC 各自的 `data-gt-kind` 都在，且合计与 `giftSummary` 一致。
 *
 * ⚠️ "真模块 + 覆盖"的 mock 写法（`VideoPlayer.keys.test.tsx` 那套）：只写一个函数的话，
 * 组件树里别处调的 `api.*` 会变成 undefined ⇒ 一串 unhandled error（vitest 会警告假阳性）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listLiveGiftDays = vi.fn()
vi.mock('../../../api/api', async (orig) => {
  const real = await orig<typeof import('../../../api/api')>()
  return {
    ...real,
    api: { ...real.api, listLiveGiftDays: (...a: unknown[]) => listLiveGiftDays(...a) },
  }
})

import GiftDaysCard from './GiftDaysCard'
import type { LiveGiftDay } from '../../../api/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const ACCOUNT = { id: 7, platform: 'bilibili', platform_uid: '123' } as never
const VTUBER = { id: 1, name: '测试', accounts: [] } as never

function day(date: string, over: Partial<LiveGiftDay> = {}): LiveGiftDay {
  return {
    id: 1, account_id: 7, source: 'zeroroku', gift_date: date,
    gift_amount: null, guard_amount: null, sc_amount: null, total_amount: null,
    room_id: null, created_at: null, ...over,
  }
}

async function render(days: LiveGiftDay[] | Error) {
  if (days instanceof Error) listLiveGiftDays.mockRejectedValueOnce(days)
  else listLiveGiftDays.mockResolvedValueOnce(days)
  await act(async () => {
    root.render(<GiftDaysCard vtuber={VTUBER} account={ACCOUNT} onOpenPost={() => {}}
                              refreshTick={0} editing={false} />)
  })
  await act(async () => { await Promise.resolve() })
}

const bars = () => [...host.querySelectorAll('[data-gt-bar]')]
const segs = (kind: string) => [...host.querySelectorAll(`[data-gt-kind="${kind}"]`)]
const text = () => host.textContent ?? ''

beforeEach(() => {
  listLiveGiftDays.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe('直播收益卡', () => {
  it('★ 三天数据 ⇒ 三根柱，三段堆叠齐全，合计与汇总一致', async () => {
    await render([
      day('2026-10-01', { gift_amount: '10', guard_amount: '20', sc_amount: '5' }),
      day('2026-10-02', { gift_amount: '30' }),
      day('2026-10-03', { total_amount: '100' }),
    ])
    expect(listLiveGiftDays).toHaveBeenCalledWith(7)
    expect(bars().length, '三天各一根').toBe(3)
    expect(segs('gift').length + segs('guard').length + segs('sc').length,
      '三段堆叠：有值的段都要画出来').toBeGreaterThanOrEqual(4)
    expect(text(), '汇总一行').toContain('近 3 天合计')
    expect(text()).toContain('165')          // (10+20+5) + 30 + 100
  })

  it('★ 脏金额解析不出 ⇒ **那一段不画**（不许当成 0 画一根 0 高度的柱）', async () => {
    await render([day('2026-10-01', { gift_amount: '10', guard_amount: '呵呵', sc_amount: '' })])
    expect(segs('gift').length, '有效的礼物段在').toBe(1)
    expect(segs('guard').length, '识别不出的舰长段不该出现').toBe(0)
    expect(segs('sc').length, '空串同理').toBe(0)
  })

  it('★ 整份没数据 ⇒ 说"还没有记录"，**一根柱都不画**', async () => {
    await render([day('2026-10-01'), day('2026-10-02')])
    expect(bars().length, '不许画 0 线').toBe(0)
    expect(text()).toContain('还没有直播收益记录')
  })

  it('只有 30 天窗口：多给的历史只画最后 30 天（柱数封顶）', async () => {
    // ⚠️ 日期必须**互不相同**：`buildGiftPoints` 按日归并，喂重复日期的话柱数天然 ≤28，
    //    这条用例就变成"永远通过"（第一版就是这么写的，变异 S 没被杀死才发现）。
    const many = [
      ...Array.from({ length: 31 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, { gift_amount: '1' })),
      ...Array.from({ length: 14 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, '0')}`, { gift_amount: '1' })),
    ]
    expect(new Set(many.map((d) => d.gift_date)).size, '正对照：45 个**不同**日期').toBe(45)
    await render(many)
    expect(bars().length, '窗口裁到 30').toBe(30)
  })

  it('取数失败 ⇒ 明说（不静默）+ 无账号 ⇒ 说明白该先加账号', async () => {
    await render(new Error('boom'))
    expect(text()).toContain('收益数据没取到')

    await act(async () => {
      root.render(<GiftDaysCard vtuber={VTUBER} account={null} onOpenPost={() => {}}
                                refreshTick={0} editing={false} />)
    })
    expect(text()).toContain('还没有账号')
  })
})
