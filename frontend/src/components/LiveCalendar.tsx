import { memo, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import type { GiftDay, LiveSession } from '../api/types'
import { inferLiveType, LIVE_TYPE_ORDER } from '../utils/liveType'

interface Props {
  sessions: LiveSession[]
  giftDays: GiftDay[]
}

/** 英文表头（设计稿 Frame101 规格） */
const WEEKDAYS_EN = ['Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.', 'Sun.']

function dayKeyIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 「2026年09月」（月份胶囊内文字） */
function fmtMonth(y: number, m: number): string {
  return `${y}年${String(m + 1).padStart(2, '0')}月`
}

/** 「8 PM」（设计稿时间格式） */
function fmtTimeEn(d: Date): string {
  if (Number.isNaN(d.getTime())) return '--:--'
  const h = d.getHours()
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12} ${h < 12 ? 'AM' : 'PM'}`
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

type CellState = 'live' | 'rest' | 'tbd' | 'pad'

interface DayCell {
  date: Date
  key: string
  /** 属于当前月（false=上/下月补位） */
  inMonth: boolean
  sessions: LiveSession[]
  gift?: GiftDay
  isToday: boolean
  state: CellState
}

/**
 * 直播日历（v0.9.0 重构，严格按 docs/design/react-LiveCalendar Frame101 规格）：
 * - 月历：周一~周日 7 列；上月/下月补位格按设计稿——上月补位=灰半透明（休息），
 *   下月补位=灰实底（待定）；
 * - 格子 58px 高 / 6px 圆角 / 类型色系（整格浅色底 + 同色系日期/时间/标题 + 胶囊）：
 *   设计稿 4 原色（游戏蓝/观影粉/投稿绿/杂谈黄）+ 同风格扩展 5 色；
 * - 格内只显示【首场】（时间+标题单行），其余场次收进鼠标 hover 浮层；
 * - 今天 = 红描边格（设计稿唯一描边语义）；过去无场次 = 休息；未来无场次 = 待定；
 * - 月份胶囊导航（白色胶囊 + 左右箭头，CSS 复刻设计稿）。
 */
const LiveCalendar = memo(function LiveCalendar({ sessions, giftDays }: Props) {
  const now = new Date()
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })

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

  const todayKey = dayKeyIso(now)

  /** 月历格子（含补位）：首行含月初前的周日补位，末行含月末后的补位 */
  const cells = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1)
    const startWeekday = (first.getDay() + 6) % 7   // 周一=0
    const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate()
    const out: DayCell[] = []
    // 月初补位：上月最后几天
    for (let i = startWeekday - 1; i >= 0; i--) {
      const d = new Date(ym.y, ym.m, -i)
      const key = dayKeyIso(d)
      out.push({
        date: d, key, inMonth: false,
        sessions: byDay.get(key) ?? [], gift: giftByDay.get(key),
        isToday: key === todayKey,
        state: 'pad',
      })
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(ym.y, ym.m, day)
      const key = dayKeyIso(d)
      const list = byDay.get(key) ?? []
      const isToday = key === todayKey
      // 状态：有场次=live；已过去无场次=休息；今天无场次/未来=待定（今天红描边+待定，设计稿「7 待定」格）
      const state: CellState = list.length > 0 ? 'live' : (d < now ? 'rest' : 'tbd')
      out.push({
        date: d, key, inMonth: true,
        sessions: list, gift: giftByDay.get(key),
        isToday, state,
      })
    }
    // 月末补位：下月前几天（填满最后一行）
    while (out.length % 7 !== 0) {
      const last = out[out.length - 1].date
      const d = new Date(last)
      d.setDate(d.getDate() + 1)
      const key = dayKeyIso(d)
      out.push({
        date: d, key, inMonth: false,
        sessions: byDay.get(key) ?? [], gift: giftByDay.get(key),
        isToday: key === todayKey,
        state: 'pad',
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym, byDay, giftByDay])

  const moveMonth = (delta: number) => {
    setYm(({ y, m }) => {
      const d = new Date(y, m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  /** 统计行（保留上一版：总场 + 类型计数） */
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

  const statParts = LIVE_TYPE_ORDER
    .map((t) => ({ ...t, n: stats.counts.get(t.key) ?? 0 }))
    .filter((t) => t.n > 0)
  const liveN = stats.counts.get('live') ?? 0

  const renderCell = (c: DayCell) => {
    const first = c.sessions[0]
    const remainCount = c.sessions.length
    const t = first ? inferLiveType(first.live_title) : null

    // 补位格：上月=休息氛围 / 下月=待定氛围（设计稿：补位灰格，内容半透明灰）
    if (!c.inMonth) {
      return (
        <div key={c.key} className="live-calendar-cell pad">
          <span className="live-calendar-day">{c.date.getDate()}</span>
          {first && t ? (
            <span className="live-calendar-cell-type">
              <span className={`live-type ${t.className}`}>{t.label}</span>
              <span className="live-calendar-cell-time">{fmtTimeEn(new Date(first.start_at))}</span>
            </span>
          ) : (
            <span className="live-calendar-cell-type">
              <span className="live-type live-type--rest">休息</span>
            </span>
          )}
        </div>
      )
    }

    // 本月格子
    const stateCls =
      c.state === 'live' ? (t ? t.className.replace('live-type--', 'tone-') : 'tone-live')
      : c.state === 'rest' ? 'rest'
      : 'tbd'
    const hasHover = (c.sessions.length > 0 || !!c.gift) && (remainCount > 1 || !!c.gift)

    return (
      <div
        key={c.key}
        className={
          'live-calendar-cell' +
          (c.isToday ? ' today' : '') +
          ` ${stateCls}`
        }
      >
        <span className="live-calendar-day">{c.date.getDate()}</span>

        {first ? (
          <>
            <span className="live-calendar-cell-type">
              <span className={`live-type ${t!.className}`}>{t!.label}</span>
              <span className="live-calendar-cell-time">{fmtTimeEn(new Date(first.start_at))}</span>
            </span>
            <span className="live-calendar-cell-title">{first.live_title || '场次'}</span>
            {remainCount > 1 && (
              <span className="live-calendar-more">+{remainCount - 1} 场</span>
            )}
          </>
        ) : (
          <span className="live-calendar-cell-type">
            <span className={`live-type ${c.state === 'rest' ? 'live-type--rest' : 'live-type--tbd'}`}>
              {c.state === 'rest' ? '休息' : '待定'}
            </span>
          </span>
        )}

        {/* hover 浮层：其余场次全量 + 礼物（内嵌格子，hover 显示；单场/无数据不弹） */}
        {hasHover && (
          <div className="live-day-pop" role="dialog">
            <div className="live-day-pop-head">
              <span className="live-day-pop-title">
                {c.date.getFullYear()}-{String(c.date.getMonth() + 1).padStart(2, '0')}-{String(c.date.getDate()).padStart(2, '0')} · {WEEKDAYS_EN[(c.date.getDay() + 6) % 7]}
              </span>
            </div>
            {c.sessions.length === 0 && !c.gift ? (
              <div className="archive-empty">当日无场次记录</div>
            ) : (
              <>
                {c.sessions.map((s) => {
                  const st = inferLiveType(s.live_title)
                  return (
                    <div key={s.start_at} className="live-day-pop-row">
                      <span className={`live-type ${st.className}`}>{st.label}</span>
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
                {c.gift && (
                  <div className="live-day-pop-gift">
                    {c.gift.gift_date} 礼物 {c.gift.gift_amount ?? '0'} /
                    大航海 {c.gift.guard_amount ?? '0'} / SC {c.gift.sc_amount ?? '0'}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="live-calendar">
      {/* 月份胶囊导航（设计稿：白色胶囊左右箭头 + 中央月份胶囊） */}
      <div className="live-calendar-nav">
        <button type="button" title="上个月" className="live-calendar-nav-btn" onClick={() => moveMonth(-1)}>
          <ChevronLeft className="size-4" />
        </button>
        <div className="live-calendar-nav-pill">
          <CalendarDays className="size-3.5" />
          <span className="live-calendar-nav-text">{fmtMonth(ym.y, ym.m)}</span>
        </div>
        <button type="button" title="下个月" className="live-calendar-nav-btn" onClick={() => moveMonth(1)}>
          <ChevronRight className="size-4" />
        </button>
      </div>

      {/* 统计行：共 N 场 + 类型彩色计数 */}
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

      {/* 表头（Mon.~Sun.） */}
      <div className="live-calendar-weekdays">
        {WEEKDAYS_EN.map((w) => (
          <div key={w} className="live-calendar-weekday">{w}</div>
        ))}
      </div>

      {/* 月历网格：7 列，行尾补位 */}
      <div className="live-calendar-grid">
        {cells.map((c) => renderCell(c))}
      </div>
    </div>
  )
})

export default LiveCalendar
