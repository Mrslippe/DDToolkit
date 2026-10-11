/**
 * 「场次类型」卡片的派生（T4，2026-10-12，`devlog/467`）。
 *
 * 这些判据盯的是"界面上看不出对错"的那几件事：顺序有没有被打乱、占比的分母是哪个数、
 * 那句"还有 N 场没定出来"该不该出现。
 */
import { describe, expect, it } from 'vitest'

import { typeBreakdown, unclassifiedNote } from './liveTypeStats'
import type { LiveTypeStats } from '../api/types'

const stats = (over: Partial<LiveTypeStats> = {}): LiveTypeStats => ({
  total: 10,
  classified: 8,
  items: [
    { category: 'chat', count: 5 },
    { category: 'game', count: 3 },
    { category: 'live', count: 2 },
  ],
  ...over,
})

describe('typeBreakdown', () => {
  it('顺序**照抄服务端**（固定展示顺序 ⇒ 卡片每次开都长一样）', () => {
    const rows = typeBreakdown(stats())
    expect(rows.map((r) => r.key)).toEqual(['chat', 'game', 'live'])
  })

  it('计数为 0 的类型不占一行（卡片高度不该随数据跳）', () => {
    const rows = typeBreakdown(stats({
      items: [
        { category: 'chat', count: 5 },
        { category: 'song', count: 0 },
      ],
    }))
    expect(rows.map((r) => r.key)).toEqual(['chat'])
  })

  it('标签走共享映射（与日历胶囊同一个词，不另起一套）', () => {
    const rows = typeBreakdown(stats())
    expect(rows.map((r) => r.label)).toEqual(['杂谈', '游戏', '直播'])
  })

  it('占比的分母是 `total`（日历上能看到的场次总数）', () => {
    // classified=8 但有 10 场可见 ⇒ 5/10 = 50%，而不是 5/8 = 63%
    expect(typeBreakdown(stats()).map((r) => r.percent)).toEqual([50, 30, 20])
  })

  it('未知类型 key 有兜底标签（体系调整期库里可能留着旧值）', () => {
    const rows = typeBreakdown(stats({ items: [{ category: 'sports', count: 1 }] }))
    expect(rows[0].label).toBe('直播')
  })

  it('空/缺字段 ⇒ 空数组（卡片显示空态，不崩）', () => {
    expect(typeBreakdown(null)).toEqual([])
    expect(typeBreakdown(stats({ items: [] }))).toEqual([])
    expect(typeBreakdown(stats({ total: 0, items: [{ category: 'chat', count: 0 }] })))
      .toEqual([])
  })
})

describe('unclassifiedNote', () => {
  it('有差额才说，且说清"差在哪、为什么"', () => {
    const note = unclassifiedNote(stats())
    expect(note).toContain('2 场')          // total 10 - classified 8
    expect(note).toContain('直播')          // 显示成中性的那一个
  })

  it('没有差额 ⇒ null（不写"0 场未分类"这种废话行）', () => {
    expect(unclassifiedNote(stats({ total: 8, classified: 8 }))).toBeNull()
  })

  it('classified 大于 total（理论上不该有）不产生负数说明', () => {
    expect(unclassifiedNote(stats({ total: 3, classified: 5 }))).toBeNull()
  })
})
