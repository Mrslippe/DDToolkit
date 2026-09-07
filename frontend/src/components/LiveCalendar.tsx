import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from 'lucide-react'
import type { LiveSession } from '../api/types'
import { api } from '../api/api'
import { LIVE_TYPE_ORDER, inferLiveType, liveTypeLabel } from '../utils/liveType'

interface Props {
  /** 账号 id（null=无账号，显示空态）；切换账号自动重拉。
   *  user 2026-09-07：默认只检索「主账号」直播信息（调用方传 heroAcc=
   *  bilibili 优先账号，见 PostsPage）；其他账号作为可选项，入口待以后做。 */
  accountId: number | null
  /** 刷新信号（fetch-idle 边沿后重拉场次） */
  refreshTick?: number
}

/** 英文表头（设计稿 Frame10612 规格） */
const WEEKDAYS_EN = ['Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.', 'Sun.']
/** 月份浮窗：12 月中文名 */
const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

/** 浮层关闭宽限（ms）：鼠标从格子滑向浮层中途不闪关 */
const POP_CLOSE_GRACE_MS = 120

function dayKeyIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 「2026年09月」（月份胶囊内文字） */
function fmtMonth(y: number, m: number): string {
  return `${y}年${String(m + 1).padStart(2, '0')}月`
}

/** 「20:31」（真实分钟——M4 起数据为秒级起止，不再取整点） */
function fmtTime(d: Date): string {
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 「3小时12分」 */
function fmtDur(min: number | null | undefined): string {
  if (min == null || min < 1) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}小时${m}分` : `${m}分`
}

/** 「¥10,501.5」 */
function fmtMoney(v: number | null | undefined): string {
  if (v == null) return ''
  return `¥${v.toLocaleString('zh-CN')}`
}

/** 类型 key（服务端）→ 展示；缺失时按标题关键词兜底 */
function keyOf(s: LiveSession): string {
  return s.category ?? inferLiveType(s.live_title).key
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

interface PopState {
  key: string
  rect: DOMRect
  sessions: LiveSession[]
}

/**
 * 直播日历（v0.9.2 重建 → v0.9.x M4 内容管道）：
 * - 卡片 870 定宽上限居中（用户参数）；网格 7 列 × 115.714286px + 4px 列/行距
 *   （v0.9.x 审美对齐：2px→4px 密度），6 行 42 格；
 * - 格子 73.1667px 高（v0.9.x 用户：内容拥挤，行高 +4px，卡高 566→590）/ 6px 圆角；
 * - 今天 = 1px 粉描边 rgba(251,119,161,.8)（v0.9.x 审美对齐：设计稿灰描边 → 项目强调粉）；
 * - 透明度 = 月份指示（user）：非本月补位格整体 opacity 0.3，本月格一律实底——与是否有直播无关；
 * - 导航栏（项目浮片族 token：斜切白卡浮片三连——左双箭头+月份+右双箭头，中间点击弹月份选择浮窗）；
 * - 导航栏右侧 = 当月类型统计胶囊（frame 10_642：彩色胶囊 + 计数，服务端 category 口径，仅非零项）；
 * - M4 内容（数据管道 M1-M3 后端闭环后）：
 *   · 格内按最开始布局单场呈现：时间行（HH:MM 真实分钟）+ 右侧「N 场」当日场次计数 + 单行标题
 *     （颜色跟随格类型色系：游戏蓝/杂谈黄/观影紫/投稿绿…，user 2026-09-07）；
 *   · hover 格子 → 浮层（当日全量：起止/时长/标题/类型/分区/收益/峰值在线/弹幕/数据源），
 *     鼠标滑向浮层有 120ms 宽限不闪关；Esc 关闭；
 *   · 无场次的格子：今天以前 = 「休息」；今天及以后 = 「待定」（user 2026-09-07）；
 *   · 礼物数据暂不展示（user 2026-09-07：之后从 danmakus 取场次级详细数据；
 *     浮层「收益」即 danmakus 场次级），格内礼物行/当日礼物合计已退役；
 *   · 类型徽章/统计用后端 category（v2 多信号：校正>系列>标题评分>词库>分区>纪念日），
 *     服务端缺失时前端关键词兜底；浮层内提供分类校正下拉（override 源）。
 */
const LiveCalendar = memo(function LiveCalendar({ accountId, refreshTick = 0 }: Props) {
  const now = new Date()
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 场次浮层：点击格子的锚点（rect 快照）与当日数据 */
  const [pop, setPop] = useState<PopState | null>(null)

  /** 校正请求进行中的 live_id（下拉禁用防连点） */
  const [savingCategory, setSavingCategory] = useState<string | null>(null)

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

  // 场次拉取（字段 2026-09-07：只检索主账号直播信息；loadSeq 防账号切换回写）
  const loadSeq = useRef(0)
  const load = useCallback(() => {
    if (accountId == null) return
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    api
      .liveSessions(accountId)
      .then((s) => {
        if (seq === loadSeq.current) setSessions(s)
      })
      .catch((e: Error) => {
        if (seq === loadSeq.current) setError(e.message || '场次加载失败')
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false)
      })
  }, [accountId])

  useEffect(() => {
    load()
  }, [load, refreshTick])

  // 数据刷新后浮层锚点已失效 → 关闭（月份/账号切换同理）
  useEffect(() => {
    setPop(null)
  }, [ym, accountId, sessions])

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

  /** 礼物/跨天展示已退役（user 2026-09-07：礼物数据暂不展示，之后取 danmakus 场次级详细数据）。
   *  42 格固定 6 行（设计稿）：首行从当月 1 号所在周一周起，含上/下月补位 */
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
      // 状态：有场次=live；无场次=tbd（休息/待定在渲染层按今天前后区分）
      const state: CellState = list.length > 0 ? 'live' : 'tbd'
      out.push({ date: d, key, inMonth, sessions: list, isToday, state })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym, byDay])

  /** 当月类型统计（导航栏右侧统计胶囊，服务端 category 口径，仅非零项） */
  const monthStats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of cells) {
      if (!c.inMonth) continue
      for (const s of c.sessions) {
        const t = keyOf(s)
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    const order = LIVE_TYPE_ORDER.map((t) => t.key)
    return order.map((key) => ({ key, n: counts.get(key) ?? 0 })).filter((t) => t.n > 0)
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

  const openCellPop = (c: DayCell, e: ReactMouseEvent<HTMLDivElement>) => {
    clearPopTimer()
    if (c.state !== 'live') {
      setPop(null)
      return
    }
    setPop({ key: c.key, rect: e.currentTarget.getBoundingClientRect(), sessions: c.sessions })
  }

  const closeCellPop = () => {
    clearPopTimer()
    popTimer.current = window.setTimeout(() => setPop(null), POP_CLOSE_GRACE_MS)
  }

  // Esc 关闭浮层
  useEffect(() => {
    if (!pop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pop])

  /** hover 浮层计时器（离开格子 → 120ms 宽限关闭，允许滑到浮层） */
  const popTimer = useRef<number | null>(null)
  const clearPopTimer = () => {
    if (popTimer.current != null) {
      window.clearTimeout(popTimer.current)
      popTimer.current = null
    }
  }

  /** 用户校正分类（v2 第⑦信号）：PUT/DELETE 后重拉（override/series/learned 后端全链重算） */
  const onPickCategory = async (s: LiveSession, value: string) => {
    const liveId = s.live_id
    if (!liveId || !accountId) return
    setSavingCategory(liveId)
    try {
      if (value === 'auto') await api.clearLiveSessionCategory(accountId, liveId)
      else await api.setLiveSessionCategory(accountId, liveId, value)
      load()
    } catch (e) {
      setError((e as Error).message || '分类保存失败')
    } finally {
      setSavingCategory(null)
    }
  }

  const renderCell = (c: DayCell) => {
    const first = c.sessions[0]
    const toneKey = first ? keyOf(first) : null

    let toneCls = ''
    if (c.state === 'live' && toneKey) toneCls = ` lc-tone-${toneKey}`
    else toneCls = ' tbd'
    // 月份指示（透明度）：非本月一律 pad 淡化，与场次状态无关
    if (!c.inMonth) toneCls += ' pad'
    if (c.isToday) toneCls += ' today'

    let badge = '待定'
    if (c.state === 'live' && toneKey) badge = liveTypeLabel(toneKey)
    // user 2026-09-07：当天没有直播（含礼物日，礼物展示已退役）一律显示休息；
    // 今天及以后（尚未发生）= 待定
    else if (c.key < todayKey) badge = '休息'

    return (
      <div
        key={c.key}
        className={'lc-cell' + toneCls}
        onMouseEnter={(e) => openCellPop(c, e)}
        onMouseLeave={closeCellPop}
      >
        <div className="lc-cell-head">
          <span className="lc-day">{c.date.getDate()}</span>
          <span className="lc-badge">{badge}</span>
        </div>
        {c.state === 'live' && first ? (
          <div className="lc-cell-body">
            <div className="lc-time-row">
              <span className="lc-time">{fmtTime(new Date(first.start_at))}</span>
              <span className="lc-count">{c.sessions.length} 场</span>
            </div>
            <span className="lc-cell-title">{first.live_title || '场次'}</span>
          </div>
        ) : null}
      </div>
    )
  }

  /** 浮层位置：优先格下方，越界翻上方、水平收进视口 */
  const popStyle = (() => {
    if (!pop) return undefined
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = 300
    const estimate = Math.min(430, 120 + pop.sessions.length * 74)
    const left = Math.min(Math.max(12, pop.rect.left), Math.max(12, vw - width - 12))
    const below = pop.rect.bottom + 8
    const top = below + estimate > vh ? Math.max(12, pop.rect.top - estimate - 8) : below
    return { left, top, width }
  })()

  const renderPop = () => {
    if (!pop || !popStyle) return null
    return createPortal(
      <div
        className="lc-pop"
        style={popStyle}
        role="tooltip"
        onMouseEnter={clearPopTimer}
        onMouseLeave={closeCellPop}
      >
        <div className="lc-pop-head">
          <span className="lc-pop-date">{pop.key}</span>
          <span className="lc-pop-count">{pop.sessions.length} 场</span>
        </div>
        <div className="lc-pop-list">
            {pop.sessions.map((s, i) => {
              const d0 = new Date(s.start_at)
              const d1 = s.end_at ? new Date(s.end_at) : null
              const t = keyOf(s)
              const meta: string[] = []
              if (s.area_name || s.parent_area_name) {
                meta.push([s.parent_area_name, s.area_name].filter(Boolean).join(' / '))
              }
              meta.push(`${fmtDur(s.duration_minutes)}${d1 ? '' : ' 进行中'}`.trim())
              const figures: string[] = []
              if ((s.total_income ?? 0) > 0) figures.push(`收益 ${fmtMoney(s.total_income)}`)
              if ((s.max_online_count ?? 0) > 0) figures.push(`峰值在线 ${s.max_online_count!.toLocaleString('zh-CN')}`)
              if ((s.danmakus_count ?? 0) > 0) figures.push(`弹幕 ${s.danmakus_count!.toLocaleString('zh-CN')}`)
              const srcs = (s.source ?? 'self').split('+').filter(Boolean)
              return (
                <div key={s.live_id ?? `${s.start_at}-${i}`} className="lc-pop-item">
                  <div className="lc-pop-item-row">
                    <span className={`lc-pop-badge lc-stat-pill--${t}`}>{liveTypeLabel(t)}</span>
                    <span className="lc-pop-title">{s.live_title || '场次'}</span>
                  </div>
                  <div className="lc-pop-meta">
                    {fmtTime(d0)} – {d1 ? fmtTime(d1) : '进行中'}
                    {meta.length ? ` · ${meta.join(' · ')}` : ''}
                  </div>
                  {figures.length > 0 && <div className="lc-pop-meta">{figures.join(' · ')}</div>}
                  {s.live_id ? (
                    <div className="lc-pop-edit">
                      <span className="lc-pop-edit-label">分类</span>
                      <select
                        className="lc-pop-select"
                        value={s.category ?? 'live'}
                        disabled={savingCategory === s.live_id}
                        onChange={(e) => onPickCategory(s, e.target.value)}
                      >
                        <option value="auto">自动</option>
                        {LIVE_TYPE_ORDER.map((t) => (
                          <option key={t.key} value={t.key}>{t.label}</option>
                        ))}
                      </select>
                      {s.category_from === 'override' && (
                        <span className="lc-pop-corr">已校正</span>
                      )}
                    </div>
                  ) : null}
                  <div className="lc-pop-src">数据源 {srcs.join(' + ')}</div>
                </div>
              )
            })}
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <div className="live-calendar">
      {/* 卡片标题（与归档卡标题同规格 16.5px/600）+ 空月提示 */}
      <div className="lc-title">
        直播日历
        {!loading && !error && monthStats.length === 0 && (
          <span className="lc-note">本月暂无直播记录</span>
        )}
      </div>

      {/* 导航行：左=月份浮片组（点击弹选月浮窗） · 右=当月类型统计胶囊（frame 10_642） */}
      <div className="lc-nav-row">
        <div className="lc-nav" ref={navRef}>
          <button type="button" title="上个月" className="lc-nav-btn" onClick={() => moveMonth(-1)}>
            <ChevronsLeft className="lc-nav-icon" />
          </button>
          <button type="button" className="lc-nav-pill" title="选择月份" onClick={openMonthPop}>
            <span className="lc-nav-text">{fmtMonth(ym.y, ym.m)}</span>
          </button>
          <button type="button" title="下个月" className="lc-nav-btn" onClick={() => moveMonth(1)}>
            <ChevronsRight className="lc-nav-icon" />
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

        {/* 当月类型统计胶囊（彩色胶囊 + 计数，设计稿 frame 10_642；服务端 category 口径） */}
        <div className="lc-stats">
          {monthStats.map((t) => (
            <div key={t.key} className="lc-stat">
              <span className={`lc-stat-pill lc-stat-pill--${t.key}`}>{liveTypeLabel(t.key)}</span>
              <span className="lc-stat-num">{t.n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 月历区（设计稿 frame 10_659：表头与网格 gap 5px） */}
      <div className="lc-body">
        {/* 星期表头（Mon.~Sun.，14px #727272 → --c-text-sub） */}
        <div className="lc-weekdays">
          {WEEKDAYS_EN.map((w) => (
            <div key={w} className="lc-weekday">{w}</div>
          ))}
        </div>

        {/* 月历网格：7 列 × 6 行，列/行距 4px */}
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

      {renderPop()}
    </div>
  )
})

export default LiveCalendar
