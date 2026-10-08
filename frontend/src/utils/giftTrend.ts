/**
 * 直播收益（礼物 / 舰长 / SC）的**数据口径**（需求 5，2026-10-08，`devlog/452`）。
 *
 * 数据来自 `GET /account/{id}/gift-days`（`LiveGiftDay`，zeroroku 的日聚合）。
 * 为什么不写在卡片里：这是"数对不对"的规则（金额怎么解析、缺数据算不算 0、
 * 没有数据时该说什么），能脱离渲染断言 —— 与 `fanTrend.ts` / `events.ts` 同一套路。
 *
 * ⚠️ **金额是字符串且可能是脏的**（后端为保精度原样存上游给的串）：
 * `"1234.56"` / `"1,234"` / `""` / `null` 都出现过。`Number("") === 0`
 * —— 直接转换会把"**这天没有数据**"画成"这天收益 0 元"，而那是一句假话（用户口径
 * 「没有数据的卡片不许显示 0 冒充实测」）。
 */
import type { LiveGiftDay } from '../api/types'

/** 一条**解析后**的日收益（三个分项 + 合计，单位与上游一致：元）。 */
export interface GiftDayPoint {
  date: string
  gift: number
  guard: number
  sc: number
  total: number
  /** 上游给的是哪个源（同一天多源时保留排序里最后一条的源） */
  source: string
}

/**
 * 金额串 → 数字。**解析不出来就 `null`**（不是 0）。
 *
 * 容忍：前后空白、千分位逗号、全角空格、`¥`/`￥` 前缀、`"1.2万"` 这种中文单位（×10000）。
 * 不猜：`""` / `null` / `"-"` / 非数字文本一律 `null`。
 */
export function amountToNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null
  let s = String(raw).trim().replace(/[,，\s\u00a0]/g, '').replace(/^[¥￥]/, '')
  if (!s || s === '-' || s === '--') return null
  let mult = 1
  if (s.endsWith('万')) { mult = 10_000; s = s.slice(0, -1) }
  else if (s.endsWith('亿')) { mult = 100_000_000; s = s.slice(0, -1) }
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return n * mult
}

/** 三个分项里**有没有**任何一个能解析出数字（决定这张卡该画图还是说"没有数据"）。 */
export function hasGiftData(days: LiveGiftDay[]): boolean {
  return days.some((d) =>
    amountToNumber(d.gift_amount) !== null
    || amountToNumber(d.guard_amount) !== null
    || amountToNumber(d.sc_amount) !== null
    || amountToNumber(d.total_amount) !== null)
}

/**
 * 按日期升序归并成绘图点。
 *
 * 三条口径：
 * 1. **同日多源取最后一条**（后端已按日期升序返回；顺序不动它）；
 * 2. **解析不出来的分项算 0**（合计缺省时由三项相加补上）—— 这是"这一项当天没有"，
 *    与"整天没有数据"是两件事（后者由 `hasGiftData` 判定，别在这里混）；
 * 3. `total` 优先用上游给的合计；它缺失或脏时用三项之和兜底（并在测试里钉住这条）。
 */
export function buildGiftPoints(days: LiveGiftDay[]): GiftDayPoint[] {
  const byDate = new Map<string, GiftDayPoint>()
  for (const d of days) {
    const gift = amountToNumber(d.gift_amount) ?? 0
    const guard = amountToNumber(d.guard_amount) ?? 0
    const sc = amountToNumber(d.sc_amount) ?? 0
    const total = amountToNumber(d.total_amount) ?? (gift + guard + sc)
    byDate.set(d.gift_date, { date: d.gift_date, gift, guard, sc, total, source: d.source })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** 卡片头部的一句话（总收益 / 天数 / 最高一天）。空数组 ⇒ `null`（调用方说空态）。 */
export function giftSummary(points: GiftDayPoint[]): {
  total: number
  days: number
  best: { date: string; total: number } | null
} | null {
  if (points.length === 0) return null
  let total = 0
  let best: { date: string; total: number } | null = null
  for (const p of points) {
    total += p.total
    if (!best || p.total > best.total) best = { date: p.date, total: p.total }
  }
  return { total, days: points.length, best }
}

/**
 * 金额显示：`1234.5` → `"1234.5"`、`12345` → `"1.2万"`（中文习惯，与词云/粉丝数同族）。
 * ⚠️ **0 显示成 `"0"`**（不是空）—— "这天是 0 元"是有效信息，与"没有数据"不同。
 */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(2)
}
