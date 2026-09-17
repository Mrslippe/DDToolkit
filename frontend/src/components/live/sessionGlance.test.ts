import { describe, expect, it } from 'vitest'

import type { LiveSession } from '../../api/types'
import { glanceCapsules } from './sessionGlance'

/**
 * 场次速览胶囊的口径（R36，devlog/140）。
 *
 * 锁两件事：
 *   ① **永远四枚、顺序固定** —— 胶囊格数恒定是"弹窗高度不跳"的前提（少一枚就少半行）；
 *   ② 缺值写 `—` 而不是消失/写 0 —— 本仓反复强调「缺席 ≠ 没有」，0 与 null 必须分开。
 * 渲染接线（卡片真出现在左列、高度零变化）由探针 `ui_probe.py --archive` 连采两格守。
 */

/** 只喂本用例关心的字段，其余留空（避免"造了一个完整场次"掩盖取值口径） */
const mk = (p: Partial<LiveSession>): LiveSession =>
  ({ account_id: 1, start_at: '2026-09-17T12:00:00Z', end_at: null,
     duration_minutes: null, live_title: null, ...p }) as LiveSession

describe('glanceCapsules — 四枚一眼值', () => {
  it('顺序固定：时长 · 峰值在线 · 弹幕数 · 收益', () => {
    expect(glanceCapsules(mk({})).map((c) => c.label))
      .toEqual(['时长', '峰值在线', '弹幕数', '收益'])
    expect(glanceCapsules(mk({})).map((c) => c.key))
      .toEqual(['duration', 'peak', 'danmaku', 'income'])
  })

  it('有值时按千分位展示（不缩写，证据库不做概数）', () => {
    const caps = glanceCapsules(mk({
      duration_minutes: 195, max_online_count: 12345,
      danmakus_count: 19461, total_income: 88.5,
    }))
    expect(caps.map((c) => c.value))
      .toEqual(['3小时15分', '12,345', '19,461', '¥88.5'])
  })

  it('缺值一律 `—`（字段缺失、null 都算缺席）', () => {
    expect(glanceCapsules(mk({})).map((c) => c.value)).toEqual(['—', '—', '—', '—'])
    expect(glanceCapsules(mk({ duration_minutes: null, max_online_count: null,
                               danmakus_count: null, total_income: null }))
      .map((c) => c.value)).toEqual(['—', '—', '—', '—'])
  })

  it('三个计数为 0 算 `—`：与右列「直播信息」同一口径（那里也是 `x ? … : \'—\'`）', () => {
    const caps = glanceCapsules(mk({
      max_online_count: 0, danmakus_count: 0, total_income: 0,
    }))
    // 收益是唯一例外：`fmtMoney(0)` 给的是「¥0」——"真的一分没收"与"没取到"要分开
    expect(caps.map((c) => c.value)).toEqual(['—', '—', '—', '¥0'])
  })

  it('收益：null = 没取到（`—`）、0 = 真没收（`¥0`）、非零原样出来', () => {
    expect(glanceCapsules(mk({ total_income: null }))[3].value).toBe('—')
    expect(glanceCapsules(mk({ total_income: 0 }))[3].value).toBe('¥0')
    expect(glanceCapsules(mk({ total_income: 1234.5 }))[3].value).toBe('¥1,234.5')
  })

  it('时长为 0 分钟 = 缺席（刚开播还没算出时长），不显示「0 分」', () => {
    expect(glanceCapsules(mk({ duration_minutes: 0 }))[0].value).toBe('—')
    expect(glanceCapsules(mk({ duration_minutes: 60 }))[0].value).toBe('1小时0分')
    expect(glanceCapsules(mk({ duration_minutes: 45 }))[0].value).toBe('45分')
  })
})
