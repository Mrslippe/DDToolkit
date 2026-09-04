import { memo, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { GiftDay, LiveSession } from '../api/types'

interface Props {
  sessions: LiveSession[]
  giftDays: GiftDay[]
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 直播日历（P5）：月网格。
 * 绿点 = 当日在播（self 快照推导的场次证据）；满格 = 当日有礼物聚合（第三方）。
 * 两者都有 → 满格 + 角点。悬浮显示礼物金额（原始字符串保精度）。
 */
const LiveCalendar = memo(function LiveCalendar({ sessions, giftDays }: Props) {
  const now = new Date()
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })

  const liveDays = useMemo(() => {
    const s = new Set<string>()
    for (const sess of sessions) {
      const d = new Date(sess.start_at)
      if (!Number.isNaN(d.getTime())) s.add(dayKey(d))
    }
    return s
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
    const out: ({ date: string; day: number; live?: boolean; gift?: GiftDay } | null)[] = []
    for (let i = 0; i < startWeekday; i++) out.push(null)
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dayKey(new Date(ym.y, ym.m, d))
      out.push({ date: key, day: d, live: liveDays.has(key), gift: giftByDay.get(key) })
    }
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [ym, liveDays, giftByDay])

  const moveMonth = (delta: number) =>
    setYm(({ y, m }) => {
      const d = new Date(y, m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })

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
      </div>
      <div className="live-calendar-grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="live-calendar-weekday">{w}</div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={`pad-${i}`} className="live-calendar-cell empty" />
          const gift = c.gift
          const tip = gift
            ? `${gift.gift_date} 礼物 ${gift.gift_amount ?? '0'} / 大航海 ${gift.guard_amount ?? '0'} / SC ${gift.sc_amount ?? '0'}`
            : c.live
              ? `${c.date} 当日有直播`
              : undefined
          return (
            <div
              key={c.date}
              className={`live-calendar-cell${gift ? ' gift' : ''}${c.live ? ' live' : ''}`}
              title={tip}
            >
              <span className="live-calendar-day">{c.day}</span>
              {(gift || c.live) && <span className="live-calendar-mark" />}
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default LiveCalendar
