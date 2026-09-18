/**
 * 纪念日口径（R37-P1，devlog/141）—— 「纪念日」卡片的全部判断，纯函数可单测。
 *
 * ⚠️ `vtubers.birthday / debut_date` 在库里是**自由文本**（档案设置里手填、无格式校验；
 * 2026-09-17 实测开发库里 8 个 V 全为空）⇒ 必须容忍常见写法，**解析不出就如实说「未记录」**。
 * 猜错比不显示更糟：一个看着很确定的错误倒计时，用户没有任何线索能发现它是错的。
 */
import type { VTuber } from '../../api/types'

export interface AnniversaryDate {
  month: number
  day: number
  /** 年份（写了才有）：用来算"第 N 个生日 / 出道 N 周年" */
  year: number | null
}

const CN = /^(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/
const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/
const MD = /^(\d{1,2})[-/.](\d{1,2})$/

/** 解析纪念日文本 → `{month, day, year?}`；解析不出返回 `null`（调用方显示「未记录」）。 */
export function parseAnniversary(raw: string | null | undefined): AnniversaryDate | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  // ⚠️ 不能拿 `m.length` 判"有没有年份"：可选组缺席时 `m[1]` 是 `undefined`，
  // `Number(undefined)` 会静默变成 NaN（第一版就这么错的，被单测当场抓住）。
  const full = CN.exec(s) ?? ISO.exec(s)
  const md = full ? null : MD.exec(s)
  if (!full && !md) return null
  const year = full?.[1] == null ? null : Number(full[1])
  const month = Number(full ? full[2] : md![1])
  const day = Number(full ? full[3] : md![2])
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null
  return { month, day, year }
}

/** 当天零点（只比日期，不比时刻 —— 否则"今天"会因为几小时而算成明天）。 */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 下一次周年的**日期**（内部共用；2/29 在平年由 JS 自然进位成 3/1）。 */
function nextOccurrence(month: number, day: number, today: Date): Date {
  const t0 = startOfDay(today)
  const mk = (y: number) => new Date(y, month - 1, day)
  const first = mk(t0.getFullYear())
  return first.getTime() < t0.getTime() ? mk(t0.getFullYear() + 1) : first
}

/**
 * 距离**下一次**周年还有几天（0 = 就是今天）。
 *
 * 2 月 29 日在平年按 **3 月 1 日**算（JS `Date` 的自然进位）：写 2/29 的人要的是
 * "那天"，平年没有那天时给最近的一天，比跳过一年更合理。
 */
export function daysUntilNext(month: number, day: number, today: Date): number {
  const t0 = startOfDay(today)
  return Math.round((nextOccurrence(month, day, today).getTime() - t0.getTime()) / 86400000)
}

export interface AnniversaryItem {
  /** `birthday` / `debut` 是内置两行；R42 起用户自定义条目是 `custom-<id>` */
  key: string
  label: string
  /** 卡片上那一行文本（解析不出 = 「未记录」） */
  text: string
  /** 距离下一次还有几天；解析不出 = null */
  days: number | null
  /** 原文（供 title 提示 / 排错） */
  raw: string | null
  /** 月/日（`3/14`）；解析不出 = null —— R37-P4a 起行内展示用它，**不再从 text 里反解** */
  md: string | null
  /** 第几周年（缺年份 = 0）；hero 之外那行的事实部分 */
  nth: number
  /**
   * 行内右侧那截"事实"文本（R42 起**跟着条目走**，不再用平行数组 `anniversaryFacts(items)[i]`）。
   * 平行数组在"用户自定义条目"加进来之后就会错位 —— 那是只有肉眼能发现的错。
   */
  fact: string
  /** 自定义图标（R42；内置两行没有） */
  emoji?: string | null
}

function item(key: string, label: string, raw: string | null | undefined,
              today: Date, emoji?: string | null): AnniversaryItem {
  const parsed = parseAnniversary(raw)
  if (!parsed) {
    return { key, label, text: '未记录', days: null, raw: raw ?? null, md: null, nth: 0,
             fact: '未记录', emoji: emoji ?? null }
  }
  const next = nextOccurrence(parsed.month, parsed.day, today)
  const days = daysUntilNext(parsed.month, parsed.day, today)
  const nth = parsed.year != null ? next.getFullYear() - parsed.year : 0
  const md = `${parsed.month} 月 ${parsed.day} 日`
  const when = days === 0 ? '就是今天' : `还有 ${days} 天`
  return {
    key, label,
    text: `${md} · ${when}${nth > 0 ? ` · 第 ${nth} 周年` : ''}`,
    days, raw: raw ?? null,
    md: `${parsed.month}/${parsed.day}`, nth,
    // 行内事实：`3/14`（缺年份不加周年）
    fact: `${parsed.month}/${parsed.day}${nth > 0 ? ` · 第 ${nth} 周年` : ''}`,
    emoji: emoji ?? null,
  }
}

/** 两枚纪念日（生日 / 出道）；顺序固定 —— 卡片行数恒定是"高度不跳"的前提。 */
export function anniversaryItems(v: VTuber, today: Date = new Date()): AnniversaryItem[] {
  return [
    item('birthday', '生日', v.birthday, today),
    item('debut', '出道', v.debut_date, today),
  ]
}

/** 卡片头部的"最近一个纪念日"提示（两枚都没有 → null）。 */
export function nearestAnniversary(items: AnniversaryItem[]): AnniversaryItem | null {
  const dated = items.filter((i) => i.days != null) as (AnniversaryItem & { days: number })[]
  if (!dated.length) return null
  return dated.reduce((a, b) => (b.days < a.days ? b : a))
}

/**
 * 卡面 hero（R37-P4a，规格 `docs/design-archive-cards.md` §4.1）—— 大数字那一块。
 *
 * 为什么把它从 hint 里升上来：原来"最近的一个 · 还有 12 天"被埋在卡片最后一行小字里，
 * 而它其实是这张卡**唯一在倒数**的信息 —— 卡片的价值就在"还有多久"。
 *
 * **没有可信数字就返回 null**（视图不放 hero，而不是放一个 `—` 占位）：
 * 摆一个空的数字位会让人以为"有数据但没显示出来"，那正是我们要避免的静默失败。
 */
export interface AnniversaryHero {
  /** 大数字（今天 → 「今天」） */
  value: string
  /** 紧跟数字的单位（今天 → 空串） */
  unit: string
  /** 数字下面那句人话 */
  caption: string
  /** 来源项目（生日 / 出道） */
  key: AnniversaryItem['key']
}

export function anniversaryHero(items: AnniversaryItem[]): AnniversaryHero | null {
  const nearest = nearestAnniversary(items)
  if (!nearest || nearest.days == null) return null
  return nearest.days === 0
    ? { value: '今天', unit: '', caption: `就是${nearest.label}`, key: nearest.key }
    : { value: String(nearest.days), unit: '天', caption: `距离${nearest.label}`, key: nearest.key }
}

/**
 * hero 之外的两行（R37-P4a）：**静态事实**，不再各自重复倒计时。
 *
 * 倒计时已经由 hero 承担（并且只对"最近的那个"负责），行里再写一遍"还有 N 天"
 * 会出现两个不同的数字（生日 12 天 / 出道 300 天）并排，读到的人得先判断该看哪个。
 * 事实行给的是"这个日子是什么"：`3/14`、`2023/9/17 · 第 3 周年`。
 */
export function anniversaryFacts(items: AnniversaryItem[]): string[] {
  return items.map((it) => it.fact)      // R42：事实文本跟着条目走（见 `AnniversaryItem.fact`）
}