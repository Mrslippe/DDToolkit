import { describe, expect, it } from 'vitest'

import type { VTuber } from '../../api/types'
import {
  anniversaryItems, daysUntilNext, nearestAnniversary, parseAnniversary,
} from './anniversary'

/**
 * 纪念日口径（R37-P1，devlog/141）。
 *
 * 锁两件事：① **宽容解析**（`vtubers.birthday` 是自由文本，`2000-05-20` / `5月20日` / `05-20`
 * 都得认）；② **解析不出就说「未记录」**，绝不猜 —— 猜错会给出一个看着很确定的错误倒计时。
 * 所有断言都用**显式传入的 today**（不读系统时间），否则用例会随日期漂。
 */

const mk = (over: Partial<VTuber> = {}): VTuber =>
  ({ id: 1, name: 'V', faction: null, birthday: null, debut_date: null,
     setting: null, avatar: null, background_path: null, notes: null,
     sign_override: null, sign_source_account_id: null,
     created_at: null, updated_at: null, accounts: [], ...over }) as VTuber

describe('parseAnniversary — 宽容解析自由文本', () => {
  it('四种常见写法都认', () => {
    expect(parseAnniversary('2000-05-20')).toEqual({ month: 5, day: 20, year: 2000 })
    expect(parseAnniversary('2000/5/20')).toEqual({ month: 5, day: 20, year: 2000 })
    expect(parseAnniversary('5月20日')).toEqual({ month: 5, day: 20, year: null })
    expect(parseAnniversary('05-20')).toEqual({ month: 5, day: 20, year: null })
    expect(parseAnniversary('2000年5月20日')).toEqual({ month: 5, day: 20, year: 2000 })
  })

  it('空 / 认不出的写法一律 null（不许猜）', () => {
    for (const bad of [null, undefined, '', '   ', '待定', '生日不详', '13-01', '5-32',
                       '2026-13-01', '20 月 1 日']) {
      expect(parseAnniversary(bad as string | null | undefined)).toBeNull()
    }
  })

  it('前后空格不影响', () => {
    expect(parseAnniversary('  5月20日  ')).toEqual({ month: 5, day: 20, year: null })
  })
})

describe('daysUntilNext — 倒计时', () => {
  const today = new Date(2026, 8, 17)      // 2026-09-17（本地）

  it('今天 = 0；明天 = 1', () => {
    expect(daysUntilNext(9, 17, today)).toBe(0)
    expect(daysUntilNext(9, 18, today)).toBe(1)
  })

  it('已经过了的日期 → 算到明年', () => {
    expect(daysUntilNext(9, 16, today)).toBe(364)   // 平年 365 天
    expect(daysUntilNext(1, 1, today)).toBe(106)
  })

  it('跨月跨年边界', () => {
    expect(daysUntilNext(10, 1, today)).toBe(14)
    expect(daysUntilNext(12, 31, today)).toBe(105)
  })

  it('2/29 在平年按 3/1 算（JS 自然进位，不是跳过一年）', () => {
    const y2027 = new Date(2027, 1, 20)          // 2027 平年
    expect(daysUntilNext(2, 29, y2027)).toBe(9)  // 2027-03-01
  })

  it('只看日期不看时刻（同一天几点都是 0）', () => {
    expect(daysUntilNext(9, 17, new Date(2026, 8, 17, 23, 59))).toBe(0)
  })
})

describe('anniversaryItems — 卡片两行', () => {
  const today = new Date(2026, 8, 17)

  it('恒定两枚、顺序固定（行数恒定 = 卡片高度不跳）', () => {
    const items = anniversaryItems(mk(), today)
    expect(items.map((i) => i.key)).toEqual(['birthday', 'debut'])
    expect(items.map((i) => i.label)).toEqual(['生日', '出道'])
  })

  it('没记录 → 「未记录」且 days 为 null', () => {
    const items = anniversaryItems(mk(), today)
    expect(items.map((i) => i.text)).toEqual(['未记录', '未记录'])
    expect(items.map((i) => i.days)).toEqual([null, null])
    expect(nearestAnniversary(items)).toBeNull()
  })

  it('有值 → 「M 月 D 日 · 还有 N 天」，带年份时补「第 N 周年」', () => {
    const items = anniversaryItems(mk({ birthday: '2000-09-20', debut_date: '5月20日' }), today)
    expect(items[0].text).toBe('9 月 20 日 · 还有 3 天 · 第 26 周年')
    expect(items[1].text).toBe('5 月 20 日 · 还有 245 天')
  })

  it('就是今天 → 「就是今天」（不是「还有 0 天」）', () => {
    const items = anniversaryItems(mk({ birthday: '2000-09-17' }), today)
    expect(items[0].text).toBe('9 月 17 日 · 就是今天 · 第 26 周年')
    expect(items[0].days).toBe(0)
  })

  it('年份比下一次还晚（填错）→ 不显示周年数，不显示负数', () => {
    const items = anniversaryItems(mk({ birthday: '2030-09-20' }), today)
    expect(items[0].text).toBe('9 月 20 日 · 还有 3 天')
  })

  it('nearestAnniversary 取最近的那个（都没记录时 null）', () => {
    const items = anniversaryItems(mk({ birthday: '5月20日', debut_date: '9月20日' }), today)
    expect(nearestAnniversary(items)?.key).toBe('debut')
  })
})