import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { FanRankedRow } from '../../api/types'

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, CanvasRenderer])

export type ResultTab = 'overview' | 'attendance' | 'interaction' | 'payment'

const PINK = ['#c9406f', '#ffa2b4', '#fc7079', '#7c93b5', '#d9a5b3', '#a66c8a']
const GREEN = '#52c41a'

interface Props {
  items: FanRankedRow[]
  pool: {
    size: number
    tiers: Record<string, number>
    bins: { lo: number; hi: number; counts: number[] }
    pay_split?: { gift: number; guard: number; sc: number }
    acv?: number | null
    excluded?: number
  } | null | undefined
  tab: ResultTab
  /** 出席场次数分布（下标 = 出席场次，值 = 人数） */
  attBins?: { max: number; counts: number[] }
  /** 新图表数据（2026-10-26） */
  charts?: {
    pool_trend?: { end: number; size: number; new: number; left: number; same: number }[]
    lag_hist?: { labels: string[]; counts: number[] }
    msg_hist?: { labels: string[]; counts: number[] }
    spam_split?: Record<string, number>
    pay_split_top?: { labels: string[]; values: number[] }
    msg_split_top?: { labels: string[]; values: number[] }
    msg_pct?: { pcts: number[]; means: number[] }
  }
}

interface Card {
  key: string
  title: string
  note?: string
  option: EChartsCoreOption
  /** 卡片底部的说明文字（如池子口径），2026-10-26 放进卡片内部 */
  footer?: React.ReactNode
  /** 饼图的 HTML 图例（颜色 + 名称 + 数值）；ECharts 自带 legend 在窄卡片里会消失 */
  legend?: { name: string; value: number }[]
  money?: boolean
}

/** 单张图：option 变化时重设，宿主更换时重建（2026-10-25 的教训） */
function EChart({ option, playKey }: { option: EChartsCoreOption; playKey: string }) {
  const box = useRef<HTMLDivElement | null>(null)
  const api = useRef<ReturnType<typeof echarts.init> | null>(null)
  /** 上一次真正渲染时的 (run, option) 快照：同一个 run 只重建一次实例，
   *  否则 StrictMode / 连续 render 会让动画播两遍（2026-10-26 用户报"一次翻页播两次"） */
  /** 上一次触发"重播动画"的键：只有它变化才销毁重建 */
  const lastPlay = useRef<string>('')

  useEffect(() => {
    const host = box.current
    if (!host) return
    try {
      if (!document.createElement('canvas').getContext('2d')) return   // jsdom
      // 已经初始化过、且这次不是"切页签/翻页" ⇒ 只更新数据，不重建实例。
      // （数据到达时 option 会变，若重建就会重播动画 —— 这正是"切页签播两次"的真因）
      if (api.current && lastPlay.current === playKey) {
        api.current.setOption({ ...option, animation: false } as EChartsCoreOption, true)
        return
      }
      if (api.current && api.current.getDom() !== host) {
        api.current.dispose()
        api.current = null
      }
      // run 变化（切页签 / 翻页）= 销毁重建实例。`clear()` 不保证重播（实测无效），
      // 只有新建实例才会走"初始动画"这条路径：柱子从 0 生长、饼图重新旋转填充。
      lastPlay.current = playKey
      api.current?.dispose()
      api.current = null
      // 下一帧再 init：容器此时已完成布局，宽度非 0，ECharts 才会播初始动画
      // （同步 init 在"刚切页签、卡片还没测量"时宽度是 0，动画会被静默跳过 —— 2026-10-26）
      const host2 = host
      requestAnimationFrame(() => {
        if (!host2.isConnected) return
        api.current = echarts.init(host2)
        api.current.setOption(option, true)
      })
    } catch { /* 图表失败不影响其余内容 */ }
  }, [option, playKey])

  // 容器尺寸变化要 resize，但**不能在新建实例的同一帧**做：
  // 新建后立刻 resize 会让 ECharts 重启动画，表现为"切页签动画播两遍"（2026-10-26 真因）。
  // 这里等一帧再挂 observer，且首次回调跳过。
  useEffect(() => {
    const host = box.current
    if (!host || typeof ResizeObserver === 'undefined') return
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return }
      api.current?.resize()
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  useEffect(() => () => { api.current?.dispose(); api.current = null }, [])
  return <div ref={box} className="wb-chart" />
}

/** 统一的动画时长：柱子生长 / 折线描边 / 饼图旋转都用这一档 */
const ANIM = { animation: true, animationDuration: 700, animationEasing: 'cubicOut' as const }


/** 饼图图例：名称 + 数值（数量或金额），颜色点由 ECharts 自带 */
function pieOption(
  data: { name: string; value: number }[], money = false,
): EChartsCoreOption {
  // ⚠️ 不再用 ECharts 自带的 legend：卡片窄时它会被算没（2026-10-26 实测"图例消失"）。
  // 图例改由 React 渲染（见 PieLegend），颜色/名称/数值都可控。
  return {
    ...ANIM,
    tooltip: {
      trigger: 'item',
      formatter: money ? '{b}: ¥{c}（{d}%）' : '{b}: {c}（{d}%）',
    },
    series: [{
      type: 'pie',
      radius: ['46%', '70%'],
      center: ['50%', '50%'],
      // 关掉外侧标签：名字交给图例，值也在图例里 —— 同时避免画布边缘把昵称裁掉一个字
      label: { show: false },
      labelLine: { show: false },
      data: data.map((d, i) => ({ ...d, itemStyle: { color: PINK[i % PINK.length] } })),
    }],
  }
}

const axisBase = (labels: string[], values: number[], name: string): EChartsCoreOption => ({
  ...ANIM,
  grid: { left: 48, right: 16, top: 18, bottom: 36 },
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'category', data: labels,
    // 不强制每个刻度都画：场次多时自动抽稀，否则 70+ 个标签会糊成一片
    axisLabel: { fontSize: 10, color: '#5b6c7e', interval: 'auto', hideOverlap: true },
  },
  yAxis: {
    type: 'value', name,
    nameTextStyle: { fontSize: 10, color: '#5b6c7e' },
    axisLabel: { fontSize: 10, color: '#5b6c7e' },
  },
  series: [{ type: 'bar', data: values, barMaxWidth: 26, itemStyle: { color: PINK[0] } }],
})

/**
 * 结果区图表（2026-10-26 改版）。
 *
 * - 一页最多 **2 张**卡片，左右箭头一次翻一张（用户口径）；
 * - **饼图永远排第一**（用户口径）；
 * - 每张图都是独立 `EChart`，宿主或 option 变化都会重建实例。
 */
export default function ResultCharts({ items, pool, tab, attBins, charts }: Props) {
  const [page, setPage] = useState(0)

  const cards = useMemo<Card[]>(() => {
    const out: Card[] = []

    if (tab === 'overview' && pool) {
      out.push({
        key: 'tiers',
        title: '核心度分层',
        note: `共 ${pool.size} 人`,
        option: pieOption(
          Object.entries(pool.tiers).map(([name, value]) => ({ name, value }))),
        legend: Object.entries(pool.tiers).map(([name, value]) => ({ name, value })),
        footer: (
          <p className="wb-chart-foot" data-testid="pool-rule">
            池子按 3×平均同接{pool.acv ? `（ACV ${Math.round(pool.acv).toLocaleString()}）` : ''}划定
            {pool.excluded ? ` · 另有 ${pool.excluded.toLocaleString()} 人分流走` : ''}
          </p>
        ),
      })

      const span = pool.bins.hi - pool.bins.lo || 1
      out.push({
        key: 'strength',
        title: '核心度分布',
        note: '横轴核心度 · 纵轴人数',
        option: {
          ...ANIM,
          grid: { left: 48, right: 16, top: 18, bottom: 30 },
          tooltip: { trigger: 'axis' },
          xAxis: {
            type: 'category',
            data: pool.bins.counts.map((_, i) =>
              (pool.bins.lo + (span * (i + 0.5)) / pool.bins.counts.length).toFixed(3)),
            axisLabel: { fontSize: 10, color: '#5b6c7e', interval: 3 },
          },
          yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#5b6c7e' } },
          series: [{
            type: 'line', data: pool.bins.counts, smooth: true, symbol: 'none',
            lineStyle: { color: PINK[0] }, areaStyle: { color: 'rgba(255,162,180,0.18)' },
          }],
        },
      })

      const tr = charts?.pool_trend ?? []
      if (tr.length) {
        out.push({
          key: 'trend',
          title: '核心观众池变化',
          note: '每 5 场一格 · 新进 / 出池 / 未变动',
          option: {
            ...ANIM,
            grid: { left: 48, right: 16, top: 26, bottom: 30 },
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { top: 0, textStyle: { fontSize: 11 } },
            xAxis: {
              type: 'category', data: tr.map((x) => `前${x.end}场`),
              axisLabel: { fontSize: 10, color: '#5b6c7e' },
            },
            yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#5b6c7e' } },
            series: [
              { name: '新进', type: 'bar', stack: 'p', data: tr.map((x) => x.new), itemStyle: { color: GREEN } },
              { name: '出池', type: 'bar', stack: 'p', data: tr.map((x) => x.left), itemStyle: { color: '#fc7079' } },
              { name: '未变动', type: 'bar', stack: 'p', data: tr.map((x) => x.same), itemStyle: { color: '#d9d9d9' } },
            ],
          },
        })
      }
    }

    if (tab === 'attendance') {
      if (attBins && attBins.counts.length > 1) {
        const max = attBins.max || attBins.counts.length - 1
        const pairs = Array.from({ length: max }, (_, i) => [i + 1, attBins.counts[i + 1] ?? 0] as const)
          .filter(([, c]) => c > 0)
        out.push({
          key: 'att', title: '出席分布', note: '横轴出席场次 · 纵轴人数',
          option: axisBase(pairs.map(([n]) => String(n)), pairs.map(([, c]) => c), '人数'),
        })
      }
      const lh = charts?.lag_hist
      if (lh) {
        out.push({
          key: 'lag', title: '入场时滞分布', note: '横轴场均时滞（分钟）· 纵轴人数',
          option: {
            ...axisBase(lh.labels, lh.counts, '人数'),
            series: [{
              type: 'line', data: lh.counts, smooth: true, symbol: 'circle', symbolSize: 5,
              lineStyle: { color: PINK[0] }, itemStyle: { color: PINK[0] },
              areaStyle: { color: 'rgba(255,162,180,0.18)' },
            }],
          },
        })
      }
    }

    if (tab === 'interaction') {
      // ① 弹幕量贡献（Top 8 + 其他）：把"互动鲸鱼"单独展示
      const mc = charts?.msg_split_top
      if (mc?.values?.length) {
        out.push({
          key: 'msgshare', title: '弹幕量贡献', note: 'Top 8 + 其他',
          option: pieOption(mc.labels.map((name, i) => ({ name, value: mc.values[i] }))),
          legend: mc.labels.map((name, i) => ({ name, value: mc.values[i] })),
        })
      }
      // ② 场均弹幕 vs 分位（折线，横轴取对数）
      const mp = charts?.msg_pct
      if (mp?.means?.length) {
        // x = -log10(1-p)：等距分位会被压平，取对数才能把"最活跃的 1%"展开。
        // p=1 时给一个有限上限（3.3 ≈ 99.95%）。
        const pts = mp.pcts.map((pv, i) => {
          const x = Math.min(3.3, -Math.log10(Math.max(1e-4, 1 - pv)))
          return [Number(x.toFixed(3)), mp.means[i], pv] as [number, number, number]
        })
        out.push({
          key: 'msgpct', title: '场均弹幕分布', note: '横轴分位（对数）· 纵轴场均弹幕',
          option: {
            ...ANIM,
            grid: { left: 52, right: 20, top: 18, bottom: 34 },
            tooltip: {
              trigger: 'axis',
              formatter: (ps: unknown) => {
                const arr = ps as { value: [number, number, number] }[]
                const v = arr?.[0]?.value
                if (!v) return ''
                return `分位 ${(v[2] * 100).toFixed(1)}%<br/>场均弹幕 ${v[1]} 条`
              },
            },
            xAxis: {
              type: 'value',
              min: 0,
              max: 3.3,
              axisLabel: {
                fontSize: 10, color: '#5b6c7e',
                // 刻度值 x → 分位百分比
                // 高分段显示三位小数（0.990 / 0.999），否则右侧全挤成 "100%"
                formatter: (x: number) => {
                  const p = 1 - Math.pow(10, -x)
                  return p >= 0.99 ? p.toFixed(3) : p.toFixed(2)
                },
              },
            },
            yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#5b6c7e' } },
            series: [{
              type: 'line', smooth: true, symbol: 'none',
              data: pts.map((v) => [v[0], v[1], v[2]]),
              lineStyle: { color: PINK[0] },
              areaStyle: { color: 'rgba(255,162,180,0.18)' },
            }],
          },
        })
      }
    }

    if (tab === 'payment' && charts?.pay_split_top?.values?.length) {
      const pc = charts.pay_split_top
      out.push({
        key: 'payshare', title: '付费贡献', note: 'Top 8 + 其他（鲸鱼单列）',
        option: pieOption(pc.labels.map((name, i) => ({ name, value: pc.values[i] })), true),
        legend: pc.labels.map((name, i) => ({ name, value: pc.values[i] })),
        money: true,
      })
    }

    if (tab === 'payment' && pool?.pay_split) {
      const ps = pool.pay_split
      out.push({
        key: 'pay', title: '付费构成', note: '全池合计',
        option: pieOption([
          { name: '舰长类', value: Math.round(ps.guard) },
          { name: '醒目留言', value: Math.round(ps.sc) },
          { name: '礼物', value: Math.round(ps.gift) },
        ], true),
        legend: [
          { name: '舰长类', value: Math.round(ps.guard) },
          { name: '醒目留言', value: Math.round(ps.sc) },
          { name: '礼物', value: Math.round(ps.gift) },
        ],
        money: true,
      })
    }

    if (!out.length && items.length) {
      const n = items.length
      const a = Math.round(n * 0.2)
      const b = Math.round(n * 0.5)
      out.push({
        key: 'fallback', title: '核心度分层', note: `${n} 人（旧响应）`,
        option: {
          tooltip: { trigger: 'item' },
          legend: { bottom: 0, textStyle: { fontSize: 11 } },
          series: [{
            type: 'pie', radius: ['42%', '66%'], center: ['50%', '44%'],
            data: [
              { name: '核心', value: a, itemStyle: { color: PINK[0] } },
              { name: '次核心', value: Math.max(0, b - a), itemStyle: { color: PINK[1] } },
              { name: '外层', value: Math.max(0, n - b), itemStyle: { color: PINK[2] } },
            ],
          }],
        },
      })
    }
    return out
  }, [items, pool, tab, attBins, charts])

  const PER_PAGE = 2
  const pages = useMemo(() => {
    const out: Card[][] = []
    for (let i = 0; i < cards.length; i += PER_PAGE) out.push(cards.slice(i, i + PER_PAGE))
    return out
  }, [cards])

  /** 左右两条窄带的悬停状态（箭头只在鼠标靠近边缘时出现，2026-10-26） */
  const [hoverEdge, setHoverEdge] = useState<'left' | 'right' | null>(null)
  /** 切页签后短暂显示一次箭头，提示"这里可以翻" */
  const [flash, setFlash] = useState(false)
  const [run, setRun] = useState(0)
  /** 翻页瞬间（约 300ms）：给视口加一层"边缘→中心"的径向淡出，
   *  让从外侧进来的下一页看起来是**渐显**而不是硬切（2026-10-26 用户口径） */
  const [flipping, setFlipping] = useState(false)

  useEffect(() => {
    setPage(0)
    setFlash(true)
    setRun((v) => v + 1)
    const t = window.setTimeout(() => setFlash(false), 1600)
    return () => window.clearTimeout(t)
  }, [tab])

  const maxPage = Math.max(0, pages.length - 1)
  const cur = Math.min(page, maxPage)
  const cls = [
    'wb-charts',
    flipping ? 'is-flipping' : '',
    flash ? 'is-flash' : '',
    hoverEdge === 'left' ? 'is-left' : '',
    hoverEdge === 'right' ? 'is-right' : '',
  ].filter(Boolean).join(' ')

  if (!pages.length) return null

  return (
    <div className={cls} data-testid="result-charts"
         onMouseLeave={() => setHoverEdge(null)}>
      {/* 左右各一条窄带：只有鼠标进入这一小列才显示箭头 */}
      {pages.length > 1 && <div className="wb-charts-edge is-left"
           onMouseEnter={() => setHoverEdge('left')}
           onMouseLeave={() => setHoverEdge(null)}>
        <button
          type="button" className="wb-charts-arrow" aria-label="上一页"
          data-testid="charts-prev" disabled={cur === 0}
          onClick={() => {
            setPage(Math.max(0, cur - 1)); setRun((v) => v + 1)
            setFlipping(true); window.setTimeout(() => setFlipping(false), 340)
          }}
        >
          <ChevronLeft className="size-4" />
        </button>
      </div>}

      <div className="wb-charts-viewport">
        <div
          className="wb-charts-pages"
          style={{ transform: `translateX(-${cur * 100}%)` }}
          data-page={cur}
        >
          {pages.map((group, pi) => (
            <div className="wb-charts-page" key={pi}>
              {group.map((c) => (
                <section
                  className="wb-card wb-chart-card" key={c.key}
                  data-testid={c.key === 'tiers' ? 'chart-pie-card'
                    : c.key === 'strength' ? 'chart-line-card'
                      : `chart-${c.key}`}
                >
                  <h3 className="wb-card-title">
                    {c.title}
                    {c.note && <span className="wb-card-note" style={{ marginLeft: 8 }}>{c.note}</span>}
                  </h3>
                  {c.legend ? (
                    <div className="wb-pie">
                      <EChart option={c.option} playKey={`${tab}:${run}`} />
                      <ul className="wb-pie-legend">
                        {c.legend.map((d, i) => (
                          <li key={d.name}>
                            <i style={{ background: PINK[i % PINK.length] }} />
                            <span className="wb-pie-name" title={d.name}>{d.name}</span>
                            <span className="wb-pie-val">
                              {c.money ? `¥${Math.round(d.value).toLocaleString()}`
                                : Math.round(d.value).toLocaleString()}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <EChart option={c.option} playKey={`${tab}:${run}`} />
                  )}
                  {c.footer}
                </section>
              ))}
            </div>
          ))}
        </div>
      </div>

      {pages.length > 1 && <div className="wb-charts-edge is-right"
           onMouseEnter={() => setHoverEdge('right')}
           onMouseLeave={() => setHoverEdge(null)}>
        <button
          type="button" className="wb-charts-arrow" aria-label="下一页"
          data-testid="charts-next" disabled={cur >= maxPage}
          onClick={() => {
            setPage(Math.min(maxPage, cur + 1)); setRun((v) => v + 1)
            setFlipping(true); window.setTimeout(() => setFlipping(false), 340)
          }}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>}

      <span className="wb-charts-pos">{cur + 1} / {pages.length}</span>
    </div>
  )
}
