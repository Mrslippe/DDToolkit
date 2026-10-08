/**
 * 直播收益口径（`devlog/452`）—— 每条判据对着一个**会静默出错**的地方。
 *
 * 最要紧的一条是 `amountToNumber`：它是"脏字符串 → 数字"的唯一入口，
 * 而那些串直接来自上游（`"1,234"` / `""` / `null` / `"1.2万"`）。
 * 判错的后果不是崩溃，是**把"没有数据"画成"0 元"**（用户口径明确不许）。
 */
import { describe, expect, it } from 'vitest'

import type { LiveGiftDay } from '../api/types'
import {
  amountToNumber, buildGiftPoints, formatAmount, giftSummary, hasGiftData,
} from './giftTrend'

function day(date: string, over: Partial<LiveGiftDay> = {}): LiveGiftDay {
  return {
    id: 1, account_id: 1, source: 'zeroroku', gift_date: date,
    gift_amount: null, guard_amount: null, sc_amount: null, total_amount: null,
    room_id: null, created_at: null, ...over,
  }
}

describe('金额解析：解析不出来就是 null，不是 0', () => {
  it('★ 空串 / null / 破折号 ⇒ null（不是 0）—— 否则"没有数据"会变成"0 元"', () => {
    for (const raw of ['', '   ', null, undefined, '-', '--', '暂无', 'abc']) {
      expect(amountToNumber(raw as string | null | undefined), `raw=${String(raw)}`).toBeNull()
    }
  })

  it('容忍真实上游的那些写法：千分位、全角空格、货币符号、中文单位', () => {
    expect(amountToNumber('1234')).toBe(1234)
    expect(amountToNumber('1234.56')).toBeCloseTo(1234.56)
    expect(amountToNumber('1,234')).toBe(1234)
    expect(amountToNumber('１，２３４'.replace(/１/g, '1').replace(/２/g, '2').replace(/３/g, '3').replace(/４/g, '4'))).toBe(1234)
    expect(amountToNumber('  ¥ 1 234 ')).toBe(1234)
    expect(amountToNumber('1.2万')).toBe(12_000)
    expect(amountToNumber('0')).toBe(0)
  })

  it('0 与 null 是**两件事**（0 是有效信息，null 是没数据）', () => {
    expect(amountToNumber('0')).toBe(0)
    expect(amountToNumber('')).toBeNull()
  })
})

describe('有没有数据 / 归并成绘图点', () => {
  it('★ 全空 ⇒ hasGiftData 为假（卡片说"没有数据"而不是画一条 0 线）', () => {
    expect(hasGiftData([])).toBe(false)
    expect(hasGiftData([day('2026-10-01'), day('2026-10-02')])).toBe(false)
    // 正对照：只有**一个**分项有值也算有数据
    expect(hasGiftData([day('2026-10-01'), day('2026-10-02', { sc_amount: '30' })])).toBe(true)
  })

  it('按日期升序；同日多源取最后一条', () => {
    const pts = buildGiftPoints([
      day('2026-10-02', { gift_amount: '10', source: 'zeroroku' }),
      day('2026-10-01', { gift_amount: '5', source: 'zeroroku' }),
      day('2026-10-02', { gift_amount: '20', source: 'other' }),
    ])
    expect(pts.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-02'])
    expect(pts[1].gift).toBe(20)
    expect(pts[1].source).toBe('other')
  })

  it('★ 分项脏值算 0，但**合计缺失时用三项之和兜底**（否则合计列永远是 0）', () => {
    const [p] = buildGiftPoints([day('2026-10-01', {
      gift_amount: '10', guard_amount: '呵呵', sc_amount: '2.5',
    })])
    expect([p.gift, p.guard, p.sc]).toEqual([10, 0, 2.5])
    expect(p.total).toBeCloseTo(12.5)
    // 上游给了合计就**以它为准**（三个分项可能只覆盖一部分）
    const [q] = buildGiftPoints([day('2026-10-01', {
      gift_amount: '10', guard_amount: '0', sc_amount: '0', total_amount: '99',
    })])
    expect(q.total).toBe(99)
  })
})

describe('汇总与显示', () => {
  it('合计 / 天数 / 最高一天；空 ⇒ null', () => {
    expect(giftSummary([])).toBeNull()
    const s = giftSummary(buildGiftPoints([
      day('2026-10-01', { total_amount: '10' }),
      day('2026-10-02', { total_amount: '30' }),
      day('2026-10-03', { total_amount: '5' }),
    ]))
    expect(s).toEqual({ total: 45, days: 3, best: { date: '2026-10-02', total: 30 } })
  })

  it('金额显示：整数原样、小数两位、上万走"万"，非法值给破折号', () => {
    expect(formatAmount(0)).toBe('0')
    expect(formatAmount(1234)).toBe('1234')
    expect(formatAmount(12.5)).toBe('12.50')
    expect(formatAmount(12345)).toBe('1.2万')
    expect(formatAmount(NaN)).toBe('—')
  })
})
