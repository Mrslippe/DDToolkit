import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import type { LiveSession } from '../api/types'
import { api } from '../api/api'
import { inferLiveType } from '../utils/liveType'

interface Props {
  /** 账号 id（null=无账号，显示空态）；切换账号自动重拉 */
  accountId: number | null
  /** 刷新信号（fetch-idle 边沿后重拉场次） */
  refreshTick?: number
}

/** 英文表头（设计稿 Frame10612 规格） */
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

type CellState = 'live' | 'rest' | 'tbd' | 'pad'

interface DayCell {
  date: Date
  key: string
  /** 属于当前月（false=上/下月补位） */
  inMonth: boolean
  sessions: LiveSession[]
  isToday: boolean
  state: CellState
}

/**
 * 直播日历（v0.9.2 重建，严格按 docs/design/react-LiveCalendar Frame10612 规格）：
 * - 卡片 870 定宽上限居中（用户参数）；网格 7 列 × 117.428574px + 2px 列/行距，
 *   6 行 42 格（4.5px 列间隙由 space-between 均分，实测 834px 内 7×117.43+6×2）；
 * - 格子 70.833336px 高 / 6px 圆角；
 * - 类型格：左上 20px 日期（同色系主色）+ 右上 34×16 胶囊（圆角 106px 亮色系）
 *   两端对齐；下方 12px 时间（主色 50% 淡化）+ 14px/600 标题（行高 16px，两行）；
 * - 今天 = 灰底实底 + 1px 灰描边 rgba(118,118,118,1)（设计稿唯一描边语义）；
 * - 上月补位/过去无场次 = 灰底 opacity 0.3（休息），未来无场次 = 灰底实底（待定）；
 * - 统计胶囊行：UI 暂不渲染（user: 统计行不要，数据留在 utils/liveType.ts）。
 */
const LiveCalendar = memo(function LiveCalendar({ accountId, refreshTick = 0 }: Props) {
  const now = new Date()
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (accountId == null) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .liveSessions(accountId)
      .then((s) => {
        if (!cancelled) setSessions(s)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || '场次加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, refreshTick])

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

  const todayKey = dayKeyIso(now)

  /** 42 格固定 6 行（设计稿）：首行从当月 1 号所在周一周起，含上月补位 */
  const cells = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1)
    const startWeekday = (first.getDay() + 6) % 7 // 周一=0
    const start = new Date(ym.y, ym.m, 1 - startWeekday)
    const out: DayCell[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const key = dayKeyIso(d)
      const list = byDay.get(key) ?? []
      const inMonth = d.getMonth() === ym.m
      const isToday = key === todayKey
      // 今天优先：无论有无场次都归 tbd/live（避免 now 含时分使当天 d<now 误判为休息）
      const state: CellState = list.length > 0 ? 'live' : inMonth ? (isToday || d >= now ? 'tbd' : 'rest') : 'pad'
      out.push({ date: d, key, inMonth, sessions: list, isToday, state })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym, byDay])

  const moveMonth = (delta: number) => {
    setYm(({ y, m }) => {
      const d = new Date(y, m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  const renderCell = (c: DayCell) => {
    const first = c.sessions[0]
    const t = first ? inferLiveType(first.live_title) : null

    let toneCls = ''
    if (c.state === 'live' && t) toneCls = ` lc-tone-${t.key}`
    else if (c.state === 'rest') toneCls = ' rest'
    else if (c.state === 'tbd') toneCls = ' tbd'
    else toneCls = ' pad'
    if (c.isToday) toneCls += ' today'

    return (
      <div key={c.key} className={'lc-cell' + toneCls}>
        <div className="lc-cell-head">
          <span className="lc-day">{c.date.getDate()}</span>
          {t ? (
            <span className="lc-badge">{t.label}</span>
          ) : (
            <span className="lc-badge">{c.state === 'live' ? '直播' : c.state === 'rest' ? '休息' : '待定'}</span>
          )}
        </div>
        {first ? (
          <div className="lc-cell-body">
            <span className="lc-time">{fmtTimeEn(new Date(first.start_at))}</span>
            <span className="lc-title">{first.live_title || '场次'}</span>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="live-calendar">
      {/* 卡片标题（设计稿 613：16px #182E41） */}
      <div className="lc-title">直播日历</div>

      {/* 月份导航条（设计稿 frame 10_616：三颗白胶囊紧贴——左箭头+月份+右箭头） */}
      <div className="lc-nav">
        <button type="button" title="上个月" className="lc-nav-btn" onClick={() => moveMonth(-1)}>
          <ChevronLeft className="lc-nav-icon" />
        </button>
        <div className="lc-nav-pill">
          <span className="lc-nav-text">{fmtMonth(ym.y, ym.m)}</span>
        </div>
        <button type="button" title="下个月" className="lc-nav-btn" onClick={() => moveMonth(1)}>
          <ChevronRight className="lc-nav-icon" />
        </button>
      </div>

      {/* 月历区（设计稿 frame 10_659：表头与网格 gap 5px） */}
      <div className="lc-body">
        {/* 星期表头（Mon.~Sun.，7 等分 14px #727272） */}
        <div className="lc-weekdays">
          {WEEKDAYS_EN.map((w) => (
            <div key={w} className="lc-weekday">{w}</div>
          ))}
        </div>

        {/* 月历网格：7 列 × 6 行，列/行距 2px */}
        <div className="lc-grid">
          {loading && (
            <div className="lc-state">
              <Loader2 className="lc-state-icon" />
            </div>
          )}
          {!loading && error && <div className="lc-state lc-error">{error}</div>}
          {!loading && !error && cells.map((c) => renderCell(c))}
        </div>
      </div>
    </div>
  )
})

export default LiveCalendar
