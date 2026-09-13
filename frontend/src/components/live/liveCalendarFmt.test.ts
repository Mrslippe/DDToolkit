import { describe, expect, it } from 'vitest'

import {
  dayKeyIso,
  fmtDur,
  fmtMoney,
  fmtMonth,
  fmtTime,
  isFreshSession,
  keyOf,
} from './liveCalendarFmt'

/**
 * 直播日历的纯展示格式化（P2 分层收敛 A 批次从 `LiveCalendar.tsx` 搬出）。
 * 锁的是**用户在日历/详情弹窗上直接看到的文本**与两个真实边界：
 *   - `dayKeyIso` 必须走**本地**日期（`new Date('YYYY-MM-DD')` 按 UTC 解析会错一天）；
 *   - `isFreshSession` 是「暂无弹幕」与「真没弹幕」两种文案的分流判据。
 * 时间相关断言一律用本地取值反推期望，避免 CI 时区差异造成假失败。
 */

describe('dayKeyIso — 本地日期 key（不得走 UTC）', () => {
  it('补零且顺序为 YYYY-MM-DD', () => {
    expect(dayKeyIso(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dayKeyIso(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('当月 1 日与月末都不越界', () => {
    expect(dayKeyIso(new Date(2026, 1, 1))).toBe('2026-02-01')
    expect(dayKeyIso(new Date(2024, 1, 29))).toBe('2024-02-29')   // 闰年
  })

  it('本地时区口径：与本地 getFullYear/getMonth/getDate 一致', () => {
    // 若实现改用 toISOString()，东八区的凌晨会退到前一天 —— 这条会红
    const d = new Date(2026, 8, 13, 0, 30)   // 本地 00:30
    const p = (n: number) => String(n).padStart(2, '0')
    expect(dayKeyIso(d)).toBe(
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    )
    expect(dayKeyIso(d)).toBe('2026-09-13')
  })
})

describe('fmtMonth — 月份胶囊文字（m 为 0-based）', () => {
  it('补零到两位月', () => {
    expect(fmtMonth(2026, 0)).toBe('2026年01月')
    expect(fmtMonth(2026, 8)).toBe('2026年09月')
    expect(fmtMonth(2026, 11)).toBe('2026年12月')
  })
})

describe('fmtTime — HH:MM', () => {
  it('补零', () => {
    expect(fmtTime(new Date(2026, 8, 13, 9, 5))).toBe('09:05')
    expect(fmtTime(new Date(2026, 8, 13, 20, 31))).toBe('20:31')
    expect(fmtTime(new Date(2026, 8, 13, 0, 0))).toBe('00:00')
  })

  it('非法日期 → 占位而不是 NaN:NaN', () => {
    expect(fmtTime(new Date('nope'))).toBe('--:--')
  })
})

describe('fmtDur — 时长', () => {
  it('不足 1 小时只显示分钟', () => {
    expect(fmtDur(1)).toBe('1分')
    expect(fmtDur(59)).toBe('59分')
  })

  it('满 1 小时显示「N小时M分」', () => {
    expect(fmtDur(60)).toBe('1小时0分')
    expect(fmtDur(192)).toBe('3小时12分')
  })

  it('空值与小于 1 分钟 → 空串（调用方据此省略括号）', () => {
    expect(fmtDur(null)).toBe('')
    expect(fmtDur(undefined)).toBe('')
    expect(fmtDur(0)).toBe('')
    expect(fmtDur(-5)).toBe('')
  })
})

describe('fmtMoney — 金额', () => {
  it('带 ¥ 与千分位', () => {
    expect(fmtMoney(10501.5)).toBe('¥10,501.5')
    expect(fmtMoney(0)).toBe('¥0')
  })

  it('空值 → 空串（调用方回退「—」）', () => {
    expect(fmtMoney(null)).toBe('')
    expect(fmtMoney(undefined)).toBe('')
  })
})

describe('keyOf — 服务端分类优先，缺失才前端兜底', () => {
  const base = { live_title: '随便聊聊' } as never

  it('有 category 时直接用服务端值（不覆盖服务端判定）', () => {
    expect(keyOf({ ...(base as object), category: 'song' } as never)).toBe('song')
  })

  it('category 为空时按标题关键词兜底', () => {
    // 规则逐条来自 `utils/liveType.ts` 的 RULES（含关键词才命中，不要凭"看起来像"）
    expect(keyOf({ ...(base as object), category: null, live_title: '周六来唱歌！' } as never)).toBe('song')
    expect(keyOf({ ...(base as object), category: null, live_title: '杂谈一下' } as never)).toBe('chat')
    expect(keyOf({ ...(base as object), category: null, live_title: '一起看苹果发布会' } as never)).toBe('live')
    expect(keyOf({ ...(base as object), category: null, live_title: '生日快乐歌回' } as never)).toBe('special')
  })

  it('兜底词库的真实边界：「一起看苹果发布会」落回 live（观影规则要「一起看一部」）', () => {
    // 实测库里的标题形态：`一起看！` / `一起看苹果发布会` 都不命中 RULES 的观影条目
    // （`utils/liveType.ts` 的 watch 规则含「一起看一部/看片/观影/电影/番剧…」），
    // 于是前端兜底给 `live`。这是**记录既有行为**，不是认可它 ——
    // 真实数据里这些场次的类型由**服务端 category**（9 类引擎）给出，前端兜底只在服务端缺失时生效。
    expect(keyOf({ ...(base as object), category: null, live_title: '一起看苹果发布会' } as never)).toBe('live')
    expect(keyOf({ ...(base as object), category: null, live_title: '一起看！' } as never)).toBe('live')
    // 命中观影规则的写法（对照）
    expect(keyOf({ ...(base as object), category: null, live_title: '一起看一部电影' } as never)).toBe('watch')
  })

  it('兜底也认不出时回落到 live', () => {
    expect(keyOf({ ...(base as object), category: null, live_title: 'zzz' } as never)).toBe('live')
    expect(keyOf({ ...(base as object), category: null, live_title: null } as never)).toBe('live')
  })
})

describe('isFreshSession — 「刚结束」判据（文案分流）', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString()

  it('刚结束（未满 24h）为真', () => {
    expect(isFreshSession(hoursAgo(1), hoursAgo(0.5))).toBe(true)
    expect(isFreshSession(hoursAgo(23), hoursAgo(23.5))).toBe(true)
  })

  it('超过 24h 为假（此时「暂无弹幕」才算异常）', () => {
    expect(isFreshSession(hoursAgo(30), hoursAgo(25))).toBe(false)
    expect(isFreshSession(hoursAgo(240), hoursAgo(239))).toBe(false)
  })

  it('未结束（end 为空）时按开始时间判', () => {
    expect(isFreshSession(hoursAgo(2), null)).toBe(true)
    expect(isFreshSession(hoursAgo(48), null)).toBe(false)
    expect(isFreshSession(hoursAgo(2), undefined)).toBe(true)
  })

  it('非法时间串 → 假（不误判成「刚结束」）', () => {
    expect(isFreshSession('nope', 'nope')).toBe(false)
    expect(isFreshSession('', '')).toBe(false)
  })
})
