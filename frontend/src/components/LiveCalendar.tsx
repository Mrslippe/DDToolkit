import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import type { LiveSession } from '../api/types'
import { api } from '../api/api'
import { inferLiveType, LIVE_TYPE_ORDER } from '../utils/liveType'

interface Props {
  /** 账号 id（null=无账号，显示空态）；切换账号自动重拉 */
  accountId: number | null
  /** 刷新信号（fetch-idle 边沿后重拉场次） */
  refreshTick?: number
}

/** 英文表头（设计稿 Frame10612 规格） */
const WEEKDAYS_EN = ['Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.', 'Sun.']
/** 月份浮窗：12 月中文名 */
const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

function dayKeyIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 「2026年09月」（月份胶囊内文字） */
function fmtMonth(y: number, m: number): string {
  return `${y}年${String(m + 1).padStart(2, '0')}月`
}

/** 「20:00」（24 小时制，与帖子时间格式统一；整点显示） */
function fmtTime(d: Date): string {
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

type CellState = 'live' | 'tbd'

interface DayCell {
  date: Date
  key: string
  /** 属于当前月（false=上/下月补位）——透明度只由它决定（user 2026-09-06） */
  inMonth: boolean
  sessions: LiveSession[]
  isToday: boolean
  state: CellState
}

/** 统计胶囊亮色（设计稿 frame 10_643-658：杂谈黄FFC853/观影紫E0B5FF/游戏蓝96E1FE/投稿绿84F89F）
 *  颜色定义见 posts.css .lc-stat-pill--{key} 规则 */

/**
 * 直播日历（v0.9.2 重建，骨架严格按 docs/design/react-LiveCalendar Frame10612 规格）：
 * - 卡片 870 定宽上限居中（用户参数）；网格 7 列 × 115.714286px + 4px 列/行距
 *   （v0.9.x 审美对齐：2px→4px 密度），6 行 42 格；
 * - 格子 73.1667px 高（v0.9.x 用户：内容拥挤，行高 +4px，卡高 566→590）/ 6px 圆角；
 * - 今天 = 1px 粉描边 rgba(251,119,161,.8)（v0.9.x 审美对齐：设计稿灰描边 → 项目强调粉）；
 * - 透明度 = 月份指示（user）：非本月补位格整体 opacity 0.3，本月格一律实底——
 *   与是否有直播无关；
 * - 导航栏（frame 10_616）：三颗白胶囊连排（左双箭头+月份+右双箭头），
 *   中间点击弹月份选择浮窗（直接选年/月）；
 * - 导航栏右侧 = 直播类型统计胶囊（frame 10_642：彩色胶囊 50×19 + 19px 计数），
 *   统计当前显示月场次，按 LIVE_TYPE_ORDER 仅显示非零项；类型全满时横向滚动兜底；
 * - 空月提示：当月 0 场次时标题右侧灰字（v0.9.x 新增）。
 */
const LiveCalendar = memo(function LiveCalendar({ accountId, refreshTick = 0 }: Props) {
  const now = new Date()
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 月份选择浮窗：独立年份游标（打开时同步 ym 的年）
  const [monthPopOpen, setMonthPopOpen] = useState(false)
  const [popYear, setPopYear] = useState(now.getFullYear())
  const navRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!monthPopOpen) return
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setMonthPopOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [monthPopOpen])

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

  /** 42 格固定 6 行（设计稿）：首行从当月 1 号所在周一周起，含上/下月补位 */
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
      // 状态：有场次=live；无场次=tbd。月份指示（pad 透明度）在渲染层叠加。
      const state: CellState = list.length > 0 ? 'live' : 'tbd'
      out.push({ date: d, key, inMonth, sessions: list, isToday, state })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym, byDay])

  /** 当月类型统计（导航栏右侧统计胶囊，仅非零项） */
  const monthStats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of cells) {
      if (!c.inMonth) continue
      for (const s of c.sessions) {
        const t = inferLiveType(s.live_title)
        counts.set(t.key, (counts.get(t.key) ?? 0) + 1)
      }
    }
    return LIVE_TYPE_ORDER.map((t) => ({ ...t, n: counts.get(t.key) ?? 0 })).filter((t) => t.n > 0)
  }, [cells])

  const moveMonth = (delta: number) => {
    setMonthPopOpen(false)
    setYm(({ y, m }) => {
      const d = new Date(y, m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  const openMonthPop = () => {
    setPopYear(ym.y)
    setMonthPopOpen((o) => !o)
  }

  const pickMonth = (m: number) => {
    setYm({ y: popYear, m })
    setMonthPopOpen(false)
  }

  const renderCell = (c: DayCell) => {
    const first = c.sessions[0]
    const t = first ? inferLiveType(first.live_title) : null

    let toneCls = ''
    if (c.state === 'live' && t) toneCls = ` lc-tone-${t.key}`
    else toneCls = ' tbd'
    // 月份指示（透明度）：非本月一律 pad 淡化，与场次状态无关
    if (!c.inMonth) toneCls += ' pad'
    if (c.isToday) toneCls += ' today'

    return (
      <div key={c.key} className={'lc-cell' + toneCls}>
        <div className="lc-cell-head">
          <span className="lc-day">{c.date.getDate()}</span>
          <span className="lc-badge">{t ? t.label : '待定'}</span>
        </div>
        {first ? (
          <div className="lc-cell-body">
            <span className="lc-time">{fmtTime(new Date(first.start_at))}</span>
            <span className="lc-title">{first.live_title || '场次'}</span>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="live-calendar">
      {/* 卡片标题（与归档卡标题同规格 16.5px/600）+ 空月提示（当月 0 场次） */}
      <div className="lc-title">
        直播日历
        {!loading && !error && monthStats.length === 0 && (
          <span className="lc-note">本月暂无直播记录</span>
        )}
      </div>

      {/* 导航行：左=月份胶囊（点击弹选月浮窗） · 右=当月类型统计胶囊（frame 10_642） */}
      <div className="lc-nav-row">
        <div className="lc-nav" ref={navRef}>
          <button type="button" title="上个月" className="lc-nav-btn lc-nav-btn--prev" onClick={() => moveMonth(-1)}>
            <span className="lc-nav-icon" />
          </button>
          <button type="button" className="lc-nav-pill" title="选择月份" onClick={openMonthPop}>
            <span className="lc-nav-text">{fmtMonth(ym.y, ym.m)}</span>
          </button>
          <button type="button" title="下个月" className="lc-nav-btn lc-nav-btn--next" onClick={() => moveMonth(1)}>
            <span className="lc-nav-icon" />
          </button>

          {/* 月份选择浮窗：年切换 + 12 月宫格 */}
          {monthPopOpen && (
            <div className="lc-month-pop">
              <div className="lc-month-pop-head">
                <button type="button" title="上一年" onClick={() => setPopYear((y) => y - 1)}>
                  <ChevronLeft className="size-4" />
                </button>
                <span className="lc-month-pop-year">{popYear}年</span>
                <button type="button" title="下一年" onClick={() => setPopYear((y) => y + 1)}>
                  <ChevronRight className="size-4" />
                </button>
              </div>
              <div className="lc-month-pop-grid">
                {MONTH_CN.map((name, i) => (
                  <button
                    key={name}
                    type="button"
                    className={`lc-month-pop-btn${i === ym.m && popYear === ym.y ? ' on' : ''}`}
                    onClick={() => pickMonth(i)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 当月类型统计胶囊（彩色胶囊 + 计数，设计稿 frame 10_642） */}
        <div className="lc-stats">
          {monthStats.map((t) => (
            <div key={t.key} className="lc-stat">
              <span className={`lc-stat-pill lc-stat-pill--${t.key}`}>{t.label}</span>
              <span className="lc-stat-num">{t.n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 月历区（设计稿 frame 10_659：表头与网格 gap 5px） */}
      <div className="lc-body">
        {/* 星期表头（Mon.~Sun.，14px #727272） */}
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
