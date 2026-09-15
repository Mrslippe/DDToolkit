import { describe, expect, it } from 'vitest'
import type { UpcomingReservation } from '../api/types'
import { cellBadge, groupReservationsByDay, reservationLine } from './reservationDays'

const res = (over: Partial<UpcomingReservation> = {}): UpcomingReservation => ({
  post_id: 1,
  title: '周四歌回',
  start_at: '2026-09-17T21:00:00',
  reserve_total: 128,
  rid: null,
  ...over,
})

describe('按天分组', () => {
  it('同名格键与场次口径一致；组内按时刻升序', () => {
    const m = groupReservationsByDay([
      res({ post_id: 2, start_at: '2026-09-17T22:30:00' }),
      res({ post_id: 1, start_at: '2026-09-17T21:00:00' }),
      res({ post_id: 3, start_at: '2026-09-18T20:00:00' }),
    ])
    expect([...m.keys()].sort()).toEqual(['2026-09-17', '2026-09-18'])
    expect(m.get('2026-09-17')!.map((r) => r.post_id)).toEqual([1, 2])
  })

  it('时刻解析不了的条目被丢弃（不让界面出现空行）', () => {
    const m = groupReservationsByDay([res({ start_at: 'not-a-date' })])
    expect(m.size).toBe(0)
  })
})

describe('格子徽章优先级', () => {
  it('有场次 → 类型标签（预约不抢）', () => {
    expect(cellBadge({ hasSession: true, typeLabel: '游戏', hasReservation: true, isPast: false }))
      .toBe('游戏')
  })

  it('无场次但有预约 → 「预约」，**不显示待定/休息**', () => {
    expect(cellBadge({ hasSession: false, typeLabel: '', hasReservation: true, isPast: false }))
      .toBe('预约')
    // 已过去的日子也一样：预约信息比"休息"更有价值（服务端本就不该给过期预约）
    expect(cellBadge({ hasSession: false, typeLabel: '', hasReservation: true, isPast: true }))
      .toBe('预约')
  })

  it('都没有 → 今天以前休息 / 今天及以后待定', () => {
    expect(cellBadge({ hasSession: false, typeLabel: '', hasReservation: false, isPast: true }))
      .toBe('休息')
    expect(cellBadge({ hasSession: false, typeLabel: '', hasReservation: false, isPast: false }))
      .toBe('待定')
  })
})

describe('展示行', () => {
  it('取最早一条，多条给「另有 N 条」', () => {
    const one = reservationLine([res({ start_at: '2026-09-17T21:05:00' })])
    expect(one?.time).toBe('21:05')
    expect(one?.title).toBe('周四歌回')
    expect(one?.more).toBe('')

    const two = reservationLine([
      res({ start_at: '2026-09-17T21:05:00' }),
      res({ post_id: 2, start_at: '2026-09-17T23:00:00' }),
    ])
    expect(two?.time).toBe('21:05')
    expect(two?.more).toBe('另有 1 条')
  })

  it('标题缺失给「预约」兜底（不出现空白标题）', () => {
    expect(reservationLine([res({ title: '' })])?.title).toBe('预约')
  })

  it('计数槽放**预约人数**（不重复"预约"二字）；人数未知时留空', () => {
    expect(reservationLine([res({ reserve_total: 128 })])?.totalLabel).toBe('128 人预约')
    expect(reservationLine([res({ reserve_total: 12345 })])?.totalLabel).toBe('12,345 人预约')
    expect(reservationLine([res({ reserve_total: 0 })])?.totalLabel).toBe('')
  })

  it('空数组 → null（调用方据此不渲染预约行）', () => {
    expect(reservationLine([])).toBeNull()
  })
})
