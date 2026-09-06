import { memo, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { GiftDay, LiveSession } from '../api/types'
import { inferLiveType, LIVE_TYPE_ORDER } from '../utils/liveType'

interface Props {
  sessions: LiveSession[]
  giftDays: GiftDay[]
}

/** 「2026-09-06」 */
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const MAX_CELL_ROWS = 2

/** 「YYYY-MM-DD」 */
function dayKeyIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 「26/09/06」 */
function fmtDateShort(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).slice(2)}/${p(d.getMonth() + 1)}/${p(d.getDate())}`
}

/** 「8:00 PM」 */
function fmtTimeEn(d: Date): string {
  const h = d.getHours()
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:00 ${h < 12 ? 'AM' : 'PM'}`
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
  date: Date
  key: string
  sessions: LiveSession[]
  gift?: GiftDay
}

interface WeekRow {
  weekKey: string          // 该周周一 key
  days: DayCell[]
  /** 周内是否含今天（当前周高亮） */
  isCurrent: boolean
}

/**
 * 直播日历（v0.8.0 重设计，照参考图周行列表）：
 * - 每行一周 7 格（周一~周日），从当前周开始向下排列过去各周（最新在上）；
 * - 顶部统计行：共 N 场 + 各类型彩色计数（9 类标签对齐参考图）；
 * - 格子：左上「26/09/06 周六」/ 类型彩签+时间 / 单行标题（最多 2 条 +N）；
 *   无直播日显示「休息」；当前周绿描边；礼物日保留金额角标；
 * - 点击格子 → 浮层（全量场次/起止/时长/礼物）；
 * - 翻周钮 ◀ ▶ 锚定查看的周（默认当前周）。
 */
const LiveCalendar = memo(function LiveCalendar({ sessions, giftDays }: Props) {
  const now = new Date()
  const [anchor, setAnchor] = useState<number>(0)   // 相对当前周的偏移（0=当前周, 1=上一周…）
  const [openDay, setOpenDay] = useState<string | null>(null)

  const byDay = useMemo(() => {
    const m = new Map<string, LiveSession[]>()
    for (const sess of sessions) {
      const d = new Date(sess.start_at)
      if (Number.isNaN(d.getTime())) continue
      const k = dayKeyIso(d)
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

  /** 当前周的周一 */
  const currentMonday = useMemo(() => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const wd = (d.getDay() + 6) % 7   // 周一=0
    d.setDate(d.getDate() - wd)
    return d
  }, [now.getFullYear(), now.getMonth(), now.getDate()])

  /** 全量场次统计（9 类计数 + 总场） */
  const stats = useMemo(() => {
    const counts = new Map<string, number>()
    let total = 0
    for (const sess of sessions) {
      total += 1
      const t = inferLiveType(sess.live_title)
      counts.set(t.key, (counts.get(t.key) ?? 0) + 1)
    }
    return { total, counts }
  }, [sessions])

  /** 可见周行：锚定周 + 向后 5 周（含更早历史；空周也渲染以保持网格完整性） */
  const weeks: WeekRow[] = useMemo(() => {
    const out: WeekRow[] = []
    // 找到数据最早日期与当前周之间的行数上限（防御：最多 12 周）
    let earliest: Date | null = null
    for (const sess of sessions) {
      const d = new Date(sess.start_at)
      if (Number.isNaN(d.getTime())) continue
      if (!earliest || d < earliest) earliest = d
    }
    const maxWeeks = 12
    for (let off = anchor; off < anchor + 6 && off < maxWeeks; off++) {
      const monday = new Date(currentMonday)
      monday.setDate(monday.getDate() - off * 7)
      const days: DayCell[] = []
      let hasAny = false
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday)
        d.setDate(d.getDate() + i)
        const key = dayKeyIso(d)
        const list = byDay.get(key) ?? []
        if (list.length > 0) hasAny = true
        days.push({ date: d, key, sessions: list, gift: giftByDay.get(key) })
      }
      if (off > 0 && !hasAny && earliest) {
        const e = new Date(earliest)
        e.setHours(0, 0, 0, 0)
        if (e > monday) break   // 数据已全部在更早之前，不再往下渲染
      }
      out.push({ weekKey: keyOf(monday), days, isCurrent: off === 0 })
    }
    return out
  }, [sessions, byDay, giftByDay, anchor, currentMonday])

  const moveWeek = (delta: number) => {
    setOpenDay(null)
    setAnchor((a) => Math.max(0, Math.min(11, a + delta)))
  }

  const resetWeek = () => {
    setOpenDay(null)
    setAnchor(0)
  }

  const openCell = useMemo(() => {
    for (const w of weeks) {
      const hit = w.days.find((d) => d.key === openDay)
      if (hit) return hit
    }
    return null
  }, [weeks, openDay])

  // 统计行：总场 + 各类型计数（按 LIVE_TYPE_ORDER，>0 才显示）
  const statParts = LIVE_TYPE_ORDER
    .map((t) => ({ ...t, n: stats.counts.get(t.key) ?? 0 }))
    .filter((t) => t.n > 0)
  const liveN = stats.counts.get('live') ?? 0

  return (
    <div className="live-calendar">
      {/* 头部：标题 + 翻周 + 统计行 */}
      <div className="live-calendar-head">
        <button type="button" title="更早一周" onClick={() => moveWeek(-1)} disabled={anchor === 0}>
          <ChevronLeft className="size-4" />
        </button>
        <button type="button" className="live-calendar-today" onClick={resetWeek}>
          最近周
        </button>
        <button type="button" title="更晚一周" onClick={() => moveWeek(1)} disabled={anchor === 11}>
          <ChevronRight className="size-4" />
        </button>
        <span className="live-calendar-note">点击有直播的日子查看场次详情</span>
      </div>

      <div className="live-calendar-stats">
        <span className="live-calendar-stats-total">共 {stats.total} 场。</span>
        {statParts.map((t) => (
          <span key={t.key} className="live-calendar-stat">
            <span className={`live-type ${`live-type--${t.key}`}`}>{t.label}</span>
            {t.n}
          </span>
        ))}
        {liveN > 0 && (
          <span className="live-calendar-stat">
            <span className="live-type live-type--live">直播</span>
            {liveN}
          </span>
        )}
      </div>

      {/* 周行列表：周一~周日表头 + 周行（最新在上） */}
      <div className="live-calendar-weeks">
        <div className="live-calendar-weekdays">
          {WEEKDAYS.map((w) => (
            <div key={w} className="live-calendar-weekday">{w}</div>
          ))}
        </div>
        {weeks.map((w) => (
          <div key={w.weekKey} className={`live-calendar-week${w.isCurrent ? ' current' : ''}`}>
            {w.days.map((c) => {
              const hidden = Math.max(0, c.sessions.length - MAX_CELL_ROWS)
              const hasData = c.sessions.length > 0 || !!c.gift
              const isToday = c.key === dayKeyIso(now)
              return (
                <button
                  type="button"
                  key={c.key}
                  className={
                    'live-calendar-cell' +
                    (c.gift ? ' gift' : '') +
                    (c.sessions.length > 0 ? ' live' : '') +
                    (c.key === openDay ? ' open' : '') +
                    (isToday ? ' today' : '')
                  }
                  onClick={() => setOpenDay(openDay === c.key ? null : c.key)}
                  disabled={!hasData}
                  title={hasData ? (c.sessions[0]?.live_title ?? undefined) : undefined}
                >
                  <span className="live-calendar-day">
                    {fmtDateShort(c.date)} <em>{WEEKDAYS[(c.date.getDay() + 6) % 7].slice(1)}</em>
                  </span>
                  {c.sessions.length === 0 && !c.gift ? (
                    <span className="live-calendar-rest">休息</span>
                  ) : (
                    <>
                      {c.sessions.slice(0, MAX_CELL_ROWS).map((s) => {
                        const t = inferLiveType(s.live_title)
                        return (
                          <span key={s.start_at} className="live-calendar-entry">
                            <span className={`live-type ${t.className}`}>{t.label}</span>
                            <span className="live-calendar-entry-time">{fmtTimeEn(new Date(s.start_at))}</span>
                            <span className="live-calendar-entry-title">{s.live_title || '场次'}</span>
                          </span>
                        )
                      })}
                      {hidden > 0 && <span className="live-calendar-more">+{hidden} 场</span>}
                      {c.gift && (
                        <span className="live-calendar-gift">礼 {c.gift.gift_amount ?? ''}</span>
                      )}
                    </>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* 场次详情浮层（点击格子弹出；弹窗层规格） */}
      {openCell && (
        <div className="live-day-pop" role="dialog">
          <div className="live-day-pop-head">
            <span className="live-day-pop-title">
              {fmtDateShort(openCell.date)} · {WEEKDAYS[(openCell.date.getDay() + 6) % 7]}
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

function keyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default LiveCalendar
