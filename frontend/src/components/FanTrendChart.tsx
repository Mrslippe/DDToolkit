import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, Bar, Brush, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CalendarRange, Loader2 } from 'lucide-react'
import type { FanTrendPoint } from '../api/types'
import { api } from '../api/api'
import { formatCount } from '../utils/format'

interface Props {
  /** 账号 id（null=无账号，显示空态）；切换账号自动重拉 */
  accountId: number | null
  /** 刷新信号（fetch-idle 边沿后重拉） */
  refreshTick?: number
}

interface DailyPoint {
  date: string
  fans: number | null
  delta: number | null
  /** 涨=粉 / 掉=灰（BarShape 直接取自数据点，免 Cell 索引错位） */
  barFill: string
}

const PINK = '#fb77a1'       // 主粉（--chart-1）：涨粉
const GRAY = '#a0aec0'       // 掉粉灰（浅灰蓝，浅底可见）
const GRID = 'rgba(210, 216, 222, 0.35)'
const MUTED = '#5b6c7e'

/** 数据容量档位（Brush 缩略图轨迹范围）：默认 3 个月，手动按钮切换 */
const PRESETS = [
  { key: '3m', label: '3个月', days: 90 },
  { key: '6m', label: '6个月', days: 180 },
  { key: '1y', label: '1年', days: 365 },
  { key: 'all', label: '全部', days: Infinity },
] as const
type PresetKey = (typeof PRESETS)[number]['key']

/** 窗口默认：当前容量档位内的最近 30 天 */
const DEFAULT_DAYS = 30

/** 粉丝轴域：窗口内 [min, max] 留 3% 余量并整 50（域更紧 → 曲线更细分见锯齿）；
    delta 域：对称 ±max×1.1 */
function fanDomain(values: (number | null)[]): [number, number] {
  const nums = values.filter((v): v is number => v != null)
  if (nums.length === 0) return [0, 1]
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const pad = Math.max((max - min) * 0.03, 5)
  return [Math.floor((min - pad) / 50) * 50, Math.ceil((max + pad) / 50) * 50]
}

function deltaDomain(values: (number | null)[]): [number, number] {
  const nums = values.filter((v): v is number => v != null)
  if (nums.length === 0) return [-1, 1]
  const maxAbs = Math.max(...nums.map((v) => Math.abs(v)))
  const cap = Math.ceil(maxAbs * 1.1)
  return [-cap, cap]
}

/* ── 柱形动画（JS rAF 驱动，重挂免疫）──
   recharts 拖动时内部 key=rectangle-x-y-value-i，窗口移动导致 BarShape 每帧
   销毁重建；CSS@keyframes/组件 state 都会被下一帧实例取代而"动画约等于没有"。
   双通道并行，共享每柱一条 rAF 循环：
   ① 出场通道 barProgress：新柱 opacity .3→1 + scaleY .8→1（easeOutCubic 220ms）
   ② 坐标通道 barCur→barTarget：Y 轴域随窗口重算 → y/height 跳变时平滑过渡
      （新目标写入 barTarget，循环每帧把 rect 属性从 cur 插值到 target,
        duration 280ms easeOutCubic）
   · 模块级 Map 跨实例共享：重挂的新实例直接读到进度/当前坐标，从当前值延续
   · 零 React 重渲染：动画直接操作 DOM（rect.setAttribute / style）
   · 滚动/拖动期间 target 多帧变化：cur 始终从上次渲染值续走，不叠加不抖动 */

const BAR_REVEAL_MS = 220
const BAR_MOVE_MS = 280

/** 每柱出场进度（0→1） */
const barProgress = new Map<string, number>()
/** 每柱动画当前实际坐标（显示值，跨实例共享） */
const barCur = new Map<string, { x: number; y: number; w: number; h: number }>()
/** 每柱最新目标坐标（props 每次更新写入） */
const barTarget = new Map<string, { x: number; y: number; w: number; h: number }>()
/** 每柱当前活跃 <rect> 元素（重挂时替换） */
const barEls = new Map<string, SVGRectElement | null>()
/** 每柱 rAF 句柄（一次只跑一个循环） */
const barRafs = new Map<string, number>()
/** 每柱上一 tick 时间戳（帧率无关推进用） */
const barLastTick = new Map<string, number>()

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

type RectGeom = { x: number; y: number; w: number; h: number }

/** 拖动中开关（BarShape 通过 pumpBar 注入，周知循环直接吸附） */
const barDragging = { on: false }

/** 单柱 rAF tick：出场与坐标插值并行推进（帧率无关：按真实 Δt 推进） */
function barTick(date: string, now: number) {
  const el = barEls.get(date)
  const cur = barCur.get(date)
  const target = barTarget.get(date)
  if (!el || !cur || !target) {
    barRafs.set(date, window.requestAnimationFrame((t) => barTick(date, t)))
    return
  }
  const last = barLastTick.get(date) ?? now
  const dt = Math.min(Math.max(now - last, 0), 64) // clamp：切后台回来不瞬移
  barLastTick.set(date, now)

  // ① 出场进度（新柱 0 起步；已出现=1 不再动）
  let p = barProgress.get(date) ?? 0
  if (p < 1) {
    p = Math.min(1, p + dt / BAR_REVEAL_MS)
    barProgress.set(date, p)
  }

  if (!barDragging.on) {
    // ② 坐标插值（非拖动态）：剩余差值按 Δt/MOVE_MS 比例推进（指数收敛）
    const k = Math.min(1, dt / BAR_MOVE_MS)
    if (Math.abs(cur.x - target.x) > 0.5 || Math.abs(cur.y - target.y) > 0.5 || Math.abs(cur.w - target.w) > 0.5 || Math.abs(cur.h - target.h) > 0.5) {
      cur.x += (target.x - cur.x) * k
      cur.y += (target.y - cur.y) * k
      cur.w += (target.w - cur.w) * k
      cur.h += (target.h - cur.h) * k
    } else {
      cur.x = target.x
      cur.y = target.y
      cur.w = target.w
      cur.h = target.h
    }
  } else {
    // 拖动中：全量吸附（存量柱贴目标立即显示，不做跨图漂移——漂移=新柱误从下方长距离插值）
    cur.x = target.x
    cur.y = target.y
    cur.w = target.w
    cur.h = target.h
  }

  el.setAttribute('x', String(cur.x))
  el.setAttribute('y', String(cur.y))
  el.setAttribute('width', String(cur.w))
  el.setAttribute('height', String(cur.h))
  const ease = easeOutCubic(p)
  el.style.opacity = String(0.3 + 0.7 * ease)
  el.style.transform = `scaleY(${0.8 + 0.2 * ease})`
  el.style.transformOrigin = `${cur.x + cur.w / 2}px ${cur.y + cur.h}px`

  const settled = p >= 1 && cur.x === target.x && cur.y === target.y && cur.w === target.w && cur.h === target.h
  if (settled) {
    barRafs.delete(date)
    barLastTick.delete(date)
  } else {
    barRafs.set(date, window.requestAnimationFrame((t) => barTick(date, t)))
  }
}

/** 注册/更新动画状态：props 每帧变化时调用（重挂/移窗总计通用） */
function pumpBar(date: string, geom: RectGeom, fresh: boolean) {
  if (fresh) {
    barCur.set(date, { ...geom })
    barTarget.set(date, { ...geom })
    if (!barProgress.has(date)) barProgress.set(date, 0)
  } else {
    barTarget.set(date, { ...geom })
    const cur = barCur.get(date)
    if (!cur) barCur.set(date, { ...geom })
  }
  if (!barRafs.has(date)) {
    barLastTick.delete(date)
    barRafs.set(date, window.requestAnimationFrame((t) => barTick(date, t)))
  }
}

interface BarShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
  payload?: DailyPoint & { date: string }
}

const BarShape = memo(function BarShape({ x = 0, y = 0, width = 0, height = 0, payload }: BarShapeProps) {
  const date = payload?.date
  const rectRef = useRef<SVGRectElement>(null)

  useLayoutEffect(() => {
    const el = rectRef.current
    if (!el || !date) return
    const isFresh = !barProgress.has(date)
    barEls.set(date, el)
    // 注册/更新状态，启动循环（已跑则直接更新 target）
    pumpBar(date, { x, y, w: width, h: height }, isFresh)
    // ★ 同步写入当前几何：消掉"重挂后 rect 空几何 → rAF 下一帧才写"的空窗闪动
    const cur = barCur.get(date)
    if (cur) {
      el.setAttribute('x', String(cur.x))
      el.setAttribute('y', String(cur.y))
      el.setAttribute('width', String(cur.w))
      el.setAttribute('height', String(cur.h))
      const p = barProgress.get(date) ?? 1
      const ease = easeOutCubic(Math.min(1, p))
      el.style.opacity = String(0.3 + 0.7 * ease)
      el.style.transform = `scaleY(${0.8 + 0.2 * ease})`
      el.style.transformOrigin = `${cur.x + cur.w / 2}px ${cur.y + cur.h}px`
    }
    return () => {
      if (barEls.get(date) === el) barEls.set(date, null)
    }
    // 坐标变化不重启：仅在 target 系上更新（pumpBar 内条件启动）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, x, y, width, height])

  // 几何由 rAF 循环直接写 DOM（React 不设 x/y/width/height——
  // 避免 React 的 attribute 写入与插值循环竞争；首帧循环启动前由
  // useLayoutEffect 里的 pumpBar 立即把 cur 写上去，无空白帧）
  return (
    <g>
      <rect
        ref={rectRef}
        fill={payload?.barFill ?? PINK}
        rx={0}
        style={{ pointerEvents: 'none' }}
      />
    </g>
  )
})

/**
 * 粉丝趋势卡（v0.9.5 重建 + v0.9.6 修正，参考用户展示图 + 项目粉系浅底）：
 * - 双轴 ComposedChart：粉丝数 Area（主粉渐变色）+ 日增粉 Bar（涨=粉 / 掉=灰）；
 * - 数据容量档位按钮（3个月/6个月/1年/全部）：Brush 缩略图轨迹 = 当前档位数据，
 *   默认 3 个月（90 天点，渲染轻快不卡顿），档位切换自动重置窗口；
 * - 底部 Brush 缩略图：dataKey=fans（数值键才能画出迷你图），拖拽滑块/拉伸两端
 *   调整展示窗口（startIndex/endIndex 受控，可一键回默认窗口）；
 * - 纵轴域随【当前可见窗口数据】动态计算（recharts auto domain 按可见数据重算）；
 * - 动画：入场/换窗 400ms 过渡。
 */
const FanTrendChart = memo(function FanTrendChart({ accountId, refreshTick = 0 }: Props) {
  const [points, setPoints] = useState<FanTrendPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 容量档位（默认 3 个月） */
  const [preset, setPreset] = useState<PresetKey>('3m')
  /** 当前窗口 [startIndex, endIndex]（容量数据索引；null=未就绪） */
  const [range, setRange] = useState<[number, number] | null>(null)
  /** Brush 拖动中：临时关 recharts 内置动画保跟手 */
  const [dragging, setDragging] = useState(false)
  const dragTimer = useRef<number>()
  // Brush onChange rAF 节流：target 暂存 + 帧内提交
  const brushRafRef = useRef(0)
  const brushTargetRef = useRef<[number, number] | null>(null)
  useEffect(
    () => () => {
      window.clearTimeout(dragTimer.current)
      window.cancelAnimationFrame(brushRafRef.current)
    },
    [],
  )
  /** 拖动结束统一收尾：只关 recharts 内置动画标记 + 柱恢复平滑收敛 */
  const settleDrag = () => {
    setDragging(false)
    barDragging.on = false
  }

  useEffect(() => {
    if (accountId == null) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .fanTrend(accountId)
      .then((p) => {
        if (!cancelled) setPoints(p)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || '趋势数据加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, refreshTick])

  /** 按日聚合（每日取后端序列最后值）+ 逐日差分（首日/断档 null） */
  const daily = useMemo<DailyPoint[]>(() => {
    const map = new Map<string, { date: string; fans: number }>()
    for (const p of points) {
      map.set(p.date, { date: p.date, fans: p.fans })
    }
    const sorted = [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
    const out: DailyPoint[] = []
    let prev: number | null = null
    for (const d of sorted) {
      const delta = prev != null ? d.fans - prev : null
      out.push({
        date: d.date,
        fans: d.fans,
        delta,
        barFill: (delta ?? 0) >= 0 ? PINK : GRAY,
      })
      prev = d.fans
    }
    return out
  }, [points])

  /** 当前容量档位数据（渲染源，数据量 = 档位天数） */
  const capacity = useMemo<DailyPoint[]>(() => {
    const days = PRESETS.find((p) => p.key === preset)?.days ?? 90
    return Number.isFinite(days) ? daily.slice(-days) : daily
  }, [daily, preset])

  /* ── 图表主区抓手平移（pan）：按住拖动 = 平移时间窗口（窗口宽度不变）
     性能三件套：①mousedown 一次性缓存布局（不再每帧读 clientWidth）；
     ②mousemove 只算目标索引存 ref，rAF 帧内才 setState（一帧最多一次重渲染）；
     ③拖动期间 dragging=true 动画关（不翻转），pointer-events:none 旁路 recharts
     的 mousemove/tooltip 链路（否则 tooltip state 更新叠加拖动重渲染 = 卡）── */
  const bodyRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{
    startX: number
    range0: number
    winSize: number
    itemW: number
    maxStart: number
    target: number
    raf: number
  } | null>(null)
  const [panning, setPanning] = useState(false)

  const onBodyMouseDown = (e: React.MouseEvent) => {
    if (!range || capacity.length === 0) return
    // Brush 缩略图/重置/档位区域不触发 pan（它们有自己的交互）
    const t = e.target as Element
    if (t.closest?.('.recharts-brush, .fan-chart-reset, .fan-presets')) return
    const el = bodyRef.current
    if (!el) return
    const plotW = Math.max(el.clientWidth - 48 - 42 - 14, 1)
    const winSize = range[1] - range[0]
    panRef.current = {
      startX: e.clientX,
      range0: range[0],
      winSize,
      itemW: plotW / (winSize + 1),
      maxStart: Math.max(capacity.length - 1 - winSize, 0),
      target: range[0],
      raf: 0,
    }
    setPanning(true)
    setDragging(true) // 一次性关动画，拖动期间不再翻转
    barDragging.on = true // 柱动画吸附模式：拖动中存量柱贴目标，禁止跨图漂移
  }

  useEffect(() => {
    if (!panning) return
    let frameCounter = 0
    const onMove = (e: MouseEvent) => {
      const pan = panRef.current
      if (!pan) return
      // 以 pan 起点为基准持续重算（不叠加误差），只存目标帧内提交
      const deltaIndex = Math.round((pan.startX - e.clientX) / pan.itemW)
      const s = Math.min(Math.max(pan.range0 + deltaIndex, 0), pan.maxStart)
      pan.target = s
      if (pan.raf) return
      pan.raf = window.requestAnimationFrame(() => {
        const p = panRef.current
        pan.raf = 0
        if (!p) return
        // 隔帧提交：图表全量重渲染减半（拖动中 30~40fps 观感依旧跟手，
        // 但 recharts 布局/坐标计算负担明显下降——当前仅柱几何由 rAF 驱动，
        // 其他元素仍随 setRange 全量重算）
        frameCounter += 1
        if (frameCounter % 2 === 0) {
          const s2 = p.target
          if (s2 !== p.range0) setRange([s2, s2 + p.winSize])
        }
      })
    }
    const onUp = () => {
      const pan = panRef.current
      if (pan?.raf) {
        window.cancelAnimationFrame(pan.raf)
        pan.raf = 0
      }
      panRef.current = null
      setPanning(false)
      barDragging.on = false // 恢复平滑收敛（存量柱高度向最终 target 缓动）
      settleDrag() // 松开 → 重挂播放入场动画（新进入窗口的曲线/柱呈现）
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const pan = panRef.current
      if (pan?.raf) window.cancelAnimationFrame(pan.raf)
    }
  }, [panning])

  /** 数据/档位就绪：窗口重置为该容量尾部 DEFAULT_DAYS 天 */
  useEffect(() => {
    if (capacity.length === 0) return
    setRange([Math.max(0, capacity.length - DEFAULT_DAYS), capacity.length - 1])
  }, [capacity])

  const isDefaultWindow = useMemo(() => {
    if (!range) return true
    return range[0] === Math.max(0, capacity.length - DEFAULT_DAYS) && range[1] === capacity.length - 1
  }, [range, capacity])

  /** 窗口内数据切片（Y 轴域与概览的数据源） */
  const view = useMemo(() => {
    if (!range || capacity.length === 0) return capacity
    const [s, e] = range
    return capacity.slice(s, e + 1)
  }, [capacity, range])

  /** 纵轴域随窗口动态：据切片数据计算（涨跌幅对窗口；粉丝数留 8% 余量） */
  const fanDomainVal = useMemo(() => fanDomain(view.map((d) => d.fans)), [view])
  const deltaDomainVal = useMemo(() => deltaDomain(view.map((d) => d.delta)), [view])

  /** 头部概览：容量末值 1d/7d/30d 涨粉 */
  const overview = useMemo(() => {
    const vals = capacity.filter((d) => d.fans != null).map((d) => d.fans as number)
    const last = vals[vals.length - 1]
    if (last == null) return null
    const diff = (n: number) =>
      vals.length > n && vals[vals.length - 1 - n] != null
        ? last - vals[vals.length - 1 - n]
        : null
    return { d1: diff(1), d7: diff(7), d30: diff(30) }
  }, [capacity])

  const fmtDate = (d: string) => (d ? d.slice(5) : '') // MM-DD
  const fmtDelta = (v: number | null) =>
    v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString()}`

  return (
    <div className="fan-chart">
      {/* 卡片标题（与直播日历同规格 16px #182e41） */}
      <div className="fc-title">粉丝趋势</div>

      {/* 头部：左=1d/7d/30d 概览 · 右=容量档位按钮 + 窗口回退 */}
      <div className="fan-chart-head">
        <div className="fan-chart-summary">
          {overview ? (
            <>
              <span className="fan-stat">1d <b>{fmtDelta(overview.d1)}</b></span>
              <span className="fan-stat">7d <b>{fmtDelta(overview.d7)}</b></span>
              <span className="fan-stat">30d <b>{fmtDelta(overview.d30)}</b></span>
            </>
          ) : (
            <span className="fan-chart-empty-summary">—</span>
          )}
        </div>
        <div className="fan-chart-tools">
          <div className="fan-presets">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`fan-preset${preset === p.key ? ' on' : ''}`}
                onClick={() => setPreset(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {!isDefaultWindow && (
            <button type="button" className="fan-chart-reset" onClick={() => setRange(null)}>
              <CalendarRange className="size-3.5" />
              重置窗口
            </button>
          )}
        </div>
      </div>

      {/* 图区：主区抓手=按住拖动平移窗口（panning 时禁 tooltip 选区与十字光标） */}
      <div
        className={`fan-chart-body${panning ? ' panning' : ''}`}
        ref={bodyRef}
        onMouseDown={onBodyMouseDown}
      >
        {loading && (
          <div className="lc-state">
            <Loader2 className="lc-state-icon" />
          </div>
        )}
        {!loading && error && <div className="lc-state lc-error">{error}</div>}
        {!loading && !error && capacity.length === 0 && (
          <div className="lc-state">暂无粉丝趋势数据</div>
        )}
        {!loading && !error && capacity.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            {/* accessibilityLayer 关闭：避免点击 SVG 后焦点落在 RootSurface(tabIndex=0)
                被全局 outline-ring/50 描成粉色选中框（user 2026-09-06 反馈） */}
            <ComposedChart data={capacity} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
              <defs>
                <linearGradient id="fanFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PINK} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={PINK} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={42}
                tickFormatter={fmtDate}
                tick={{ fontSize: 11, fill: MUTED }}
              />
              {/* fans 轴：域随窗口切片数据动态；tickCount 提密 → 刻度细分 */}
              <YAxis
                yAxisId="fans"
                domain={fanDomainVal}
                tickCount={6}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => formatCount(v)}
                tick={{ fontSize: 11, fill: MUTED }}
              />
              {/* delta 轴：域随窗口切片数据动态（对称 ±max） */}
              <YAxis
                yAxisId="delta"
                orientation="right"
                domain={deltaDomainVal}
                tickCount={5}
                tickLine={false}
                axisLine={false}
                width={42}
                tickFormatter={(v: number) => formatCount(v)}
                tick={{ fontSize: 11, fill: MUTED }}
              />
              <Tooltip
                cursor={{ stroke: 'rgba(148,163,184,0.4)', strokeDasharray: '4 3' }}
                contentStyle={{
                  borderRadius: 12,
                  border: '1px solid rgba(15, 23, 42, 0.06)',
                  boxShadow: '0 4px 16px rgba(15, 23, 42, 0.1)',
                  fontSize: 12.5,
                }}
                labelFormatter={(label) => String(label)}
                formatter={(value, name) => {
                  if (name === 'fans') return [`${formatCount(Number(value))} 粉`, '粉丝数']
                  return [fmtDelta(value as number | null), '日增粉']
                }}
              />
              <Bar
                yAxisId="delta"
                dataKey="delta"
                name="日增粉"
                isAnimationActive={false}
                maxBarSize={14}
                shape={<BarShape />}
              />
              <Area
                yAxisId="fans"
                type="monotone"
                dataKey="fans"
                name="粉丝数"
                stroke={PINK}
                strokeWidth={2}
                fill="url(#fanFill)"
                dot={false}
                connectNulls
                isAnimationActive={!dragging}
                animationDuration={400}
                animationBegin={0}
              />
              {/* 时间轴缩略图（Panorama）：children 传入迷你图元素才渲染轨迹——
                  Brush 内部 Panorama 克隆 children 作为 compact 迷你图；
                  dataKey 需为数值键（fans），字符串键画不出图；
                  窗口 = 默认最近 30 天，可拖滑块/拉伸两端缩放 */}
              <Brush
                key={`brush-${preset}-${capacity.length}`}
                dataKey="fans"
                height={56}
                stroke={PINK}
                fill="rgba(251,119,161,0.05)"
                travellerWidth={14}
                startIndex={range?.[0]}
                endIndex={range?.[1]}
                onChange={(e: { startIndex?: number; endIndex?: number }) => {
                  const s = e.startIndex ?? 0
                  const en = e.endIndex ?? capacity.length - 1
                  brushTargetRef.current = [s, Math.max(s, en)]
                  if (brushRafRef.current) return
                  // rAF 节流：一帧最多提交一次窗口（Brush 拖动 event 高频，直接 setRange 会每事件全量重渲染）
                  brushRafRef.current = window.requestAnimationFrame(() => {
                    brushRafRef.current = 0
                    const t = brushTargetRef.current
                    if (!t) return
                    setRange(t)
                    // 跟手优化：拖动期间禁用动画，停顿 250ms 后 settle（恢复动画 + reveal 重挂）
                    setDragging(true)
                    barDragging.on = true // 柱吸附模式（Brush 拖拽中）
                    window.clearTimeout(dragTimer.current)
                    dragTimer.current = window.setTimeout(settleDrag, 250)
                  })
                }}
                tickFormatter={() => ''}
              >
                <AreaChart data={capacity}>
                  <Area
                    dataKey="fans"
                    type="monotone"
                    stroke={PINK}
                    strokeWidth={1}
                    fill="rgba(251,119,161,0.12)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </Brush>
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
})

export default FanTrendChart
