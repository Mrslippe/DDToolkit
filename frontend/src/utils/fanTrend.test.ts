import { describe, expect, it } from 'vitest'

import { mergeTrendDays, trendSourceLabel } from './fanTrend'

/**
 * R4「自抓取优先」的口径锁（2026-09-13）。
 *
 * 为什么值得测：这条规则错的方向有两个，而且**都不会报错**——
 * ① 同日让第三方盖掉 self ⇒ 自己记的数据白记（改动前的实际行为）；
 * ② 全局优先 self ⇒ 2019 年以来的第三方历史整段消失。
 * 两者都只能在图上"看起来怪"，所以在这里断死。
 */
describe('mergeTrendDays：同日 self 优先、第三方只补空洞', () => {
  it('同一天两者都有 → 取 self（第三方不得覆盖）', () => {
    const days = mergeTrendDays([
      { date: '2026-09-10', fans: 1000, source: 'self' },
      { date: '2026-09-10', fans: 900, source: 'zeroroku' },   // 后端按 (date, source) 升序
    ])
    expect(days).toHaveLength(1)
    expect(days[0]).toMatchObject({ date: '2026-09-10', fans: 1000, source: 'self' })
  })

  it('第三方在前、self 在后也取 self（与输入顺序无关）', () => {
    const days = mergeTrendDays([
      { date: '2026-09-10', fans: 900, source: 'zeroroku' },
      { date: '2026-09-10', fans: 1000, source: 'self' },
    ])
    expect(days[0].fans).toBe(1000)
    expect(days[0].source).toBe('self')
  })

  it('self 缺失的日子由第三方补（历史不丢）', () => {
    const days = mergeTrendDays([
      { date: '2019-07-01', fans: 100, source: 'zeroroku' },
      { date: '2026-09-10', fans: 1000, source: 'self' },
    ])
    expect(days.map((d) => [d.date, d.fans, d.source])).toEqual([
      ['2019-07-01', 100, 'zeroroku'],
      ['2026-09-10', 1000, 'self'],
    ])
  })

  it('同日多条 self → 取最后一条（后端按时间升序给点）', () => {
    const days = mergeTrendDays([
      { date: '2026-09-10', fans: 1000, source: 'self' },
      { date: '2026-09-10', fans: 1005, source: 'self' },
    ])
    expect(days[0].fans).toBe(1005)
  })

  it('日增按合并后的序列算（跨源接续，不出现假跳变）', () => {
    const days = mergeTrendDays([
      { date: '2019-07-01', fans: 100, source: 'zeroroku' },
      { date: '2026-09-10', fans: 1000, source: 'self' },
      { date: '2026-09-11', fans: 1010, source: 'self' },
    ])
    expect(days.map((d) => d.delta)).toEqual([null, 900, 10])
  })

  it('空输入 / 坏点不炸', () => {
    expect(mergeTrendDays([])).toEqual([])
    expect(mergeTrendDays([
      { date: '', fans: 1, source: 'self' },
      { date: '2026-09-10', fans: 7, source: 'self' },
    ]).map((d) => d.date)).toEqual(['2026-09-10'])
  })
})

describe('trendSourceLabel：卡片来源标注（R3）', () => {
  const mk = (sources: string[]) =>
    mergeTrendDays(sources.map((s, i) => ({
      date: `2026-09-${String(10 + i).padStart(2, '0')}`, fans: 1, source: s,
    })))

  it('两种源都有 → 双源文案', () => {
    expect(trendSourceLabel(mk(['zeroroku', 'self']))).toBe('本地快照 + 第三方回填')
  })
  it('只有 self / 只有第三方 / 空', () => {
    expect(trendSourceLabel(mk(['self']))).toBe('本地快照')
    expect(trendSourceLabel(mk(['zeroroku']))).toBe('第三方回填')
    expect(trendSourceLabel([])).toBe('暂无数据')
  })
})
