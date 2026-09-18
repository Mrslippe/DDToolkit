import { describe, expect, it } from 'vitest'

import type { VtuberEvent } from '../../api/types'
import { eventChip, eventHint, eventItems, timelineNodes } from './events'
import type { EventItem } from './events'

/**
 * 「大事记」口径（R37-P3，devlog/145）。
 *
 * 三条值得钉：① **未来在前、过去的在后**（卡片是"接下来要发生什么"的提醒位）；
 * ② `YYYY-MM-DD` 必须按**本地**日期解析（走 UTC 会退一天 —— liveCalendarFmt 踩过的坑）；
 * ③ 脏数据（空/格式不对）跳过而不是崩、也不是编一个日期出来。
 */

const ev = (id: number, title: string, date: string): VtuberEvent =>
  ({ id, vtuber_id: 1, title, event_date: date, kind: 'event', emoji: null, created_at: null })

const TODAY = new Date(2026, 8, 17)      // 2026-09-17 本地

describe('eventItems — 排序与文案', () => {  it('未来在前（近的优先），过去的在后（近的优先）', () => {
    const items = eventItems([
      ev(1, '去年的演唱会', '2025-12-01'),
      ev(2, '下周歌回', '2026-09-24'),
      ev(3, '明天直播', '2026-09-18'),
      ev(4, '上个月联动', '2026-08-20'),
    ], TODAY)
    expect(items.map((i) => i.title)).toEqual(['明天直播', '下周歌回', '上个月联动', '去年的演唱会'])
    expect(items.map((i) => i.days)).toEqual([1, 7, -28, -290])
  })

  it('今天 = 「今天」（不是「还有 0 天」）', () => {
    const [it0] = eventItems([ev(1, '今天生日会', '2026-09-17')], TODAY)
    expect(it0.when).toBe('今天')
    expect(it0.days).toBe(0)
  })

  it('过去的写「N 天前」', () => {
    expect(eventItems([ev(1, '过去', '2026-09-07')], TODAY)[0].when).toBe('10 天前')
  })

  it('limit 生效（默认 4）', () => {
    const many = Array.from({ length: 7 }, (_, i) => ev(i, `活动${i}`, '2026-10-01'))
    expect(eventItems(many, TODAY)).toHaveLength(4)
    expect(eventItems(many, TODAY, 7)).toHaveLength(7)
  })

  it('按**本地**日期解析：不因时区退一天', () => {
    // 若实现用 new Date('2026-09-17')（UTC），东八区会算成 9-16 ⇒ days = -1
    expect(eventItems([ev(1, '当天', '2026-09-17')], TODAY)[0].days).toBe(0)
  })

  it('脏数据跳过（空串 / 少位 / 非日期），不崩也不编', () => {
    const items = eventItems([
      ev(1, '坏的1', ''),
      ev(2, '坏的2', '2026-9-1'),
      ev(3, '坏的3', '下周三'),
      ev(4, '好的', '2026-09-20'),
    ], TODAY)
    expect(items.map((i) => i.title)).toEqual(['好的'])
  })

  it('空列表 → 空（卡片显示空态）', () => {
    expect(eventItems([], TODAY)).toEqual([])
  })
})

describe('eventHint — 头部说明要如实', () => {
  it('没有条目就说还没有记录', () => {
    expect(eventHint([])).toBe('还没有记录大事记')
  })

  it('有未来的：报「将至」条数（还有已过时补一句）', () => {
    const items = eventItems([
      ev(1, '将来', '2026-09-20'), ev(2, '过去', '2026-09-01'),
    ], TODAY)
    expect(eventHint(items)).toBe('1 条将至 · 1 条已过')
    expect(eventHint(eventItems([ev(1, '将来', '2026-09-20')], TODAY))).toBe('1 条将至')
  })

  it('全是过去的：说清"都是回顾"（不是"没数据"）', () => {
    expect(eventHint(eventItems([ev(1, '过去', '2026-09-01')], TODAY))).toBe('1 条已过 · 都是回顾')
  })
})

/**
 * 行尾 chip（R37-P4a，规格 §4.3）。
 *
 * chip 是**行尾的视觉锚点**：文案要比 `when` 短（"13 天后" 而不是 "还有 13 天"），
 * 色调由这里一次判定（视图只负责画，不再自己 `days > 0` 判一遍 —— 判据只留一份）。
 */
describe('eventChip — 行尾那枚 chip', () => {
  const chipOf = (date: string) => eventChip(eventItems([ev(1, 'x', date)], TODAY)[0])

  it('今天 → 强调色调', () => {
    expect(chipOf('2026-09-17')).toEqual({ text: '今天', tone: 'today' })
  })

  it('未来 → 「N 天后」+ 未来色调', () => {
    expect(chipOf('2026-09-24')).toEqual({ text: '7 天后', tone: 'future' })
  })

  it('已过 → 「N 天前」+ 灰调（不是负号数字）', () => {
    expect(chipOf('2026-09-07')).toEqual({ text: '10 天前', tone: 'past' })
  })

  it('边界：明天是 future、昨天是 past（今天不算未来也不是过去）', () => {
    expect(chipOf('2026-09-18').tone).toBe('future')
    expect(chipOf('2026-09-16').tone).toBe('past')
  })
})

/** R42（用户 2026-09-19）：「大事记用这种**时间轴**的形式来呈现」—— 刻度按**日期**等距铺开 */
describe('timelineNodes — 时间轴刻度', () => {
  const mk = (id: number, days: number): EventItem =>
    ({ id, title: `E${id}`, date: '2026-01-01', days, when: '' })

  it('按日期等距：最早的在 0、最晚的在 1', () => {
    const ns = timelineNodes([mk(1, -10), mk(2, 0), mk(3, 10)])
    expect(ns.map((n) => n.t)).toEqual([0, 0.5, 1])
  })

  it('只有一条 ⇒ 居中（贴左边缘看着像渲染坏了）', () => {
    expect(timelineNodes([mk(1, 5)])[0].t).toBe(0.5)
  })

  it('全部同一天 ⇒ 都居中（span=0 不许除零）', () => {
    expect(timelineNodes([mk(1, 3), mk(2, 3)]).map((n) => n.t)).toEqual([0.5, 0.5])
  })

  it('未来的点标 future（组件据此画实心点）', () => {
    const ns = timelineNodes([mk(1, -1), mk(2, 1)])
    expect(ns.map((n) => n.future)).toEqual([false, true])
  })

  it('空数组 ⇒ 空（不炸）', () => {
    expect(timelineNodes([])).toEqual([])
  })
})