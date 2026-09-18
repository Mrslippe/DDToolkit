import { useCallback, useEffect, useState } from 'react'

import { api } from '../../api/api'
import type { VtuberEvent } from '../../api/types'
import type { AnniversaryItem } from './anniversary'
import { daysUntilNext, parseAnniversary } from './anniversary'

/**
 * 「自定义条目」共用层（R42，用户 2026-09-19）。
 *
 * 用户口径：
 *  - 纪念日卡「**开放给用户自行添加纪念日**，并且可以自定义**名称、日期、emoji** 等」；
 *  - 大事记卡「用**时间轴**的形式来呈现」。
 *
 * 两张卡共用 `vtuber_events` 表、各按 `kind` 取自己的条目（用户拍板的存储方案），
 * 所以这里把"取/增/改/删"收成一层 —— 免得两张卡各写一份 CRUD 与各自的错误处理。
 */

export type EntryKind = 'anniversary' | 'event'

/** 一条自定义条目的草稿（表单里那三个字段） */
export interface EntryDraft {
  title: string
  event_date: string
  emoji: string
}

export const EMPTY_DRAFT: EntryDraft = { title: '', event_date: '', emoji: '' }

/** 纯函数：草稿是否可提交（名称非空 + 日期是合法的 YYYY-MM-DD） */
export function draftError(d: EntryDraft): string | null {
  if (!d.title.trim()) return '名称不能为空'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.event_date)) return '日期要选（YYYY-MM-DD）'
  const [y, m, day] = d.event_date.split('-').map(Number)
  const probe = new Date(y, m - 1, day)
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== day) {
    return '这个日期不存在'
  }
  return null
}

/** 纯函数：把草稿转成接口参数（emoji 空串 ⇒ null，而不是空字符串进库） */
export function draftToPayload(d: EntryDraft): { title: string; event_date: string; emoji: string | null } {
  return {
    title: d.title.trim(),
    event_date: d.event_date,
    emoji: d.emoji.trim() || null,
  }
}

/**
 * 纯函数：把自定义纪念日**并进** `anniversaryItems` 那一套里（R42）。
 *
 * 为什么并进去而不是另起一块：hero 的倒计时是"**最近的一个**"——
 * 用户自己加的纪念日当然也该参与倒数（否则加了生日却不算，看着像没生效）。
 * 口径与内置行完全一致：日期解析走 `parseAnniversary`（容错）、
 * 天数走 `daysUntilNext`、行内事实跟着条目走（`fact`）。
 */
export function customAnniversaryItems(
  events: VtuberEvent[], today: Date = new Date(),
): AnniversaryItem[] {
  const out: AnniversaryItem[] = []
  for (const ev of events) {
    const parsed = parseAnniversary(ev.event_date)
    if (!parsed) continue
    const days = daysUntilNext(parsed.month, parsed.day, today)
    // 年份：用户填的日期里有年份才算"第 N 周年"（与内置行同一口径）
    const nth = parsed.year != null
      ? new Date(today.getFullYear(), parsed.month - 1, parsed.day).getTime() <
        new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
        ? today.getFullYear() + 1 - parsed.year
        : today.getFullYear() - parsed.year
      : 0
    out.push({
      key: `custom-${ev.id}`,
      label: ev.title,
      text: `${parsed.month} 月 ${parsed.day} 日`,
      days,
      raw: ev.event_date,
      md: `${parsed.month}/${parsed.day}`,
      nth: Math.max(0, nth),
      fact: `${parsed.month}/${parsed.day}${nth > 0 ? ` · 第 ${nth} 周年` : ''}`,
      emoji: ev.emoji || null,
    })
  }
  return out
}

/** 取/增/改/删一层收口（两张卡共用）。返回的 `items` 只含**这一类** kind 的条目。 */
export function useCustomEntries(vtuberId: number, kind: EntryKind, refreshTick: number) {
  const [items, setItems] = useState<VtuberEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    let alive = true
    api.listVtuberEvents(vtuberId, kind)
      .then((rows) => { if (alive) setItems(rows) })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [vtuberId, kind])

  useEffect(() => reload(), [reload, refreshTick])

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      // 失败要**看得见**：静默失败会让人以为"存了"（本仓的硬规矩）
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [reload])

  const add = useCallback((d: EntryDraft) =>
    run(() => api.createVtuberEvent(vtuberId, { ...draftToPayload(d), kind })), [run, vtuberId, kind])

  const edit = useCallback((id: number, d: EntryDraft) =>
    run(() => api.updateVtuberEvent(id, draftToPayload(d))), [run])

  const remove = useCallback((id: number) =>
    run(() => api.deleteVtuberEvent(id)), [run])

  return { items, busy, error, add, edit, remove }
}
