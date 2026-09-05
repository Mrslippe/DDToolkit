import { memo, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ChartContainer,
  ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import type { FanTrendPoint } from '../api/types'
import { formatCount } from '../utils/format'

const CHART_CONFIG = {
  self: { label: '本工具直采', color: 'var(--chart-1)' },
  zeroroku: { label: 'zeroroku 回填', color: 'var(--chart-2)' },
  delta: { label: '日增粉', color: 'var(--chart-1)' },
} satisfies ChartConfig

interface Props {
  points: FanTrendPoint[]
}

/** Brush 重置键：切换模式 / 重置缩放时 bump，强制 Brush 重新挂载回到全量 */
let brushKey = 0

/**
 * 粉丝趋势图（P5→P7 增强，v0.7.0）：
 * - 折线模式：self 实线 + zeroroku 虚线（原功能）；
 * - 柱状模式：每日粉丝增减量（按天聚合 diff，负值向下）；
 * - 时间轴 Brush：底部缩略图 + 可拖拽选区缩放（两模式共用，缩放区互不残留）。
 */
const FanTrendChart = memo(function FanTrendChart({ points }: Props) {
  const [mode, setMode] = useState<'line' | 'bar'>('line')
  const [resetTick, setResetTick] = useState(0)

  const series = useMemo(() => {
    const map = new Map<string, { date: string; self?: number; zeroroku?: number }>()
    for (const p of points) {
      let e = map.get(p.date)
      if (!e) {
        e = { date: p.date }
        map.set(p.date, e)
      }
      if (p.source === 'self' || p.source === 'zeroroku') {
        e[p.source] = p.fans
      }
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [points])

  /** 每日增减：按日期聚合（self 优先天值，无 self 时 zeroroku 补），逐日 diff */
  const deltaData = useMemo(() => {
    const daily: { date: string; value: number }[] = []
    for (const p of points) {
      const last = daily[daily.length - 1]
      if (last && last.date === p.date) {
        if (p.source === 'self') last.value = p.fans
      } else {
        daily.push({ date: p.date, value: p.fans })
      }
    }
    const out: { date: string; delta: number | null }[] = []
    let prev: number | null = null
    for (const d of daily) {
      out.push({ date: d.date, delta: prev != null ? d.value - prev : null })
      prev = d.value
    }
    return out
  }, [points])

  const hasSelf = points.some((p) => p.source === 'self')
  const hasZeroroku = points.some((p) => p.source === 'zeroroku')

  const switchMode = (m: 'line' | 'bar') => {
    if (m === mode) return
    // 切换模式重挂 Brush（数据不同；选区不跨模式残留）
    brushKey += 1
    setResetTick((t) => t + 1)
    setMode(m)
  }

  const resetZoom = () => {
    brushKey += 1
    setResetTick((t) => t + 1)
  }

  const brush = (
    <Brush
      key={`brush-${resetTick}`}
      dataKey="date"
      height={56}
      stroke="var(--chart-1)"
      fill="rgba(251,119,161,0.05)"
      travellerWidth={10}
      tickFormatter={(date: string) => (date ? date.slice(0, 7) : '')}
    />
  )

  return (
    <div className="fan-chart-wrap">
      <div className="fan-chart-toolbar">
        <div className="fan-chart-mode">
          <button
            type="button"
            className={`fan-chart-mode-btn${mode === 'line' ? ' on' : ''}`}
            onClick={() => switchMode('line')}
          >
            趋势
          </button>
          <button
            type="button"
            className={`fan-chart-mode-btn${mode === 'bar' ? ' on' : ''}`}
            onClick={() => switchMode('bar')}
          >
            每日增减
          </button>
        </div>
        <button
          type="button"
          className="fan-chart-reset"
          onClick={resetZoom}
        >
          重置缩放
        </button>
      </div>

      <ChartContainer
        config={CHART_CONFIG}
        className="aspect-auto h-[260px] w-full"
      >
        {mode === 'bar' ? (
          <BarChart data={deltaData} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={48}
              tickFormatter={(date: string) => (date ? date.slice(0, 7) : '')}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => formatCount(v)}
            />
            <ChartTooltip
              cursor={{ fill: 'rgba(148,163,184,0.08)' }}
              content={
                <ChartTooltipContent
                  labelFormatter={(label: React.ReactNode) => String(label)}
                  formatter={(value, name) => [
                    (Number(value) >= 0 ? '+' : '') + Number(value).toLocaleString() + ' 粉',
                    String(name),
                  ]}
                />
              }
            />
            <Bar
              dataKey="delta"
              name="日增粉"
              isAnimationActive
              animationDuration={400}
              radius={[2, 2, 0, 0]}
            >
              {/* 正增=主粉 / 负增=警示色（recharts Cell 逐柱着色） */}
              {deltaData.map((d) => (
                <Cell
                  key={d.date}
                  fill={(d.delta ?? 0) >= 0 ? 'var(--color-delta)' : 'var(--c-live)'}
                />
              ))}
            </Bar>
            <ChartLegend content={<ChartLegendContent />} />
            {brush}
          </BarChart>
        ) : (
          <LineChart data={series} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={48}
              tickFormatter={(date: string) => (date ? date.slice(0, 7) : '')}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => formatCount(v)}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(label: React.ReactNode) => String(label)}
                  formatter={(value, name) => [formatCount(Number(value)) + ' 粉', String(name)]}
                />
              }
            />
            {hasZeroroku && (
              <Line
                dataKey="zeroroku"
                type="monotone"
                stroke="var(--color-zeroroku)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                connectNulls
                isAnimationActive
                animationDuration={400}
              />
            )}
            {hasSelf && (
              <Line
                dataKey="self"
                type="monotone"
                stroke="var(--color-self)"
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive
                animationDuration={400}
              />
            )}
            <ChartLegend content={<ChartLegendContent />} />
            {brush}
          </LineChart>
        )}
      </ChartContainer>
    </div>
  )
})

export default FanTrendChart
