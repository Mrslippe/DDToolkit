import { describe, expect, it } from 'vitest'
import type { Notice } from './notificationHub'
import {
  KIND_PRIORITY,
  LIVE_NOTICE_MS,
  composeTaskText,
  isLive,
  liveNotice,
  liveNotices,
  loginNotice,
  messageNotice,
  pickPrimary,
  progressNotice,
  rateLimitNotice,
  reportNotice,
} from './notificationHub'

/**
 * 顶栏通知中心的判定（R12a，devlog/089）。
 * 三个"界面说错话"的错法各有对应用例：自动节拍占顶栏 / 瞬时消息压过进度 / 过期条目不清。
 */
const n = (over: Partial<Notice>): Notice => ({
  id: 'x', kind: 'message', text: 't', ...over,
})

describe('优先级与挑选', () => {
  it('告警 > 进度 > 报告 > 瞬时消息', () => {
    const list = [
      n({ id: 'm', kind: 'message' }),
      n({ id: 'r', kind: 'report' }),
      n({ id: 'p', kind: 'progress' }),
      n({ id: 'a', kind: 'alert' }),
    ]
    expect(pickPrimary(list, 0)?.id).toBe('a')
    expect(pickPrimary(list.filter((x) => x.kind !== 'alert'), 0)?.id).toBe('p')
    expect(pickPrimary(list.filter((x) => x.kind === 'report' || x.kind === 'message'), 0)?.id)
      .toBe('r')
  })

  it('**瞬时消息压不过正在跑的任务**（用户在抓取途中要看得到进度）', () => {
    const list = [n({ id: 'p', kind: 'progress' }), n({ id: 'm', kind: 'message' })]
    expect(KIND_PRIORITY.progress).toBeGreaterThan(KIND_PRIORITY.message)
    expect(pickPrimary(list, 0)?.id).toBe('p')
  })

  it('同级取最新（来源按时间追加）', () => {
    const list = [n({ id: 'old', kind: 'progress' }), n({ id: 'new', kind: 'progress' })]
    expect(pickPrimary(list, 0)?.id).toBe('new')
  })

  it('空列表 → null（空闲态：只有一个绿点，无容器）', () => {
    expect(pickPrimary([], 0)).toBeNull()
  })
})

describe('过期', () => {
  it('瞬时消息到点自动消失；常驻条目不受时间影响', () => {
    const msg = n({ id: 'm', kind: 'message', expiresAt: 1000 })
    const sticky = n({ id: 's', kind: 'alert', sticky: true })
    expect(isLive(msg, 999)).toBe(true)
    expect(isLive(msg, 1001)).toBe(false)
    expect(isLive(sticky, 10 ** 12)).toBe(true)
    expect(liveNotices([msg, sticky], 1001).map((x) => x.id)).toEqual(['s'])
  })

  it('风控冷却告警带 expiresAt = 冷却结束时刻（到点自己消失，不需要额外清理）', () => {
    const rl = rateLimitNotice({ active: true, reason: 'code=-352', seconds_left: 600 }, 1_000_000)
    expect(rl?.expiresAt).toBe(1_000_000 + 600_000)
    expect(isLive(rl!, 1_599_000)).toBe(true)
    expect(isLive(rl!, 1_600_001)).toBe(false)
    expect(rateLimitNotice({ active: false, reason: '', seconds_left: 0 }, 0)).toBeNull()
    expect(rateLimitNotice(null, 0)).toBeNull()
  })
})

describe('进度条目：自动节拍不占顶栏（2026-09-10 用户口径）', () => {
  it('auto=true（动态流/自动账号流）直接不产生条目', () => {
    expect(progressNotice({ id: 'p', running: true, auto: true, text: '动态轮询中 - V - 1/7' }))
      .toBeNull()
  })

  it('手动/收录/外部批次照常出现', () => {
    const p = progressNotice({ id: 'p', running: true, auto: false, text: '全量抓取中 - V - 2/7' })
    expect(p?.kind).toBe('progress')
    expect(progressNotice({ id: 'p', running: false, auto: false, text: 'x' })).toBeNull()
  })
})

describe('登录与报告', () => {
  it('登录失效 → 常驻告警 + 「去登录」动作', () => {
    const l = loginNotice(true)
    expect(l?.kind).toBe('alert')
    expect(l?.sticky).toBe(true)
    expect(l?.action?.kind).toBe('login')
    expect(loginNotice(false)).toBeNull()
  })

  it('完成报告常驻、带「查看详情」动作', () => {
    const r = reportNotice({ id: 'rep-3', text: '全量帖子抓取完成', detail: '2 处中断' })
    expect(r.kind).toBe('report')
    expect(r.sticky).toBe(true)
    expect(r.action?.kind).toBe('open-report')
  })

  it('瞬时消息带 ttl 过期时刻', () => {
    const m = messageNotice('已收录「塔菲」', 5_000, 4_000)
    expect(m.expiresAt).toBe(9_000)
    expect(m.kind).toBe('message')
  })
})

describe('开播告警（M1，devlog/243）', () => {
  it('是 alert（会影响用户下一步动作），且**带 TTL 而不是常驻**', () => {
    const a = liveNotice({ id: 'live-3', name: '七海Nana7mi', title: '今晚开播', now: 1_000 })
    expect(a.kind).toBe('alert')
    expect(a.text).toBe('七海Nana7mi 开播了')
    expect(a.detail).toBe('今晚开播')
    expect(a.source).toBe('开播')
    // ⚠️ 常驻就等于"开播过的那次一直压住任务进度"（alert 4 > progress 3）——这条是牙口
    expect(a.sticky).toBeUndefined()
    expect(a.expiresAt).toBe(1_000 + LIVE_NOTICE_MS)
    expect(isLive(a, 1_000 + LIVE_NOTICE_MS)).toBe(false)
    expect(isLive(a, 1_000 + LIVE_NOTICE_MS - 1)).toBe(true)
  })

  it('没有标题时不带 detail（别在面板里留一行空说明）', () => {
    const a = liveNotice({ id: 'live-3', name: 'V', now: 0 })
    expect(a.detail).toBeUndefined()
  })

  it('它与进度并存时**压过**进度（alert > progress），到期后让位', () => {
    const now = 10_000
    const live = liveNotice({ id: 'live-3', name: 'V', now, ttlMs: 100 })
    const prog = progressNotice({ id: 'p', running: true, auto: false, text: '抓取中' })!
    expect(pickPrimary([live, prog], now)?.id).toBe('live-3')
    expect(pickPrimary([live, prog], now + 101)?.id).toBe('p')
  })
})

describe('任务文案（P8-C 格式）', () => {
  it('任务名 - V名 - i/N；空段跳过', () => {
    expect(composeTaskText('全量抓取中', '明前奶绿', 1, 11)).toBe('全量抓取中 - 明前奶绿 - 1/11')
    expect(composeTaskText('账号信息抓取中', null, 3, 7)).toBe('账号信息抓取中 - 3/7')
    expect(composeTaskText('帖子抓取中', 'V')).toBe('帖子抓取中 - V')
    expect(composeTaskText('账号信息抓取中', null, 0, 0)).toBe('账号信息抓取中')
  })
})
