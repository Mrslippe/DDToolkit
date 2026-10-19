/**
 * 业务时区（东八区）的回归测试（2026-10-20 选 A 之后）。
 *
 * 要点：**客户端的机器时区不参与任何判断**。这里用带 `Z` 的瞬时验证：
 * UTC 16:30 = 北京次日 00:30，必须算到**次日**。
 */

import { describe, expect, it } from 'vitest'

import { cnDateKey, cnDateTime, cnDay, cnTime, cnToday } from './cndate'

describe('cndate · 东八区口径', () => {
  it('UTC 16:30 属于北京次日 00:30', () => {
    expect(cnDay('2026-10-19T16:30:00Z')).toBe('2026-10-20')
    expect(cnTime('2026-10-19T16:30:00Z')).toBe('00:30')
    expect(cnDateTime('2026-10-19T16:30:00Z')).toBe('2026-10-20 00:30')
  })

  it('零点边界：15:59:59Z 是当天 23:59，16:00:00Z 是次日 00:00', () => {
    expect(cnDay('2026-10-19T15:59:59Z')).toBe('2026-10-19')
    expect(cnDay('2026-10-19T16:00:00Z')).toBe('2026-10-20')
  })

  it('纯日期原样返回，不当瞬时解析', () => {
    expect(cnDay('2026-09-04')).toBe('2026-09-04')
    expect(cnDateTime('2026-09-04')).toBe('2026-09-04')
  })

  it('解析不了返回空串（调用方据此丢弃，不拿半截串当日期）', () => {
    expect(cnDay('not-a-time')).toBe('')
    expect(cnDay('')).toBe('')
    expect(cnDay(null)).toBe('')
  })

  it('cnToday 是东八区的今天（与机器时区无关）', () => {
    const t = cnToday()
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // 与用 Z 现算的一致
    expect(t).toBe(cnDay(new Date().toISOString()))
  })

  it('cnDateKey 对 Date 也走东八区', () => {
    expect(cnDateKey(new Date('2026-10-19T16:30:00Z'))).toBe('2026-10-20')
  })
})
