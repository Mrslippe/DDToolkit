import { memo, useMemo, type ReactNode } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
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
} satisfies ChartConfig

interface Props {
  points: FanTrendPoint[]
}

/**
 * 粉丝趋势曲线（P5）：shadcn Chart（recharts 2.x）双序列线图。
 * self 直采实线（主粉）、zeroroku 回填虚线（灰蓝，补历史空洞/停运窗口）。
 * props 只收数据数组——内部实现可替换不影响调用方。
 */
const FanTrendChart = memo(function FanTrendChart({ points }: Props) {
  // recharts 多序列：按日期展开为 {date, self?, zeroroku?}
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

  const hasSelf = points.some((p) => p.source === 'self')
  const hasZeroroku = points.some((p) => p.source === 'zeroroku')

  return (
    <ChartContainer
      config={CHART_CONFIG}
      className="aspect-auto h-[240px] w-full"
    >
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
              labelFormatter={(label: ReactNode) => String(label)}
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
            isAnimationActive={false}
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
            isAnimationActive={false}
          />
        )}
        <ChartLegend content={<ChartLegendContent />} />
      </LineChart>
    </ChartContainer>
  )
})

export default FanTrendChart
