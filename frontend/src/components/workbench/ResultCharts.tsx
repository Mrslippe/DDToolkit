import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([PieChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer])

/** 沿用 `tokens.css` 的粉色阶：分层用同一色相的深浅，不引入新色 */
const PINK = ['#c9406f', '#ef8ba5', '#f7b2c3']
const TIERS = ['核心', '次核心', '外层'] as const
const BINS = 20

/** 能不能真画图。jsdom 没有 canvas（`getContext` 返回 null），此时不 init —— 否则
    ECharts 会在异步渲染里抛 `clearRect`，把整个测试文件污染成"有未处理错误"。 */
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
}

interface Props {
  /** 名单（后端已按参与强度降序）—— 仅在**没有** pool 时兜底使用 */
  items: Item[]
  /** 全池聚合：有它就以它为准，两张图覆盖全池而不是名单 */
  pool?: PoolStats
}

/**
 * 结果区的两张小卡片（2026-10-19 用户 2.2）：核心度分层饼图 + 核心度分布曲线。
 *
 * ⚠️ **口径**：优先用后端给的全池聚合（`pool`，即过 10% 门槛后的**所有人**）；
 * 没有 `pool` 时才退回名单（`limit` 条），此时标题里的 N 会明显小于池子。
 *
 * ⚠️ 分层是**前端按强度分位现算**（0.80 / 0.50，与 `cross_v.assign_tiers` 同一组阈值），
 * 与后端的「类型」不是一回事（类型 = 主导轴 + 纯度门槛）。
 *
 * ⚠️ `echarts.init` 在 jsdom 里可能没有 canvas。用例只验"卡片在"，所以 init 失败时
 * 静默降级成空占位 —— 不让图表把整页带崩。
 */
export default function ResultCharts({ items, pool }: Props) {
  const pieRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const pieApi = useRef<ReturnType<typeof echarts.init> | null>(null)
  const lineApi = useRef<ReturnType<typeof echarts.init> | null>(null)

  const model = useMemo(() => {
    // 有全池聚合就用它 —— 否则两张图只反映 limit 条名单，会被误读成"全池'。
    if (pool) {
      const lo = pool.bins.lo
      const hi = pool.bins.hi
      const span = hi - lo || 1
      return {
        pie: TIERS.map((name) => ({ name, value: pool.tiers[name] ?? 0 })),
        x: Array.from({ length: BINS }, (_, i) => (lo + (span * (i + 0.5)) / BINS).toFixed(3)),
        y: pool.bins.counts,
        total: pool.size,
      }
    }
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
      pie: TIERS.map((name, i) => ({ name, value: counts[i] })),
      x: Array.from({ length: BINS }, (_, i) => (lo + (span * (i + 0.5)) / BINS).toFixed(3)),
      y: bins,
      total: n,
    }
  }, [items, pool])

  useEffect(() => {
    if (!pieRef.current || !canRender()) return
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
          data: model.pie.map((d, i) => ({ ...d, itemStyle: { color: PINK[i] } })),
        }],
      }
      pieApi.current.setOption(opt, true)
    } catch {
      /* jsdom / 无 canvas：静默降级 */
    }
  }, [model])

  useEffect(() => {
    if (!lineRef.current || !canRender()) return
    try {
      lineApi.current ??= echarts.init(lineRef.current)
      const opt: EChartsCoreOption = {
        grid: { left: 34, right: 12, top: 16, bottom: 28 },
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
    } catch {
      /* 同上 */
    }
  }, [model])

  useEffect(() => {
    const onResize = () => {
      pieApi.current?.resize()
      lineApi.current?.resize()
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      pieApi.current?.dispose()
      lineApi.current?.dispose()
      pieApi.current = null
      lineApi.current = null
    }
  }, [])

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
