import { memo, useEffect, useMemo, useState } from 'react'
import { Area, Bar, Brush, CartesianGrid, Cell, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
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
}

const PINK = '#fb77a1'       // 主粉（--chart-1 / --c-primary-deep）
const RED = '#e14444'        // 警示红（--destructive / --c-live）
const GRID = 'rgba(210, 216, 222, 0.35)'
const MUTED = '#5b6c7e'

/** 默认窗口：最近 30 天（参考图首屏） */
const DEFAULT_DAYS = 30

/**
 * 粉丝趋势卡（v0.9.5 重建，参考用户展示图 + 项目粉系浅底）：
 * - 双轴 ComposedChart：粉丝数 Area（主粉渐变色）+ 日增粉 Bar（正=粉 / 负=红）；
 * - 时间窗：默认最近 30 天；底部 Brush 缩略图 = 全量时间轴，拖拽窗口滑块/拉伸两端
 *   调整展示区间（startIndex/endIndex 受控，可一键回默认）；
 * - 纵轴域随【当前可见窗口数据】动态计算：recharts Brush 缩放时按可见数据重算
 *   Y 轴 domain（轴刻度随窗口收紧/放宽）；
 * - 动画：入场/换窗 400ms 过渡（isAnimationActive + animationDuration），
 *   Brush 拖动即改受控窗口，图表平滑重绘。
 */
const FanTrendChart = memo(function FanTrendChart({ accountId, refreshTick = 0 }: Props) {
  const [points, setPoints] = useState<FanTrendPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 当前窗口 [startIndex, endIndex]（全量索引；null=未就绪） */
  const [range, setRange] = useState<[number, number] | null>(null)

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
      out.push({
        date: d.date,
        fans: d.fans,
        delta: prev != null ? d.fans - prev : null,
      })
      prev = d.fans
    }
    return out
  }, [points])

  /** 数据就绪：默认窗口 = 最近 30 天 */
  useEffect(() => {
    if (daily.length === 0) return
    setRange([Math.max(0, daily.length - DEFAULT_DAYS), daily.length - 1])
  }, [daily])

  const isDefault = useMemo(() => {
    if (!range) return true
    return range[0] === Math.max(0, daily.length - DEFAULT_DAYS) && range[1] === daily.length - 1
  }, [range, daily])

  const resetZoom = () => {
    // 强制 Brush 重挂到默认窗口（受控值变化 + key 重挂双保险）
    setRange([Math.max(0, daily.length - DEFAULT_DAYS), daily.length - 1])
  }

  /** 头部概览：全量末值 1d/7d/30d 涨粉（参考图"涨跌粉: 1d 16 7d 249 30d 3,290"） */
  const overview = useMemo(() => {
    const vals = daily.filter((d) => d.fans != null).map((d) => d.fans as number)
    const last = vals[vals.length - 1]
    if (last == null) return null
    const diff = (n: number) =>
      vals.length > n && vals[vals.length - 1 - n] != null
        ? last - vals[vals.length - 1 - n]
        : null
    return { d1: diff(1), d7: diff(7), d30: diff(30) }
  }, [daily])

  const fmtDate = (d: string) => (d ? d.slice(5) : '') // MM-DD
  const fmtDelta = (v: number | null) =>
    v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString()}`

  return (
    <div className="fan-chart">
      {/* 卡片标题（与直播日历同规格 16px #182e41） */}
      <div className="fc-title">粉丝趋势</div>

      {/* 头部概览（1d/7d/30d 涨粉 + 窗口非默认时"整段"回退） */}
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
        {!isDefault && (
          <button type="button" className="fan-chart-reset" onClick={resetZoom}>
            <CalendarRange className="size-3.5" />
            整段
          </button>
        )}
      </div>

      {/* 图区 */}
      <div className="fan-chart-body">
        {loading && (
          <div className="lc-state">
            <Loader2 className="lc-state-icon" />
          </div>
        )}
        {!loading && error && <div className="lc-state lc-error">{error}</div>}
        {!loading && !error && daily.length === 0 && (
          <div className="lc-state">暂无粉丝趋势数据</div>
        )}
        {!loading && !error && daily.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={daily} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
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
              {/* fans 轴：自动域（Brush 缩放后按可见数据重算） */}
              <YAxis
                yAxisId="fans"
                domain={['auto', 'auto']}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(v: number) => formatCount(v)}
                tick={{ fontSize: 11, fill: MUTED }}
              />
              {/* delta 轴：自动域（负向留 10% 余量，对称视觉） */}
              <YAxis
                yAxisId="delta"
                orientation="right"
                domain={[(dataMin: number) => Math.min(0, dataMin) * 1.1, (dataMax: number) => Math.max(0, dataMax) * 1.1]}
                tickLine={false}
                axisLine={false}
                width={44}
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
                isAnimationActive
                animationDuration={400}
                animationBegin={0}
                radius={[2, 2, 0, 0]}
                maxBarSize={7}
              >
                {daily.map((d) => (
                  <Cell key={d.date} fill={(d.delta ?? 0) >= 0 ? PINK : RED} />
                ))}
              </Bar>
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
                isAnimationActive
                animationDuration={400}
                animationBegin={0}
              />
              {/* 时间轴缩略图：全量迷你图 + 窗口滑块（拖拽平移/两端拉伸缩放） */}
              <Brush
                key={`brush-${daily.length}`}
                dataKey="date"
                height={56}
                stroke={PINK}
                fill="rgba(251,119,161,0.05)"
                travellerWidth={9}
                startIndex={range?.[0]}
                endIndex={range?.[1]}
                onChange={(e: { startIndex?: number; endIndex?: number }) => {
                  const s = e.startIndex ?? 0
                  const en = e.endIndex ?? daily.length - 1
                  setRange([s, Math.max(s, en)])
                }}
                tickFormatter={(date: string) => (date ? date.slice(0, 7) : '')}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
})

export default FanTrendChart
