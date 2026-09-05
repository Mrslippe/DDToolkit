import { memo, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { GiftDay, LiveSession } from '../api/types'
import { inferLiveType } from '../utils/liveType'

interface Props {
  sessions: LiveSession[]
  giftDays: GiftDay[]
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const MAX_CELL_ROWS = 2

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtRange(s: LiveSession): string {
  const start = fmtTime(s.start_at)
  return s.end_at ? `${start}–${fmtTime(s.end_at)}` : `${start}·进行中`
}

function fmtDuration(min: number | null): string {
  if (min == null) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}小时${m ? `${m}分` : ''}` : `${m}分`
}

interface DayCell {
  date: string
  day: number
  sessions: LiveSession[]
  gift?: GiftDay
}

/**
 * 直播日历（P5→P7 改造）：月网格。
 * - P5：绿点 = 当日在播；满格 = 礼物聚合；
 * - P7（v0.7.0）：格内直接显示场次条目——[类型徽章] 起止时间 单行标题（最多 2 条，
 *   超出的收进点击浮层）；礼物日保留底色 + 金额徽标。
 */
const LiveCalendar = memo(function LiveCalendar({ sessions, giftDays }: Props) {
  const now = new Date()
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })
  const [openDay, setOpenDay] = useState<string | null>(null)

  const byDay = useMemo(() => {
    const m = new Map<string, LiveSession[]>()
    for (const sess of sessions) {
      const d = new Date(sess.start_at)
      if (Number.isNaN(d.getTime())) continue
      const k = dayKey(d)
      const list = m.get(k)
      if (list) list.push(sess)
      else m.set(k, [sess])
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.start_at.localeCompare(b.start_at))
    }
    return m
  }, [sessions])

  const giftByDay = useMemo(() => {
    const m = new Map<string, GiftDay>()
    for (const g of giftDays) m.set(g.gift_date, g)
    return m
  }, [giftDays])

  const cells = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1)
    const startWeekday = (first.getDay() + 6) % 7 // 周一=0
    const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate()
    const out: (DayCell | null)[] = []
    for (let i = 0; i < startWeekday; i++) out.push(null)
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dayKey(new Date(ym.y, ym.m, d))
      out.push({ date: key, day: d, sessions: byDay.get(key) ?? [], gift: giftByDay.get(key) })
    }
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [ym, byDay, giftByDay])

  const moveMonth = (delta: number) => {
    setOpenDay(null)
    setYm(({ y, m }) => {
      const d = new Date(y, m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  const openCell = cells.find((c) => c?.date === openDay) ?? null

  return (
    <div className="live-calendar">
      <div className="live-calendar-head">
        <button type="button" title="上一月" onClick={() => moveMonth(-1)}>
          <ChevronLeft className="size-4" />
        </button>
        <span className="live-calendar-title">
          {ym.y}-{String(ym.m + 1).padStart(2, '0')}
        </span>
        <button type="button" title="下一月" onClick={() => moveMonth(1)}>
          <ChevronRight className="size-4" />
        </button>
        <span className="live-calendar-note">点击有直播的日子查看场次详情</span>
      </div>

      <div className="live-calendar-grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="live-calendar-weekday">{w}</div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={`pad-${i}`} className="live-calendar-cell empty" />
          const hasData = c.sessions.length > 0 || !!c.gift
          const hidden = Math.max(0, c.sessions.length - MAX_CELL_ROWS)
          return (
            <button
              type="button"
              key={c.date}
              className={
                'live-calendar-cell' +
                (c.gift ? ' gift' : '') +
                (c.sessions.length > 0 ? ' live' : '') +
                (c.date === openDay ? ' open' : '')
              }
              onClick={() => setOpenDay(openDay === c.date ? null : c.date)}
              disabled={!hasData}
              title={hasData ? undefined : undefined}
            >
              <span className="live-calendar-day">{c.day}</span>
              {c.sessions.slice(0, MAX_CELL_ROWS).map((s) => {
                const t = inferLiveType(s.live_title)
                return (
                  <span key={s.start_at} className="live-calendar-entry">
                    <span className={`live-type ${t.className}`}>{t.label}</span>
                    <span className="live-calendar-entry-time">{fmtTime(s.start_at)}</span>
                    <span className="live-calendar-entry-title">{s.live_title || '场次'}</span>
                  </span>
                )
              })}
              {hidden > 0 && <span className="live-calendar-more">+{hidden} 场</span>}
              {c.gift && (
                <span className="live-calendar-gift">
                  礼 {c.gift.gift_amount ?? ''}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {openCell && (
        <div className="live-day-pop" role="dialog">
          <div className="live-day-pop-head">
            <span className="live-day-pop-title">
              {openCell.date} · {WEEKDAYS[(new Date(openCell.date + 'T00:00:00').getDay() + 6) % 7]}
            </span>
            <button type="button" title="关闭" onClick={() => setOpenDay(null)}>
              <X className="size-4" />
            </button>
          </div>
          {openCell.sessions.length === 0 && !openCell.gift ? (
            <div className="archive-empty">当日无场次记录</div>
          ) : (
            <>
              {openCell.sessions.map((s) => {
                const t = inferLiveType(s.live_title)
                return (
                  <div key={s.start_at} className="live-day-pop-row">
                    <span className={`live-type ${t.className}`}>{t.label}</span>
                    <div className="live-day-pop-body">
                      <span className="live-day-pop-title-text">{s.live_title || '（无标题场次）'}</span>
                      <span className="live-day-pop-meta">
                        {fmtRange(s)}
                        {s.duration_minutes != null && ` · ${fmtDuration(s.duration_minutes)}`}
                      </span>
                    </div>
                  </div>
                )
              })}
              {openCell.gift && (
                <div className="live-day-pop-gift">
                  {openCell.gift.gift_date} 礼物 {openCell.gift.gift_amount ?? '0'} /
                  大航海 {openCell.gift.guard_amount ?? '0'} / SC {openCell.gift.sc_amount ?? '0'}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})

export default LiveCalendar
