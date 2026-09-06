import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
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

/* ── 柱动画单一通道（v0.9.22 简化版）──
   一切动画 = BarsOverlay 对【几何变化】的自然响应：无事件总线、无 settle spec、
   无双通道、无切换——flash/重影类竞态从根上消除：
   · BarsOverlay 常驻挂载（与图表同生命周期），永远绘制【全部窗口柱】；
     recharts 原生柱永久隐藏（CSS 规则，从不切换）
   · 驱动器 = 每帧几何 diff（BarShape 写入的 curGeom 快照）：
     · 新日期（无上帧几何）→ 键帧生长（出现即播，340ms 后转 morph）
     · 既有柱 → 高度 morph：旧→新几何的 scale 差作 transform，180ms 追帧
       （浏览器补间）；稳定帧 transform 归 none（过渡取平 = 零动画）
     · x/宽度即时更新（槽位步进不滞后于实时曲线）；锚点 = 柱的零线端
   · 拖动/刷选/换档/加载/刷新全部自动覆盖——几何变化本身就是"事件"；
   铁律：recharts 柱 key=rectangle-x-y-value-i 每帧重挂 → 动画全部寄生在
   自持 Overlay（与 recharts svg 逐像素同框），曲线/轴/brush 保持 recharts 原生实时。 */

/** 柱几何快照（可渲染 rect 值 + 填充色 + 生长锚点端）
    delta 域对称 ±cap → 零线固定于绘图区中心：
    正值柱 rect 底边 = 零线 → 锚点 bottom（50% 100%）；
    负值柱 rect 顶边 = 零线 → 锚点 top（50% 0%） */
interface BarGeom {
  x: number
  y: number
  width: number
  height: number
  fill: string
  origin: '50% 100%' | '50% 0%'
}

/** 当前渲染帧的柱几何（BarShape 渲染期写入；Overlay 唯一目标源，幂等） */
const curGeom = new Map<string, BarGeom>()

/** 入场期截止（date → 到期时间）：键帧播完（260ms < 340ms 生命期）后转 morph */
const enterUntil = new Map<string, number>()

const ENTRY_MS = 260
const ENTER_LIFE_MS = 340
const LIVE_MORPH_MS = 180

/** 高度 morph：仅 scale（x/宽度即时更新，不参与转换）；
    锚点 = 柱的零线端 → 缩放在零线静止，另一端平滑伸缩 */
function fromHeight(b: BarGeom, t: BarGeom): string {
  const ky = t.height > 0 ? b.height / t.height : 0
  const f = (n: number) => String(Math.round(n * 100) / 100)
  return `scale(1, ${f(ky)})`
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
  /* recharts 对【负值（掉粉）】传的是负 height（y 在柱底、height<0，向上长）——
     内置默认形状用 path 绘制（负号即方向），自绘 <rect> 必须翻转，
     否则 SVG 报 "attribute height: A negative value is not valid"：
     顶边 = min(y, y+height)，高 = |height| */
  const rectTop = Math.min(y, y + height)
  const rectH = Math.abs(height)
  if (date) {
    // 渲染期几何快照（幂等；父组件渲染先于子组件，转场基准取其"变更前"值）
    curGeom.set(date, {
      x,
      y: rectTop,
      width,
      height: rectH,
      fill: payload?.barFill ?? PINK,
      origin: (payload?.delta ?? 0) >= 0 ? '50% 100%' : '50% 0%',
    })
  }
  if (width <= 0 || rectH <= 0) return null

  return (
    <g>
      <rect
        x={x}
        y={rectTop}
        width={width}
        height={rectH}
        fill={payload?.barFill ?? PINK}
        rx={0}
      />
    </g>
  )
})

/** BarsOverlay：常驻绘制【全部窗口柱】——
    新日期 → CSS 键帧生长（出现即播，340ms 后转 morph）；
    既有柱 → WAAPI 高度 morph：每提交帧 启动 animate(旧几何 → 当前几何)，
    取消旧动画、立即接管（effect 在 paint 前执行 → 无中间帧闪跳）；
    大跳变（高柱入窗→域缩放）与连续追帧同样精确；
    x/宽度即时更新（槽位步进不滞后于实时曲线）；元素按 date 键控稳定 */
const BarsOverlay = memo(function BarsOverlay({ dates }: { dates: string[] }) {
  const prevGeomRef = useRef<Map<string, BarGeom>>(new Map(curGeom)) // 挂载帧 = 当前几何（无动画起点）
  const elsRef = useRef(new Map<string, SVGRectElement>())
  const animsRef = useRef<{ d: string; from: string }[]>([])
  const now = performance.now()
  const nextPrev = new Map<string, BarGeom>()
  const rects: ReactElement[] = []
  for (const d of dates) {
    const g = curGeom.get(d)
    if (!g) continue
    nextPrev.set(d, g)
    const until = enterUntil.get(d)
    if (until != null) {
      if (now < until) {
        // 入场期：键帧生长（元素持续存在，键帧不重播；几何随帧更新）
        rects.push(
          <rect
            key={d}
            className="ov-bar"
            x={g.x}
            y={g.y}
            width={g.width}
            height={g.height}
            fill={g.fill}
            style={{
              animation: `lc-bar-grow ${ENTRY_MS}ms ease-out both`,
              transformOrigin: g.origin,
            }}
          />,
        )
        continue
      }
      enterUntil.delete(d) // 入场期满 → morph 接管（填充态释放）
    }
    if (!prevGeomRef.current.has(d)) {
      // 新入柱：键帧生长（即时生效，无交错——单柱入场/批量入场同样自然的 260ms）
      enterUntil.set(d, now + ENTER_LIFE_MS)
      rects.push(
        <rect
          key={d}
          className="ov-bar"
          x={g.x}
          y={g.y}
          width={g.width}
          height={g.height}
          fill={g.fill}
          style={{
            animation: `lc-bar-grow ${ENTRY_MS}ms ease-out both`,
            transformOrigin: g.origin,
          }}
        />,
      )
      continue
    }
    // 既有柱：几何变化 → 登记 WAAPI 动画（旧几何 → 当前几何）
    const p = prevGeomRef.current.get(d)
    if (p && (p.y !== g.y || p.height !== g.height)) {
      animsRef.current.push({ d, from: fromHeight(p, g) })
    }
    rects.push(
      <rect
        key={d}
        ref={(el) => {
          if (el) elsRef.current.set(d, el)
          else elsRef.current.delete(d)
        }}
        className="ov-bar"
        x={g.x}
        y={g.y}
        width={g.width}
        height={g.height}
        fill={g.fill}
        style={{ transformOrigin: g.origin }}
      />,
    )
  }
  prevGeomRef.current = nextPrev
  /* WAAPI morph：每提交帧 从旧几何插值到当前几何（180ms ease-out）；
     取消在途动画再启动——同一 effect 内先 cancel 再 animate，
     paint 前完成 → 无空帧、无闪烁；WAAPI 优先级高于 CSS 键帧，
     入场期结束后 morph 可无缝接管（fill 态自动失效） */
  useLayoutEffect(() => {
    const anims = animsRef.current
    animsRef.current = []
    if (anims.length === 0) return
    for (const a of anims) {
      const el = elsRef.current.get(a.d)
      if (!el) continue
      el.getAnimations().forEach((an) => an.cancel())
      el.animate([{ transform: a.from }, { transform: 'none' }], {
        duration: LIVE_MORPH_MS,
        easing: 'ease-out',
      })
    }
  })
  return (
    <svg className="fan-transition-layer" aria-hidden>
      {rects}
    </svg>
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
 * - 柱动画：单一通道（v0.9.22）——BarsOverlay 常驻绘制全部窗口柱，几何变化
 *   即动画（新柱键帧生长 / 既有柱高度 morph 180ms / 稳定归零），无事件总线、
 *   无状态切换；曲线/轴/brush 保持 recharts 原生实时；recharts JS 动画全关。
 */
const FanTrendChart = memo(function FanTrendChart({ accountId, refreshTick = 0 }: Props) {
  const [points, setPoints] = useState<FanTrendPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 容量档位（默认 3 个月） */
  const [preset, setPreset] = useState<PresetKey>('3m')
  /** 当前窗口 [startIndex, endIndex]（容量数据索引；null=未就绪） */
  const [range, setRange] = useState<[number, number] | null>(null)
  // Brush onChange rAF 节流：target 暂存 + 帧内提交
  const brushRafRef = useRef(0)
  const brushTargetRef = useRef<[number, number] | null>(null)
  useEffect(
    () => () => {
      window.cancelAnimationFrame(brushRafRef.current)
    },
    [],
  )

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
     ③panning 类 pointer-events:none 旁路 recharts 的 mousemove/tooltip 链路
     （否则 tooltip state 更新叠加拖动重渲染 = 卡）；
     曲线/柱均为 recharts 静态渲染（isAnimationActive=false），拖动期零动画开销 ── */
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

  /* 常驻 BarsOverlay 的窗口日期（几何变化即动画，无事件分析） */
  const viewDates = view.map((d) => d.date)

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
          <>
          {/* initialDimension：卡身定宽 870（内容宽 838）、体高 372（460-17-10-21-24-8-8），
             避免首帧 -1×-1 触发 recharts "should be greater than 0" 警告刷屏；
             ResizeObserver 随后校正为实测值 */}
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 838, height: 372 }}
          >
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
                  /* 注意：recharts 传入的是系列 name 属性（'粉丝数'/'日增粉'），不是 dataKey */
                  if (name === '粉丝数') return [`${formatCount(Number(value))} 粉`, '粉丝数']
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
                className="fan-area-main"
                stroke={PINK}
                strokeWidth={2}
                fill="url(#fanFill)"
                dot={false}
                connectNulls
                isAnimationActive={false}
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
          {/* 常驻柱动画层：几何变化即动画（新柱键帧生长/既有柱高度 morph），
             与 recharts svg 逐像素同框；pointer-events:none 不影响交互。
             注意：recharts 原生柱由 CSS 永久隐藏（.recharts-bar-rectangle），
             本层是柱的唯一可见绘制 → 无任何挂载/切换竞态 */}
          <BarsOverlay dates={viewDates} />
        </>)}
      </div>
    </div>
  )
})

export default FanTrendChart
