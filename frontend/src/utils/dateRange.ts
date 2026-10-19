/**
 * 时间区间筛选的纯逻辑（P10-A 双月历选择器共用）。
 *
 * 为什么独立成模块：日期算术（本地零点解析 / 月位移夹取 / 预设量纲）是最容易错也最该
 * 被机器验证的部分，而组件层（`components/common/DateRangePicker.tsx`）没有测试运行器可挂。
 * 逻辑放这里 → 可用 esbuild 转译后直接在 Node 里跑断言（见 devlog/050 的验证记录）。
 *
 * 口径约定（与后端 `date_from` / `date_to` 对齐）：
 * - 一律**本地日期**串 `YYYY-MM-DD`，解析走 `parseDate` 而不是 `new Date(str)`
 *   （后者按 UTC 解析，东八区会把 2026-09-01 读成 08-31 16:00 → 日历格整体错一天）；
 * - 空串 = 该端不限制；
 * - 后端把 `date_to` 当「次日零点排他」→ 传当天即含当天。
 */

export interface DateRange {
  from: string
  to: string
}

export const EMPTY_RANGE: DateRange = { from: '', to: '' }

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Date → 本地 `YYYY-MM-DD` */
import { cnToday } from './cndate'

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** `YYYY-MM-DD` → 本地零点 Date；空串/非法格式 → null */
export function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 今天（本地零点；每次调用重取，跨零点自动跟随） */
export function today(): Date {
  // "今天"按**东八区**（与后端分天一致），客户端时区不再影响默认区间
  const [y, mo, dd] = cnToday().split('-').map(Number)
  return new Date(y, mo - 1, dd)
}

/** 年月标识（判「两块面板是否同月」用） */
export function ymKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}`
}

/** 月位移：日号超界时夹到目标月最后一天（03-31 退一月 = 02-28，不是 03-02） */
export function shiftMonths(d: Date, n: number): Date {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate()
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last))
}

export interface RangePreset {
  key: string
  label: string
  /** 往前推的天数（近一周 = 6 → 含今天共 7 天） */
  days?: number
  /** 往前推的月数（近一年 = 12） */
  months?: number
}

/** 预设六枚（参考图底部行）：量纲 = **含今天** */
export const RANGE_PRESETS: RangePreset[] = [
  { key: 'w1', label: '近一周', days: 6 },
  { key: 'm1', label: '近一月', months: 1 },
  { key: 'm3', label: '近三月', months: 3 },
  { key: 'y1', label: '近一年', months: 12 },
  { key: 'y2', label: '近两年', months: 24 },
  { key: 'all', label: '所有' },
]

/** 预设 → 区间（无 days/months 的「所有」= 清空；`base` 可注入以便验证） */
export function presetRange(p: RangePreset, base: Date = today()): DateRange {
  if (p.days != null) {
    return {
      from: fmtDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() - p.days)),
      to: fmtDate(base),
    }
  }
  if (p.months != null) {
    return { from: fmtDate(shiftMonths(base, -p.months)), to: fmtDate(base) }
  }
  return EMPTY_RANGE
}

/** 命中哪个预设（区间与某预设完全相等 → 该预设高亮；空区间 = 「所有」） */
export function matchPreset(r: DateRange, base: Date = today()): string | undefined {
  return RANGE_PRESETS.find((p) => {
    const pr = presetRange(p, base)
    return pr.from === r.from && pr.to === r.to
  })?.key
}

/** 区间文案（空区间 → 空串；两端任一为空的半开态用 … 占位） */
export function rangeText(r: DateRange): string {
  if (!r.from && !r.to) return ''
  return `${r.from || '…'} ~ ${r.to || '…'}`
}

/** 一天一个刻度：生成某月的 6×7 网格（周一为首，含上下月补位），与 LiveCalendar 同口径 */
export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const startWeekday = (first.getDay() + 6) % 7 // 周一 = 0
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - startWeekday)
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

/* ── 墙上时间值 `YYYY-MM-DDTHH:mm` 的拆装（日期+时刻选择器共用，2026-10-13）──────
 *
 * 这个格式就是 `<input type="datetime-local">` 的 value，也是**发给服务端的原样字符串**
 * （后端 `to_utc_naive` 按本机时区换算，见 `components/live/manualSessionForm.ts`）。
 * 自己画的日期+时刻控件要能把它**拆成两段**（日历用日期段、滚轮列用时刻段）再拼回去 ——
 * 拆装错一位，用户看到的就是"我选的 20:00 存成了 08:00"，所以放这里由
 * `scripts/check_date_range.mjs` 钉住，不给组件层留自己拼字符串的机会。
 */

/** 小时档位：`00`–`23` */
export const HOURS: string[] = Array.from({ length: 24 }, (_, i) => pad2(i))

/** 分钟档位：`00`–`59`（**1 分钟一档**）—— 档位少了就填不了 20:07 这种开场时刻 */
export const MINUTES: string[] = Array.from({ length: 60 }, (_, i) => pad2(i))

/** `YYYY-MM-DDTHH:mm` → `{date, time}`；**只有日期**时时刻段补 `00:00`；空/认不出 → null */
export function splitLocal(s: string): { date: string; time: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec((s || '').trim())
  if (!m) return null
  const h = Number(m[2] ?? 0)
  const mi = Number(m[3] ?? 0)
  if (h > 23 || mi > 59) return null
  return { date: m[1], time: `${pad2(h)}:${pad2(mi)}` }
}

/** 两段拼回 `YYYY-MM-DDTHH:mm`（日期段认不出 → 空串；时刻段缺/越界 → `00:00`） */
export function joinLocal(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
  const [h, mi] = (time || '').split(':')
  const ok = (v: string | undefined, max: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 && n <= max ? pad2(Math.trunc(n)) : '00'
  }
  return `${date}T${ok(h, 23)}:${ok(mi, 59)}`
}

/** 显示文案：`2026/10/07 20:00`（空/认不出 → 空串，调用方自己去显示占位） */
export function fmtLocalHuman(s: string): string {
  const sp = splitLocal(s)
  return sp ? `${sp.date.replace(/-/g, '/')} ${sp.time}` : ''
}

