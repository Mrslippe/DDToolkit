import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import type { LiveSession } from '../api/types'
import { api } from '../api/api'
import OverlayScroll from './OverlayScroll'
import FloatPill from './common/FloatPill'
import StateBlock from './common/StateBlock'
import { LIVE_TYPE_ORDER, liveTypeLabel } from '../utils/liveType'
// 纯展示格式化已搬到 components/live/（可 vitest 直测）；此处只保留渲染/交互常量
import { calendarSourceLabel, dayKeyIso, fmtDur, fmtMoney, fmtMonth, fmtTime, keyOf } from './live/liveCalendarFmt'
// 取数与状态机已搬到 components/live/useLiveSessions（见其文件顶部的顺序契约说明）
import {
  POP_CLOSE_GRACE_MS, useLiveSessions,
} from './live/useLiveSessions'
import type { PopState } from './live/useLiveSessions'
// 场次详情弹窗（含词云与破泡状态）已搬到 components/live/LiveSessionDialog
import LiveSessionDialog from './live/LiveSessionDialog'

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

// `PopState` / `DetailState` / `POP_CLOSE_GRACE_MS` 随取数状态机一起搬到
// `components/live/useLiveSessions.ts`，此处改为从那里 import（类型定义只有一处）。
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
 *     鼠标滑向浮层有 120ms 宽限不闪关；Esc 关闭；保持纯信息展示（user 2026-09-07：
 *     分类校正移出浮层 → 点击日期格进详情弹窗）；
 *   · 点击日期格 → 独立详情弹窗（user 2026-09-07）：
 *     直播信息（起止/分区/收益/峰值/弹幕/数据源/中断段数）+ 分类校正（点左上角胶囊 →
 *     下拉栏全部彩色分类胶囊，点选取；override 源）+
 *     「弹幕信息」（danmakus /api/v2/live 词云与总量，2026-09-07 已接入）+
 *     「直播内容分析」预留区块（analysis 接口先留，内容之后再做）；
 *   · 月份切换滑动动画（user 2026-09-07：前进/后退方向感，keyed 重放）；
 *   · 无场次的格子：今天以前 = 「休息」；今天及以后 = 「待定」（user 2026-09-07）；
 *   · 礼物数据暂不展示（user 2026-09-07：之后从 danmakus 取场次级详细数据；
 *     浮层「收益」即 danmakus 场次级），格内礼物行/当日礼物合计已退役；
 *   · 类型徽章/统计用后端 category（v2 多信号：校正>系列>标题评分>词库>分区>纪念日），
 *     服务端缺失时前端关键词兜底。
 */
const LiveCalendar = memo(function LiveCalendar({ accountId, refreshTick = 0 }: Props) {
  const now = new Date()
  /** 场次浮层：点击格子的锚点（rect 快照）与当日数据。
   *  留在组件侧 —— 它承载 DOM rect，与渲染强耦合；hook 只通过 `onDataRefresh` 通知关闭。 */
  const [pop, setPop] = useState<PopState | null>(null)
  /** 取数与派生状态（月份/场次/详情/分类下拉/月份浮窗）——见 hooks 文件顶部的顺序契约说明。
   *  `now` 每次渲染现取：保持"todayKey 随渲染更新"的既有语义。 */
  const {
    ym, setYm, sessions, loading, error, setError, navDir, setNavDir,
    detail, setDetail, catPopOpen, setCatPopOpen, catPopRef,
    monthPopOpen, setMonthPopOpen, popYear, setPopYear, navRef, reload, reloadDetail,
  } = useLiveSessions(accountId, refreshTick, now, () => setPop(null))

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
    setNavDir(delta > 0 ? 1 : -1)
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
    setNavDir(popYear * 12 + m >= ym.y * 12 + ym.m ? 1 : -1)
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
    try {
      if (value === 'auto') {
        if (s.category_from === 'override') {
          await api.clearLiveSessionCategory(accountId, liveId)
        }
      } else {
        await api.setLiveSessionCategory(accountId, liveId, value)
      }
      reload()
      // 详情弹窗内校正 → 同步刷新详情（徽章/分类来源即时更新）
      await reloadDetail(liveId)
    } catch (e) {
      setError((e as Error).message || '分类保存失败')
    }
  }

  /** 打开场次详情弹窗（点击日期格；当日多场从第一场起，顶部可切换） */
  const openDetail = (c: DayCell) => {
    clearPopTimer()
    setPop(null)
    if (c.state !== 'live' || c.sessions.length === 0) return
    const first = c.sessions[0]
    setDetail({
      key: c.key, sessions: c.sessions, idx: 0,
      data: null, loading: !!(first.live_id && accountId),
    })
    if (first.live_id && accountId) {
      api.liveSessionDetail(accountId, first.live_id)
        .then((d) => setDetail((p) => (p && p.key === c.key ? { ...p, data: d, loading: false } : p)))
        .catch(() => setDetail((p) => (p && p.key === c.key ? { ...p, loading: false } : p)))
    }
  }

  /** 详情弹窗内切换当日第 idx 场 */
  const switchDetailIdx = (idx: number) => {
    if (!detail || idx === detail.idx) return
    const s = detail.sessions[idx]
    const key = detail.key
    setDetail({ ...detail, idx, data: null, loading: !!(s.live_id && accountId) })
    if (s.live_id && accountId) {
      api.liveSessionDetail(accountId, s.live_id)
        .then((d) => setDetail((p) => (p && p.key === key ? { ...p, data: d, loading: false } : p)))
        .catch(() => setDetail((p) => (p && p.key === key ? { ...p, loading: false } : p)))
    }
  }

  // Esc 关闭详情弹窗
  useEffect(() => {
    if (!detail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetail(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // `setDetail` 是 useState 的 setter（React 保证引用恒定，漏它不会导致陈旧闭包）；
    // 这是 eslint 基线的已知提示，不是 bug（2026-09-13）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail])

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
        onClick={() => openDetail(c)}
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
      <OverlayScroll className="lc-pop" style={popStyle} role="tooltip">
        <div onMouseEnter={clearPopTimer} onMouseLeave={closeCellPop}>
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
              if ((s.segment_count ?? 1) > 1) meta.push(`中断续播·${s.segment_count} 段合并`)
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
                  <div className="lc-pop-src">数据源 {srcs.join(' + ')}</div>
                </div>
              )
            })}
          </div>
        </div>
      </OverlayScroll>,
      document.body,
    )
  }

  /** 详情弹窗已搬到 `components/live/LiveSessionDialog`
   *  （含词云 top40 派生、破泡计数/恢复信号等只服务弹窗的状态）。
   *  这里只留「是否渲染」与三个受父级状态驱动的入参。 */

  return (
    <div className="live-calendar">
      {/* 卡片标题（与归档卡标题同规格 16.5px/600）+ 数据来源说明 / 空月提示。
          2026-09-08（用户）：入口「不明确」其实是因为根本没有手动入口——
          场次在收录该 V 时自动回填、之后每日同步，直播状态随账号抓取更新。
          R3（2026-09-13）：从含糊的「数据自动同步」改成**点名来源**，并按实际数据
          判定是否含本地快照补段（场次 `source` 里的 `+self`）。 */}
      <div className="lc-title">
        直播日历
        <span
          className="card-src-note"
          title={
            '场次来自 danmakus 第三方索引（收录该 V 时回填历史，之后每日同步）；'
            + '本工具 5 分钟一轮的直播轮询快照用于补中断段与校正起止。'
          }
        >
          {!loading && !error && monthStats.length === 0
            ? '本月暂无直播记录 · 数据自动同步'
            : calendarSourceLabel(sessions)}
        </span>
        {/* 有旧数据时刷新失败：保留网格 + 如实说一句（R2①：不再整块切成"加载中"） */}
        {error && sessions.length > 0 && (
          <span className="card-refresh-failed" title={error}>刷新失败，显示上次数据</span>
        )}
      </div>

      {/* 导航行：左=月份浮片组（点击弹选月浮窗） · 右=当月类型统计胶囊（frame 10_642） */}
      <div className="lc-nav-row">
        <div className="lc-nav" ref={navRef}>
          <FloatPill shape="icon" title="上个月" onClick={() => moveMonth(-1)}>
            <ChevronsLeft className="lc-nav-icon" />
          </FloatPill>
          <FloatPill shape="text" title="选择月份" onClick={openMonthPop}>
            <span className="lc-nav-text">{fmtMonth(ym.y, ym.m)}</span>
          </FloatPill>
          <FloatPill shape="icon" title="下个月" onClick={() => moveMonth(1)}>
            <ChevronsRight className="lc-nav-icon" />
          </FloatPill>

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

        {/* 月历网格：7 列 × 6 行，列/行距 4px（keyed 重放月份切换滑动动画）。
            R2①（2026-09-13）：`loading` 只在**首次加载（还没有任何场次）**时接管网格 ——
            此前每次 `fetch-idle`（定时动态流每轮都会发，约 80s 一次）都会让 refreshTick +1 →
            reload → loading=true → 42 格整块消失再重建，看起来就是"日历在闪"。
            现在后台刷新静默替换数据，网格不卸载。 */}
        <div key={`${ym.y}-${ym.m}`} className={`lc-grid-anim${navDir === 1 ? '' : ' back'}`}>
          <div className="lc-grid">
            {loading && sessions.length === 0 && <StateBlock kind="loading" />}
            {error && sessions.length === 0 && <StateBlock kind="error" text={error} />}
            {sessions.length > 0 && cells.map((c) => renderCell(c))}
          </div>
        </div>
      </div>

      {renderPop()}
      {detail && (
        <LiveSessionDialog
          detail={detail}
          catPopOpen={catPopOpen}
          setCatPopOpen={setCatPopOpen}
          catPopRef={catPopRef}
          onClose={() => setDetail(null)}
          onSwitchIdx={switchDetailIdx}
          onPickCategory={onPickCategory}
          accountId={accountId}
        />
      )}
    </div>
  )
})

export default LiveCalendar
