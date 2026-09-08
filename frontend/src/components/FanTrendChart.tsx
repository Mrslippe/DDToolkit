import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarRange } from 'lucide-react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import {
  AxisPointerComponent,
  DataZoomComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { FanTrendPoint } from '../api/types'
import { api } from '../api/api'
import { formatCount } from '../utils/format'
import {
  CHART_BORDER,
  CHART_GRID,
  CHART_LOSS_GRAY,
  CHART_MUTED,
  CHART_PINK,
  CHART_SHADOW,
  CHART_TEXT,
  pinkA,
} from '../utils/chartTheme'
import StateBlock from './common/StateBlock'

/* ECharts 按需注册（v6.1）：canvas 渲染 + 线/柱 + 网格/提示/缩放/轴指针 */
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  DataZoomComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  CanvasRenderer,
])

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
  /** 涨=粉 / 掉=灰（柱 itemStyle 直接取自数据点） */
  barFill: string
}

/** 涨=粉 / 掉=灰（柱 itemStyle 直接取自数据点）；色值集中见 utils/chartTheme.ts（tokens 同源） */
const PINK = CHART_PINK
const LOSS_GRAY = CHART_LOSS_GRAY

/** 数据容量档位（时间轴轨迹范围）：默认 3 个月，手动按钮切换 */
const PRESETS = [
  { key: '3m', label: '3个月', days: 90 },
  { key: '6m', label: '6个月', days: 180 },
  { key: '1y', label: '1年', days: 365 },
  { key: 'all', label: '全部', days: Infinity },
] as const
type PresetKey = (typeof PRESETS)[number]['key']

/** 窗口默认：当前容量档位内的最近 30 天 */
const DEFAULT_DAYS = 30

/** Y 轴域节流（拖动 dataZoom 期间 250ms 才跟随一次；空闲 260ms 后精确） */
const DOMAIN_THROTTLE_MS = 250

/** 粉丝轴域：[min,max] 留 3% 余量并整 50；再扩到 interval 的整数倍——
    显式 interval 后轴刻度均匀、端点必在刻度上（修复 200/300 混排） */
function fanDomain(values: (number | null)[]): {
  min: number
  max: number
  interval: number
} {
  const nums = values.filter((v): v is number => v != null)
  if (nums.length === 0) return { min: 0, max: 1, interval: 1 }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const pad = Math.max((max - min) * 0.03, 5)
  const min0 = Math.floor((min - pad) / 50) * 50
  const max0 = Math.ceil((max + pad) / 50) * 50
  const span = max0 - min0
  const interval = Math.max(50, Math.ceil(span / 5 / 50) * 50)
  return {
    min: Math.floor(min0 / interval) * interval,
    max: Math.ceil(max0 / interval) * interval,
    interval,
  }
}

/** delta 轴域：对称 ±cap（零线居中）；interval ≈ maxAbs/2（约 4 段），
    cap = interval×2 → 域与刻度整倍、刻度对称均匀（0,±i,±2i） */
function deltaDomain(values: (number | null)[]): {
  min: number
  max: number
  interval: number
} {
  const nums = values.filter((v): v is number => v != null)
  if (nums.length === 0) return { min: -1, max: 1, interval: 1 }
  const maxAbs = Math.max(...nums.map((v) => Math.abs(v)))
  const interval = Math.max(20, Math.ceil((maxAbs * 1.1) / 2.2))
  const cap = interval * 2
  return { min: -cap, max: cap, interval }
}

/** 「+1,234 / −56」（tooltip 与概览共用） */
function fmtDelta(v: number | null): string {
  return v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString()}`
}

/** 工具提示：日期标题 + 粉丝数/日增粉两行（粉系样式随 tooltip 全局配置） */
function tooltipFormatter(params: unknown): string {
  const list =
    (params as { seriesName?: string; value?: number | null; axisValue?: string | number }[]) ??
    []
  const p0 = list[0]
  let html = `<div style="display:flex;flex-direction:column;gap:2px">`
  if (p0 && p0.axisValue != null) {
    html += `<div style="font-size:12px;color:${CHART_MUTED}">${String(p0.axisValue)}</div>`
  }
  for (const p of list) {
    if (p.value == null) continue
    if (p.seriesName === '粉丝数') {
      html += `<div style="color:${CHART_TEXT}">粉丝数 <b style="color:${PINK}">${formatCount(Number(p.value))} 粉</b></div>`
    } else {
      html += `<div style="color:${CHART_TEXT}">日增粉 <b style="color:${Number(p.value) >= 0 ? PINK : LOSS_GRAY}">${fmtDelta(Number(p.value))}</b></div>`
    }
  }
  return html + `</div>`
}

/** 全量 option：双轴（粉丝 Area + 日增 Bar）· dataZoom slider+inside · 粉系美学 */
function buildOption(data: DailyPoint[]): EChartsCoreOption {
  const len = data.length
  const s0 = Math.max(0, len - DEFAULT_DAYS)
  const e0 = len - 1
  const def = data.slice(s0, e0 + 1)
  const fDom = fanDomain(def.map((d) => d.fans))
  const dDom = deltaDomain(def.map((d) => d.delta))
  return {
    // 渲染：首次入场 320ms；更新 150ms 柔化（canvas 帧级插值，不占主线程——
    // 拖拽中窗口平移/域节流切换有平滑过渡，不再是生硬跳变；跟手不受影响）
    animation: true,
    animationDuration: 320,
    animationDurationUpdate: 150,
    animationEasingUpdate: 'cubicOut',
    animationThreshold: 2000,
    // 布局：上 12 / 下 60（下区自下而上：间隙 6 + slider 24 + 间隙 12 + xAxis 标签 18）
    grid: { left: 48, right: 46, top: 12, bottom: 60 },
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: data.map((d) => d.date),
      axisLine: { lineStyle: { color: CHART_BORDER } },
      axisTick: { show: false },
      axisLabel: {
        color: CHART_MUTED,
        fontSize: 11,
        hideOverlap: true,
        formatter: (v: string) => v.slice(5),
      },
    },
    yAxis: [
      {
        type: 'value',
        min: fDom.min,
        max: fDom.max,
        interval: fDom.interval,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: CHART_MUTED,
          fontSize: 11,
          formatter: (v: number) => v.toLocaleString(),
        },
        splitLine: { lineStyle: { color: CHART_GRID } },
      },
      {
        type: 'value',
        min: dDom.min,
        max: dDom.max,
        interval: dDom.interval,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: CHART_MUTED, fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: CHART_BORDER,
      borderWidth: 1,
      borderRadius: 12,
      padding: [8, 12],
      textStyle: { fontSize: 12.5, color: CHART_TEXT },
      extraCssText: `box-shadow: ${CHART_SHADOW};`,
      axisPointer: {
        type: 'line',
        lineStyle: { color: 'rgba(148, 163, 184, 0.45)', type: 'dashed', width: 1 },
      },
      formatter: tooltipFormatter,
    },
    series: [
      {
        // 粉丝数：主粉光滑曲线 + 渐变面积（浅底通透）
        yAxisIndex: 0,
        name: '粉丝数',
        type: 'line',
        data: data.map((d) => d.fans),
        smooth: true,
        showSymbol: false,
        connectNulls: true,
        lineStyle: { color: PINK, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: pinkA(0.28) },
              { offset: 1, color: pinkA(0.02) },
            ],
          },
        },
      },
      {
        // 日增粉：正=粉 / 负=灰，柱宽 55% 随密度自适应
        yAxisIndex: 1,
        name: '日增粉',
        type: 'bar',
        data: data.map((d) => ({ value: d.delta, itemStyle: { color: d.barFill } })),
        barWidth: '55%',
        itemStyle: { borderRadius: [2, 2, 0, 0] },
      },
    ],
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: 0,
        startValue: s0,
        endValue: e0,
        height: 24,
        bottom: 6,
        borderColor: CHART_BORDER,
        backgroundColor: 'rgba(148, 163, 184, 0.1)',
        fillerColor: pinkA(0.16),
        dataBackground: {
          lineStyle: { color: pinkA(0.6), width: 1.5 },
          areaStyle: { color: pinkA(0.12) },
        },
        selectedDataBackground: {
          lineStyle: { color: PINK, width: 1.5 },
          areaStyle: { color: pinkA(0.2) },
        },
        handleStyle: {
          color: '#fff',
          borderColor: pinkA(0.35),
          borderWidth: 1,
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.12)',
          shadowOffsetY: 1,
        },
        moveHandleStyle: {
          color: pinkA(0.4),
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.12)',
        },
        textStyle: { color: CHART_MUTED, fontSize: 11 },
        brushSelect: false,
      },
      {
        // 图表区：滚轮缩放 + 按下拖动平移窗口（ECharts 原生增量渲染，跟手）
        type: 'inside',
        xAxisIndex: 0,
        startValue: s0,
        endValue: e0,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
      },
    ],
  }
}

/**
 * 粉丝趋势卡（v0.10 ECharts 架构：canvas 立即模式 + 增量渲染）：
 * - 双轴：粉丝数（line+渐变面积，主粉）+ 日增粉（bar，涨=粉/掉=灰）；
 * - dataZoom slider：底部全量迷你时间轴（窗口滑块/两端拉伸/中央移动把手）
 *   + inside：图表区滚轮缩放、按住拖动平移窗口——原生增量渲染，拖动零 React 渲染；
 * - 数据容量档位（3m/6m/1y/all）切换重建 option，默认窗口 = 尾部 30 天；
 * - Y 轴域随当前窗口数据（dataZoom 事件 250ms 节流跟随，空闲 260ms 精确）；
 * - 柱宽 55% 随横轴密度自适应（点少宽/点多细）；入场动画 320ms，更新零动画。
 */
const FanTrendChart = memo(function FanTrendChart({ accountId, refreshTick = 0 }: Props) {
  const [points, setPoints] = useState<FanTrendPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 容量档位（默认 3 个月） */
  const [preset, setPreset] = useState<PresetKey>('3m')
  /** 窗口镜像 [startIndex, endIndex]（ECharts dataZoom 为唯真源；React 侧用于
      域计算/默认窗口判断/重置按钮显隐；datazoom 事件更新） */
  const [range, setRange] = useState<[number, number] | null>(null)

  const chartRef = useRef<HTMLDivElement>(null)
  const chartApiRef = useRef<ReturnType<typeof echarts.init> | null>(null)
  /** 渲染期镜像（datazoom 事件经 ref 读最新数据，避免闭包过期） */
  const capacityRef = useRef<DailyPoint[]>([])
  const onDataZoomRef = useRef<
    (params: { startValue?: number; endValue?: number; start?: number; end?: number }) => void
  >(() => {})
  const domainLastRef = useRef(0)
  const domainTidyRef = useRef(0)

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
        barFill: (delta ?? 0) >= 0 ? PINK : LOSS_GRAY,
      })
      prev = d.fans
    }
    return out
  }, [points])

  /** 当前容量档位数据（数据源，数据量 = 档位天数） */
  const capacity = useMemo<DailyPoint[]>(() => {
    const days = PRESETS.find((p) => p.key === preset)?.days ?? 90
    return Number.isFinite(days) ? daily.slice(-days) : daily
  }, [daily, preset])

  capacityRef.current = capacity

  /** Y 轴域切到窗口 [s,e]（ECharts 增量 setOption，canvas 局部重绘） */
  const applyDomain = (chart: ReturnType<typeof echarts.init>, data: DailyPoint[], s: number, e: number) => {
    const slice = data.slice(s, e + 1)
    const f = fanDomain(slice.map((d) => d.fans))
    const dLoc = deltaDomain(slice.map((d) => d.delta))
    chart.setOption({
      yAxis: [
        { min: f.min, max: f.max, interval: f.interval },
        { min: dLoc.min, max: dLoc.max, interval: dLoc.interval },
      ],
    })
  }

  /** datazoom 事件：镜像窗口 + Y 轴域 250ms 节流、空闲 260ms 精确。
      统一数据源：不从事件参数推算（slider 与 inside 事件字段不同源会差 1~2 索引），
      改读 chart.getOption() 的 dataZoom 当前状态（百分比），单一换算路径：
      两种拖拽方式到达同一窗口 → 域严格一致（user 反馈跳变修复） */
  onDataZoomRef.current = (params) => {
    const data = capacityRef.current
    const len = data.length
    const chart = chartApiRef.current
    if (len === 0 || !chart) return
    const dz = (
      chart.getOption().dataZoom as
        | { start?: number; end?: number }[]
        | undefined
    )?.[0]
    const pctS = dz?.start ?? params.start ?? 0
    const pctE = dz?.end ?? params.end ?? 100
    const s = Math.min(Math.max(Math.round((pctS / 100) * (len - 1)), 0), len - 1)
    const e = Math.min(Math.max(Math.round((pctE / 100) * (len - 1)), s), len - 1)
    setRange([s, e])
    const nowMs = performance.now()
    if (nowMs - domainLastRef.current >= DOMAIN_THROTTLE_MS) {
      domainLastRef.current = nowMs
      applyDomain(chart, data, s, e)
    }
    window.clearTimeout(domainTidyRef.current)
    domainTidyRef.current = window.setTimeout(() => {
      const d = capacityRef.current
      if (chartApiRef.current) applyDomain(chartApiRef.current, d, s, e)
    }, DOMAIN_THROTTLE_MS + 20)
  }

  /** 实例化（capacity/档位变化整体重建）：ECharts 自绘 canvas，React 不再进渲染链路 */
  useEffect(() => {
    const el = chartRef.current
    if (!el || capacity.length === 0) return
    const chart = echarts.init(el)
    chartApiRef.current = chart
    chart.setOption(buildOption(capacity))
    const handler = (params: unknown) => {
      const p = (params ?? {}) as { startValue?: number; endValue?: number }
      onDataZoomRef.current(p)
    }
    chart.on('datazoom', handler)
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    /* 默认窗口镜像（视觉已由 option dataZoom 设定） */
    setRange([Math.max(0, capacity.length - DEFAULT_DAYS), capacity.length - 1])
    return () => {
      ro.disconnect()
      chart.off('datazoom', handler)
      chart.dispose()
      chartApiRef.current = null
      window.clearTimeout(domainTidyRef.current)
    }
  }, [capacity])

  const isDefaultWindow = useMemo(() => {
    if (!range) return true
    return (
      range[0] === Math.max(0, capacity.length - DEFAULT_DAYS) &&
      range[1] === capacity.length - 1
    )
  }, [range, capacity])

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

  return (
    <div className="fan-chart">
      {/* 卡片标题（与直播日历/归档卡同规格 16.5/600/--c-text-main） */}
      <div className="fc-title">粉丝趋势</div>

      {/* 头部：左=1d/7d/30d 概览 · 右=容量档位按钮 + 窗口回退 */}
      <div className="fan-chart-head">
        <div className="fan-chart-summary">
          {overview ? (
            <>
              <span className="fan-stat">
                1d <b>{fmtDelta(overview.d1)}</b>
              </span>
              <span className="fan-stat">
                7d <b>{fmtDelta(overview.d7)}</b>
              </span>
              <span className="fan-stat">
                30d <b>{fmtDelta(overview.d30)}</b>
              </span>
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
            <button
              type="button"
              className="fan-chart-reset"
              onClick={() => {
                const len = capacity.length
                const s = Math.max(0, len - DEFAULT_DAYS)
                const e = len - 1
                chartApiRef.current?.dispatchAction({
                  type: 'dataZoom',
                  startValue: s,
                  endValue: e,
                })
                setRange([s, e])
              }}
            >
              <CalendarRange className="size-3.5" />
              重置窗口
            </button>
          )}
        </div>
      </div>

      {/* 图区：ECharts canvas 自绘（slider 拖拽/图表区滚轮缩放+按住平移均由数据缩放组件接管） */}
      <div className="fan-chart-body">
        {loading && <StateBlock kind="loading" />}
        {!loading && error && <StateBlock kind="error" text={error} />}
        {!loading && !error && capacity.length === 0 && (
          <StateBlock kind="empty" text="暂无趋势数据" />
        )}
        {!loading && !error && capacity.length > 0 && (
          <div className="fan-chart-canvas" ref={chartRef} />
        )}
      </div>
    </div>
  )
})

export default FanTrendChart
