import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([PieChart, LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer])

/** 沿用 `tokens.css` 的粉色阶：分层用同一色相的深浅，不引入新色 */
const PINK = ['#c9406f', '#ef8ba5', '#f7b2c3']
/** 三条轴各自的色：出席=深粉、互动=藏青、付费=珊瑚（都在 tokens 里） */
const AXIS_COLOR: Record<string, string> = {
  attendance: '#c9406f',
  interaction: '#7c93b5',
  payment: '#fc7079',
}
const TIERS = ['核心', '次核心', '外层'] as const
const BINS = 20

export type ResultTab = 'overview' | 'attendance' | 'interaction' | 'payment'

/** 能不能真画图。jsdom 没有 canvas（`getContext` 返回 null），此时不 init。 */
function canRender(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext('2d'))
  } catch {
    return false
  }
}

interface Item {
  strength: number
}

/** 后端 `/ranked` 返回的全池聚合（过 10% 门槛后的所有人） */
export interface PoolStats {
  size: number
  tiers: Record<string, number>
  bins: { lo: number; hi: number; counts: number[] }
  axes?: Record<string, { lo: number; hi: number; counts: number[] }>
  pay_split?: { gift: number; guard: number; sc: number }
  type_counts?: Record<string, number>
}

interface Props {
  /** 名单（后端已按当前排序口径降序）—— 仅在**没有** pool 时兜底使用 */
  items: Item[]
  /** 全池聚合：有它就以它为准，图覆盖全池而不是名单 */
  pool?: PoolStats
  /** 当前页签 */
  tab?: ResultTab
}

const AXIS_TITLE: Record<Exclude<ResultTab, 'overview'>, string> = {
  attendance: '出席分布',
  interaction: '互动分布',
  payment: '付费分布',
}

/**
 * 结果区的图表（2026-10-23 分页签改造）。
 *
 * - `overview`：核心度分层（环形）+ 核心度分布（曲线），用 `pool.tiers` / `pool.bins`；
 * - `attendance` / `interaction` / `payment`：该轴的分位分布（20 桶），用 `pool.axes[x]`。
 *
 * ⚠️ **口径**：图永远覆盖**全池**（过 10% 门槛的所有人），与下方名单（当前页 20 条）无关。
 */
export default function ResultCharts({ items, pool, tab = 'overview' }: Props) {
  const pieRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const axisRef = useRef<HTMLDivElement>(null)
  const pieApi = useRef<ReturnType<typeof echarts.init> | null>(null)
  const lineApi = useRef<ReturnType<typeof echarts.init> | null>(null)
  const axisApi = useRef<ReturnType<typeof echarts.init> | null>(null)

  const model = useMemo(() => {
    if (tab !== 'overview') {
      const a = pool?.axes?.[tab]
      if (a) {
        const span = a.hi - a.lo || 1
        return {
          kind: 'axis' as const,
          x: Array.from({ length: BINS }, (_, i) => (a.lo + (span * (i + 0.5)) / BINS).toFixed(3)),
          y: a.counts,
          total: a.counts.reduce((s, v) => s + v, 0),
        }
      }
      return { kind: 'axis' as const, x: [] as string[], y: [] as number[], total: 0 }
    }

    if (pool) {
      const span = pool.bins.hi - pool.bins.lo || 1
      return {
        kind: 'overview' as const,
        pie: TIERS.map((name) => ({ name, value: pool.tiers[name] ?? 0 })),
        x: Array.from({ length: BINS }, (_, i) =>
          (pool.bins.lo + (span * (i + 0.5)) / BINS).toFixed(3)),
        y: pool.bins.counts,
        total: pool.size,
      }
    }

    // 兜底：没有 pool 时退回名单（旧响应）
    const n = items.length
    const coreEnd = Math.round(n * 0.2)
    const midEnd = Math.round(n * 0.5)
    const counts = [coreEnd, Math.max(0, midEnd - coreEnd), Math.max(0, n - midEnd)]
    const lo = n ? Math.min(...items.map((x) => x.strength)) : 0
    const hi = n ? Math.max(...items.map((x) => x.strength)) : 1
    const span = hi - lo || 1
    const bins = new Array<number>(BINS).fill(0)
    for (const it of items) {
      const i = Math.min(BINS - 1, Math.max(0, Math.floor(((it.strength - lo) / span) * BINS)))
      bins[i] += 1
    }
    return {
      kind: 'overview' as const,
      pie: TIERS.map((name, i) => ({ name, value: counts[i] })),
      x: Array.from({ length: BINS }, (_, i) => (lo + (span * (i + 0.5)) / BINS).toFixed(3)),
      y: bins,
      total: n,
    }
  }, [items, pool, tab])

  // 环形图（仅总览）
  useEffect(() => {
    if (tab !== 'overview' || !pieRef.current || !canRender()) return
    try {
      pieApi.current ??= echarts.init(pieRef.current)
      const opt: EChartsCoreOption = {
        tooltip: { trigger: 'item', formatter: '{b}：{c} 人（{d}%）' },
        series: [{
          type: 'pie',
          radius: ['46%', '72%'],
          center: ['50%', '52%'],
          itemStyle: { borderColor: '#fff', borderWidth: 2 },
          label: { formatter: '{b}\n{c} 人', fontSize: 11, lineHeight: 15 },
          data: (model.kind === 'overview' ? model.pie : [])
            .map((d, i) => ({ ...d, itemStyle: { color: PINK[i] } })),
        }],
      }
      pieApi.current.setOption(opt, true)
    } catch { /* jsdom / 无 canvas：静默降级 */ }
  }, [model, tab])

  // 曲线（总览）
  useEffect(() => {
    if (tab !== 'overview' || !lineRef.current || !canRender()) return
    try {
      lineApi.current ??= echarts.init(lineRef.current)
      const opt: EChartsCoreOption = {
        grid: { left: 44, right: 12, top: 16, bottom: 28 },
        tooltip: { trigger: 'axis' },
        xAxis: {
          type: 'category',
          data: model.x,
          axisLabel: { fontSize: 10, color: '#5b6c7e', interval: 3 },
          axisLine: { lineStyle: { color: 'rgba(210,216,222,0.9)' } },
        },
        yAxis: {
          type: 'value',
          axisLabel: { fontSize: 10, color: '#5b6c7e' },
          splitLine: { lineStyle: { color: 'rgba(210,216,222,0.45)' } },
        },
        series: [{
          type: 'line',
          data: model.y,
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { width: 2, color: PINK[0] },
          itemStyle: { color: PINK[0] },
          areaStyle: { color: 'rgba(255,162,180,0.16)' },
        }],
      }
      lineApi.current.setOption(opt, true)
    } catch { /* 同上 */ }
  }, [model, tab])

  // 单轴分布（柱状）
  useEffect(() => {
    if (tab === 'overview' || !axisRef.current || !canRender()) return
    try {
      axisApi.current ??= echarts.init(axisRef.current)
      const color = AXIS_COLOR[tab] ?? PINK[0]
      const opt: EChartsCoreOption = {
        grid: { left: 44, right: 12, top: 16, bottom: 28 },
        tooltip: { trigger: 'axis' },
        xAxis: {
          type: 'category',
          data: model.x,
          axisLabel: { fontSize: 10, color: '#5b6c7e', interval: 3 },
          axisLine: { lineStyle: { color: 'rgba(210,216,222,0.9)' } },
        },
        yAxis: {
          type: 'value',
          axisLabel: { fontSize: 10, color: '#5b6c7e' },
          splitLine: { lineStyle: { color: 'rgba(210,216,222,0.45)' } },
        },
        series: [{
          type: 'bar',
          data: model.y,
          barWidth: '62%',
          itemStyle: { color, borderRadius: [3, 3, 0, 0] },
        }],
      }
      axisApi.current.setOption(opt, true)
    } catch { /* 同上 */ }
  }, [model, tab])

  useEffect(() => {
    const onResize = () => {
      pieApi.current?.resize()
      lineApi.current?.resize()
      axisApi.current?.resize()
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      for (const api of [pieApi, lineApi, axisApi]) {
        api.current?.dispose()
        api.current = null
      }
    }
  }, [])

  if (tab !== 'overview') {
    const split = pool?.pay_split
    const total = split ? split.gift + split.guard + split.sc : 0
    return (
      <div className="wb-charts">
        <section className="wb-card wb-chart-card" data-testid="chart-axis-card">
          <h3 className="wb-card-title">
            {AXIS_TITLE[tab]}
            <span className="wb-card-note" style={{ marginLeft: 8 }}>
              全池 {model.total.toLocaleString()} 人 · 横轴分位 · 纵轴人数
            </span>
          </h3>
          <div className="wb-chart" ref={axisRef} data-testid="chart-axis" />
        </section>
        {tab === 'payment' && split && (
          <section className="wb-card wb-chart-card" data-testid="chart-paysplit-card">
            <h3 className="wb-card-title">
              付费构成
              <span className="wb-card-note" style={{ marginLeft: 8 }}>全部场次合计</span>
            </h3>
            <dl className="wb-split">
              {([['礼物', split.gift], ['舰长', split.guard], ['醒目留言', split.sc]] as const)
                .map(([name, v]) => (
                  <div className="wb-split-row" key={name}>
                    <dt>{name}</dt>
                    <dd>¥{v.toLocaleString(undefined, { maximumFractionDigits: 0 })}</dd>
                    <dd className="wb-split-pct">{total ? `${((v / total) * 100).toFixed(1)}%` : '—'}</dd>
                  </div>
                ))}
            </dl>
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="wb-charts">
      <section className="wb-card wb-chart-card" data-testid="chart-pie-card">
        <h3 className="wb-card-title">
          核心度分层
          <span className="wb-card-note" style={{ marginLeft: 8 }}>共 {model.total} 人</span>
        </h3>
        <div className="wb-chart" ref={pieRef} data-testid="chart-pie" />
      </section>
      <section className="wb-card wb-chart-card" data-testid="chart-line-card">
        <h3 className="wb-card-title">
          核心度分布
          <span className="wb-card-note" style={{ marginLeft: 8 }}>横轴核心度 · 纵轴人数</span>
        </h3>
        <div className="wb-chart" ref={lineRef} data-testid="chart-line" />
      </section>
    </div>
  )
}
