/**
 * 日历类型筛选的派生（T4，2026-10-12，`devlog/467`）。
 *
 * 盯的是"屏幕上只差几个数字、而那正是用户拿来做判断的依据"的那类规则。
 */
import { describe, expect, it } from 'vitest'

import { countByType, filterByTypes } from './liveCalendarFilter'
import type { LiveSession } from '../api/types'

const s = (category?: string): LiveSession => ({
  account_id: 1,
  start_at: '2026-09-05T12:00:00Z',
  end_at: null,
  duration_minutes: null,
  live_title: null,
  category,
})

describe('filterByTypes', () => {
  it('空选择 = 不筛，且**返回原引用**（没筛就别造新数组：日历每次刷新都会走这里）', () => {
    const list = [s('song'), s('game')]
    expect(filterByTypes(list, [])).toBe(list)
  })

  it('多选累加（先点游戏再点观影 ⇒ 两类都留）', () => {
    const list = [s('song'), s('game'), s('watch')]
    expect(filterByTypes(list, ['game', 'watch']).map((x) => x.category))
      .toEqual(['game', 'watch'])
  })

  it('★缺 `category` 的场次算「直播」（与服务端 `live` 兜底同一口径）', () => {
    // 服务端总会给 category；这条守的是"前端别把缺字段当成一个空字符串的品类"——
    // 那会让这些场次既不属于任何筛选、又在"全部"里出现，看起来像筛选漏了。
    expect(filterByTypes([s(undefined)], ['live'])).toHaveLength(1)
    expect(filterByTypes([s(undefined)], ['song'])).toHaveLength(0)
  })

  it('筛不出东西 ⇒ 空数组（调用方据此显示"没有这些类型的场次"）', () => {
    expect(filterByTypes([s('song')], ['game'])).toEqual([])
  })
})

describe('countByType', () => {
  const ORDER = ['chat', 'game', 'song', 'live']

  it('按给定顺序排，且 0 场的不出现', () => {
    const out = countByType([s('song'), s('chat'), s('chat')], ORDER)
    expect(out).toEqual([{ key: 'chat', n: 2 }, { key: 'song', n: 1 }])
  })

  it('★顺序来自调用方（本函数不认识品类）——同数据换顺序 ⇒ 跟着换', () => {
    const out = countByType([s('song'), s('chat')], ['song', 'chat'])
    expect(out.map((t) => t.key)).toEqual(['song', 'chat'])
  })

  it('缺 category 计入 `live`（与筛选同一口径，否则"计数里有、筛不出来"）', () => {
    expect(countByType([s(undefined)], ORDER)).toEqual([{ key: 'live', n: 1 }])
  })

  it('order 里没有的类型**不丢**吗？—— 丢，但这是有意的（展示顺序表是唯一真源）', () => {
    // 体系调整期服务端可能给一个刚加的类型：它会在这里被吞掉，直到顺序表也加上它。
    // ⚠️ 这条是**记录当前行为**，不是"设计如此"—— 真加类型时两处都要改
    // （服务端 `live_type.TYPE_DISPLAY_ORDER` + 前端 `liveType.ts::LIVE_TYPE_ORDER`）。
    expect(countByType([s('sports')], ORDER)).toEqual([])
  })

  it('空输入 ⇒ 空（日历显示"本月暂无直播记录"）', () => {
    expect(countByType([], ORDER)).toEqual([])
  })
})
