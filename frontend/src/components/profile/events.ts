/**
 * 「大事记」口径（R37-P3，devlog/145）—— 纯函数可单测。
 *
 * 数据来自 `vtuber_events` 表（P7 就建好了，**一直没接 UI**；`GET /vtuber/{id}/events` 端点也一直在）。
 * 本批把它做成档案视图的第三张内置卡 —— 顺便当一次**真扩展点示例**：
 * 加一张卡 = 写一个纯逻辑模块 + 一个组件 + 在 `cards/index.tsx` 里 `registerCardKind`，**视图一行没改**。
 *
 * `event_date` 是 `YYYY-MM-DD`（本地日期字符串，与 live_sessions 的日期口径一致）——
 * ⚠️ 不能用 `new Date('2026-09-17')` 解析：那会按 **UTC** 解析，东八区会退一天
 * （同 `liveCalendarFmt.dayKeyIso` 踩过的坑）。
 */
import type { VtuberEvent } from '../../api/types'

export interface EventItem {
  id: number
  title: string
  date: string
  /** 距今天数：负数 = 已过 */
  days: number
  /** 展示用的一句话（「还有 3 天」/「今天」/「12 天前」） */
  when: string
}

/** `YYYY-MM-DD` → 本地当天零点；解析不出返回 null（脏数据不猜） */
function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? '').trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * 排序 + 文案：**未来的在前（近的优先）→ 过去的在后（近的优先）**。
 *
 * 为什么未来优先：大事记卡是"接下来要发生什么"的提醒位（演唱会/周年庆），
 * 已经过去的只在没有未来条目时起"回顾"作用。
 */
export function eventItems(events: VtuberEvent[], today: Date = new Date(),
                           limit = 4): EventItem[] {
  const t0 = startOfDay(today)
  const out: EventItem[] = []
  for (const ev of events) {
    const d = parseLocalDate(ev.event_date)
    if (!d) continue
    const days = Math.round((d.getTime() - t0.getTime()) / 86400000)
    const when = days === 0 ? '今天' : days > 0 ? `还有 ${days} 天` : `${-days} 天前`
    out.push({ id: ev.id, title: ev.title, date: ev.event_date, days, when })
  }
  return out
    .sort((a, b) => {
      const aFuture = a.days >= 0
      const bFuture = b.days >= 0
      if (aFuture !== bFuture) return aFuture ? -1 : 1
      return aFuture ? a.days - b.days : b.days - a.days
    })
    .slice(0, limit)
}

/** 头部那句说明（有几条未来、几条已过）—— 空态也要说清，别让人以为"坏了" */
export function eventHint(items: EventItem[]): string {
  if (!items.length) return '还没有记录大事记'
  const future = items.filter((i) => i.days >= 0).length
  if (!future) return `${items.length} 条已过 · 都是回顾`
  return `${future} 条将至${items.length > future ? ` · ${items.length - future} 条已过` : ''}`
}

/** 行尾 chip 的三种色调（R37-P4a）：今天=强调粉、未来=中性蓝、已过=灰 */
export type EventChipTone = 'today' | 'future' | 'past'

/**
 * 行尾那枚 chip（R37-P4a，规格 §4.3）。
 *
 * 比原来的 `when`（「还有 13 天」）更短：chip 是**行尾的视觉锚点**，
 * 太长会把标题挤掉；而"还有"两个字在时间线语境里是冗余的（左侧的点和排序已经说明了方向）。
 * 色调单独给出来（而不是让视图自己 `days > 0` 判断）—— 判据只有一份，视图只负责画。
 */
export function eventChip(item: EventItem): { text: string; tone: EventChipTone } {
  if (item.days === 0) return { text: '今天', tone: 'today' }
  return item.days > 0
    ? { text: `${item.days} 天后`, tone: 'future' }
    : { text: `${-item.days} 天前`, tone: 'past' }
}