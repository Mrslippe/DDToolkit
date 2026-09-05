import { memo, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Cake, CalendarDays, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../api/api'
import type { FutureReservation, VTuber, VtuberEvent } from '../api/types'

interface Props {
  vtuber: VTuber
  /** fetch-idle 边沿：账号抓取完成后预约列表自动刷新 */
  refreshTick: number
}

/** 把 "YYYY-MM-DD" 解析为本地 Date（避免 new Date("YYYY-MM-DD") 的 UTC 偏移） */
function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 距今天的天数（今天=0） */
function daysUntil(d: Date): number {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}

/** 剩余天数文案：今天/明天/N 天 */
function daysLabel(n: number): string {
  if (n === 0) return '今天'
  if (n === 1) return '明天'
  return `${n} 天`
}

/** 格式化 "YYYY-MM-DD" → "M月D日"（出道日可带年份展示在标题） */
function fmtDate(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 周年事件：生日（MM-DD 年循环）/ 出道日（YYYY-MM-DD 年循环，N 周年） */
interface Anniversary {
  key: string
  title: string
  /** 下一次发生日期 */
  next: Date
  /** 原始记录值（如生日 "MM-DD" / 出道 "2022-09-27"） */
  raw: string
  /** 上次发生的时间点（用于「N 周年」计算） */
  originYear?: number
}

function anniversaries(v: VTuber): Anniversary[] {
  const out: Anniversary[] = []
  const now = new Date()

  const bd = /^(\d{1,2})-(\d{1,2})$/.exec(v.birthday ?? '')
  if (bd) {
    let next = new Date(now.getFullYear(), Number(bd[1]) - 1, Number(bd[2]))
    if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      next = new Date(now.getFullYear() + 1, Number(bd[1]) - 1, Number(bd[2]))
    }
    out.push({ key: 'birthday', title: '生日', next, raw: v.birthday ?? '' })
  }

  const dd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v.debut_date ?? '')
  if (dd) {
    let next = new Date(now.getFullYear(), Number(dd[2]) - 1, Number(dd[3]))
    if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      next = new Date(now.getFullYear() + 1, Number(dd[2]) - 1, Number(dd[3]))
    }
    out.push({
      key: 'debut', title: '出道日', next, raw: v.debut_date ?? '',
      originYear: Number(dd[1]),
    })
  }
  return out
}

/**
 * 重要日期卡（P7）：纪念日（生日/出道日，年循环）+ 手动大型活动 + 自动预约帖。
 * vtuber 级数据（不挂账号切换器）；纪念日行内编辑；活动可增删；预约只读。
 */
const UpcomingEventsCard = memo(function UpcomingEventsCard({ vtuber, refreshTick }: Props) {
  const [events, setEvents] = useState<VtuberEvent[]>([])
  const [reservations, setReservations] = useState<FutureReservation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 添加表单
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDate, setNewDate] = useState('')
  const [saving, setSaving] = useState(false)

  // 纪念日行内编辑
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editBirthday, setEditBirthday] = useState('')
  const [editDebut, setEditDebut] = useState('')

  const annivs = useMemo(() => anniversaries(vtuber), [vtuber])

  useEffect(() => {
    if (!vtuber) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([api.listVtuberEvents(vtuber.id), api.futureReservations(vtuber.id)])
      .then(([ev, res]) => {
        if (cancelled) return
        setEvents(ev)
        setReservations(res)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [vtuber.id, refreshTick])

  const startEditing = (key: string) => {
    setEditingKey(key)
    setEditBirthday(vtuber.birthday ?? '')
    setEditDebut(vtuber.debut_date ?? '')
  }

  const saveAnniversary = async (key: string) => {
    const payload = key === 'birthday'
      ? { birthday: editBirthday || null }
      : { debut_date: editDebut || null }
    try {
      // 本地乐观更新（vtuber 由外层 refreshTick 通道兜底重拉）
      await api.updateVtuber(vtuber.id, payload)
      if (key === 'birthday') vtuber.birthday = payload.birthday ?? null
      else vtuber.debut_date = payload.debut_date ?? null
      setEditingKey(null)
      toast.success('纪念日已更新')
    } catch (e) {
      toast.error(`更新失败: ${(e as Error).message}`)
    }
  }

  const addEvent = async () => {
    if (!newTitle.trim() || !newDate) return
    setSaving(true)
    try {
      const e = await api.createVtuberEvent(vtuber.id, { title: newTitle.trim(), event_date: newDate })
      setEvents((prev) => [...prev, e].sort((a, b) => a.event_date.localeCompare(b.event_date)))
      setNewTitle('')
      setNewDate('')
      setAdding(false)
      toast.success('活动已添加')
    } catch (e) {
      toast.error(`添加失败: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const removeEvent = async (id: number) => {
    try {
      await api.deleteVtuberEvent(id)
      setEvents((prev) => prev.filter((e) => e.id !== id))
      toast.success('活动已删除')
    } catch (e) {
      toast.error(`删除失败: ${(e as Error).message}`)
    }
  }

  /** 合并展示行：Anniversary | VtuberEvent | FutureReservation */
  type Row = {
    id: string
    kind: 'anniv' | 'event' | 'reservation'
    title: string
    /** 展示用日期描述 */
    when: string
    /** 排序日期（下一发生日 / 活动日 / 预约日） */
    sort: Date
    days: number
    extra?: string
    anniv?: Anniversary
    event?: VtuberEvent
  }

  const annivRows: Row[] = annivs.map((a) => {
    const d = daysUntil(a.next)
    return {
      id: `anniv-${a.key}`,
      kind: 'anniv' as const,
      title: a.title,
      when: `${a.originYear ? `${a.originYear}年 ` : ''}${fmtDate(a.next)}`,
      sort: a.next,
      days: d,
      extra: a.key === 'debut' && a.originYear
        ? `${a.next.getFullYear() - a.originYear} 周年`
        : undefined,
      anniv: a,
    }
  })

  const eventRows: Row[] = []
  for (const e of events) {
    const d = parseDate(e.event_date)
    if (!d || daysUntil(d) < 0) continue
    eventRows.push({
      id: `event-${e.id}`,
      kind: 'event',
      title: e.title,
      when: `${d.getFullYear()}年 ${fmtDate(d)}`,
      sort: d,
      days: daysUntil(d),
      event: e,
    })
  }

  const resvRows: Row[] = reservations.map((r) => {
    const d = new Date(r.start_at)
    const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    return {
      id: `res-${r.post_id}`,
      kind: 'reservation',
      title: r.title,
      when: `预约直播 ${fmtDate(dd)} ${d.toTimeString().slice(0, 5)}`,
      sort: dd,
      days: daysUntil(dd),
      extra: r.reserve_total > 0 ? `${r.reserve_total} 人已约` : undefined,
    }
  })

  const rows: Row[] = [...annivRows, ...eventRows, ...resvRows]
    .sort((a, b) => a.sort.getTime() - b.sort.getTime())

  const empty = rows.length === 0 && !loading && !error

  return (
    <section className="archive-section archive-section--events">
      <div className="archive-section-head">
        <span className="archive-section-title">重要日期</span>
        <div className="archive-section-right">
          <span className="archive-section-note">纪念日 / 活动 / 预约</span>
          <button
            type="button"
            className="float-pill float-pill--sm"
            onClick={() => setAdding((v) => !v)}
          >
            <Plus className="size-3.5" />
            添加活动
          </button>
        </div>
      </div>

      {loading ? (
        <div className="archive-empty"><Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />加载中…</div>
      ) : error ? (
        <div className="archive-error">{error}</div>
      ) : (
        <>
          {adding && (
            <div className="event-add-form">
              <input
                className="event-input"
                placeholder="活动名称（如 生日歌回）"
                value={newTitle}
                maxLength={40}
                onChange={(e) => setNewTitle(e.target.value)}
              />
              <input
                type="date"
                className="event-input event-input--date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
              <button type="button" className="float-pill float-pill--sm" disabled={saving || !newTitle.trim() || !newDate} onClick={addEvent}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          )}

          {empty ? (
            <div className="archive-empty">暂无重要日期：编辑纪念日或添加活动后出现</div>
          ) : (
            <ul className="event-list">
              {rows.map((r) => (
                <li key={r.id} className={`event-row event-row--${r.kind}`}>
                  <div className="event-row-main">
                    <span className="event-row-title">
                      {r.kind === 'anniv' && r.anniv?.key === 'birthday' && <Cake className="size-3.5" />}
                      {r.kind === 'anniv' && r.anniv?.key === 'debut' && <CalendarDays className="size-3.5" />}
                      {r.kind === 'reservation' && <CalendarClock className="size-3.5" />}
                      {r.title}
                    </span>
                    <span className="event-row-title2">
                      {r.when}
                      {r.extra && <span className="event-row-extra">{r.extra}</span>}
                    </span>
                  </div>
                  <span className={`event-row-days${r.days <= 3 ? ' soon' : ''}`}>
                    {daysLabel(r.days)}
                  </span>
                  {/* 行操作 */}
                  <span className="event-row-ops">
                    {r.kind === 'anniv' && (
                      <button
                        type="button"
                        title="编辑纪念日"
                        className="event-op"
                        onClick={() => (editingKey === r.anniv?.key ? setEditingKey(null) : startEditing(r.anniv!.key))}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    )}
                    {r.kind === 'event' && (
                      <button
                        type="button"
                        title="删除活动"
                        className="event-op event-op--danger"
                        onClick={() => removeEvent(r.event!.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* 纪念日行内编辑面板 */}
          {editingKey && (
            <div className="event-edit-panel">
              <label className="event-edit-field">
                <span>生日（MM-DD）</span>
                <input
                  className="event-input"
                  placeholder="如 06-21"
                  value={editBirthday}
                  maxLength={10}
                  onChange={(e) => setEditBirthday(e.target.value)}
                />
              </label>
              <label className="event-edit-field">
                <span>出道日（YYYY-MM-DD）</span>
                <input
                  className="event-input"
                  placeholder="如 2022-09-27"
                  value={editDebut}
                  maxLength={10}
                  onChange={(e) => setEditDebut(e.target.value)}
                />
              </label>
              <button type="button" className="float-pill float-pill--sm" onClick={() => saveAnniversary(editingKey)}>
                保存
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
})

export default UpcomingEventsCard
