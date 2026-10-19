/**
 * 直播日历的**时间口径**（2026-10-20 起：业务时区 = 东八区）。
 *
 * ## 为什么不再用"本地时区"
 *
 * 之前这里把 `start_at` 当"北京 wall-clock（naive）"，用 `new Date(s)` 按**客户端本地时区**
 * 解析 —— 在东八区客户端上恰好正确，一旦客户端在别的时区，同一场直播会被算到**不同的日子**，
 * 与后端（按东八区分天）的格子对不上：热力图说这天 3 场，日历把它们排到前一天。
 *
 * 现在的规则（与 `docs/analysis/analysis-model.md` §1.4 一致）：
 * - **时间点**（带 `Z`/偏移的 ISO）→ 换算到 `Asia/Shanghai` 再取年月日时分；
 * - **纯日期**（`YYYY-MM-DD`）→ 原样使用，绝不当瞬时解析；
 * - **"今天"** → 东八区的今天，不是客户端时区的今天。
 */

const CN_TZ = 'Asia/Shanghai'

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export { DATE_ONLY }

const pad = (n: number) => String(n).padStart(2, '0')

/** 东八区的年/月/日/时/分。`null` = 解析不了（调用方决定怎么兜底）。 */
export function cnParts(iso: string | null | undefined):
{ y: number; mo: number; d: number; h: number; mi: number } | null {
  if (!iso) return null
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: CN_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]))
  let h = Number(p.hour)
  if (h === 24) h = 0          // 某些 ICU 版本把午夜给成 24
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h, mi: Number(p.minute) }
}

/** 时间点 → **东八区** `yyyy-MM-dd`。纯日期原样返回。 */
export function cnDay(iso: string | null | undefined): string {
  if (!iso) return ''
  if (DATE_ONLY.test(iso)) return iso
  const p = cnParts(iso)
  // 解析不了就返回空串 —— 调用方据此丢弃该条目，而不是拿半截串当日期
  return p ? `${p.y}-${pad(p.mo)}-${pad(p.d)}` : ''
}

/** 时间点 → **东八区** `yyyy-MM-dd HH:mm`。纯日期原样返回。 */
export function cnDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  if (DATE_ONLY.test(iso)) return iso
  const p = cnParts(iso)
  return p ? `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}` : iso
}

/** 时间点 → **东八区** `HH:mm`。 */
export function cnTime(iso: string | null | undefined): string {
  const p = cnParts(iso)
  return p ? `${pad(p.h)}:${pad(p.mi)}` : ''
}

/** **东八区的今天** `yyyy-MM-dd`（客户端在哪个时区都不影响）。 */
export function cnToday(): string {
  return cnDay(new Date().toISOString())
}

/** `Date`（纯日期语义）→ `yyyy-MM-dd`；用东八区解释，避免负时差地区回退一天。 */
export function cnDateKey(d: Date): string {
  return cnDay(d.toISOString())
}
