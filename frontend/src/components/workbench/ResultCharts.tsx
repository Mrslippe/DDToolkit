import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { FanRankedRow } from '../../api/types'
import { useHideNicknames } from '../../utils/hideNicknames'

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, CanvasRenderer])

export type ResultTab = 'overview' | 'attendance' | 'interaction' | 'payment' | 'compare'
/** 需要走 /ranked 的四个分析页签（`compare` 不走） */
export type RankedTab = Exclude<ResultTab, 'compare'>

const PINK = ['#c9406f', '#ffa2b4', '#fc7079', '#7c93b5', '#d9a5b3', '#a66c8a']
const GREEN = '#52c41a'

/**
 * 各页签的**卡片目录**（2026-10-28，空态专用）。
 *
 * 为什么要有这张表：还没分析时 `charts` 是空的 ⇒ 卡片的标题也拼不出来。
 * 而用户口径是「没分析时也采用有结果时的那套卡片样式，内容换成空态文本」——
 * 所以标题必须**与有结果时逐字一致**，否则同一页签在"无数据/有数据"两种状态下
 * 会长成两副样子（切一下页签就像换了个页面）。
 *
 * ⚠️ 改这里的标题/副标题时，**必须同步上面 `cards` 里真实卡片那一份**；
 *    `ResultCharts.empty.test.tsx` 有一条用例专门比对两处是否齐全。
 */
export const EMPTY_CARDS: Record<RankedTab, { key: string; title: string; note: string }[]> = {
  overview: [
    { key: 'tiers', title: '核心度分层', note: '按三轴分位划入四类' },
    { key: 'strength', title: '核心度分布', note: '横轴核心度 · 纵轴人数' },
    { key: 'trend', title: '核心观众池变化', note: '每 5 场一格 · 新进 / 出池 / 未变动' },
  ],
  attendance: [
    { key: 'att', title: '出席分布', note: '横轴出席场次 · 纵轴人数' },
    { key: 'lag', title: '入场时滞分布', note: '横轴场均时滞（分钟）· 纵轴人数' },
  ],
  interaction: [
    { key: 'msgshare', title: '弹幕量贡献', note: 'Top 8 + 其他' },
    { key: 'msgpct', title: '场均弹幕分布', note: '横轴分位（对数）· 纵轴场均弹幕' },
  ],
  payment: [
    { key: 'payshare', title: '付费贡献', note: 'Top 8 + 其他（鲸鱼单列）' },
    { key: 'pay', title: '付费构成', note: '全池合计' },
  ],
}

/** 空态卡片的正文（用户 2026-10-28 口径：卡片内容用空态文本填充） */
export const EMPTY_TEXT = { title: '暂无数据', hint: '请先进行采集' }

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
  /** 数据指纹（场次-池人数-口径）：变化时卡片重建，用**最终数据**播一次入场动画。
   *  没有它的话，切页签会先拿旧数据渲染、动画刚起步就被新数据 setOption 打断 ——
   *  看起来就是"切页签没有动画"（2026-10-27 定位）。 */
  dataStamp?: string
  /** 新图表数据（2026-10-26） */
  charts?: {
    pool_trend?: { end: number; size: number; new: number; left: number; same: number }[]
    lag_hist?: { labels: string[]; counts: number[] }
    msg_hist?: { labels: string[]; counts: number[] }
    spam_split?: Record<string, number>
    pay_split_top?: { labels: string[]; values: number[]; uids?: (string | null)[] }
    msg_split_top?: { labels: string[]; values: number[]; uids?: (string | null)[] }
    msg_pct?: { pcts: number[]; means: number[] }
  }
  /**
   * 空态（2026-10-28）：还没分析时也画**同样的卡片框**，内容换成空态文本。
   * 只影响渲染分支，不碰任何取数逻辑。
   */
  empty?: boolean
  /** 空态正文的提示语（由页面按当前状态给"下一步该点哪个按钮"） */
  emptyHint?: string
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


/** 统一的动画时长：柱子生长 / 折线描边 / 饼图扫入都用这一档 */
const ANIM = { animation: true, animationDuration: 700, animationEasing: 'cubicOut' as const }

/** 饼图选项（图例由 React 渲染，见 `.wb-pie-legend`） */
function pieOption(
  data: { name: string; value: number }[], money = false,
): EChartsCoreOption {
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
      label: { show: false },
      labelLine: { show: false },
      data: data.map((d, i) => ({ ...d, itemStyle: { color: PINK[i % PINK.length] } })),
    }],
  }
}

/**
 * 把 series 的 data 换成**空数组**（不是 0 值）。
 *
 * 这是让"原生动画"稳定出现的唯一可靠做法：
 * - 饼图：空 → 有值 会走 `expansion`（扇区从中心扫入）；
 * - 折线/柱状：空 → 有值 会走"描边 / 生长"。
 *
 * 早先试过"值全 0"，但 0 值扇区在饼图里不占角度，等于没变化，所以饼图不动。
 */
function emptyData(opt: EChartsCoreOption): EChartsCoreOption {
  const clone = { ...opt } as Record<string, unknown>
  const series = (opt as { series?: unknown[] }).series
  if (Array.isArray(series)) {
    clone.series = series.map((s) => ({ ...(s as Record<string, unknown>), data: [] }))
  }
  return clone as EChartsCoreOption
}

/**
 * 单张图（2026-10-27 方案 A 第二版）。
 *
 * ⚠️ 不再用 IntersectionObserver 做门控：轮播的 `translateX` 过渡期间，
 * 观察者会在"还在移动、宽度不稳"的时刻回调，导致部分卡片 init 时宽度为 0，
 * 初始动画被跳过（现象：切页签后只有第一张图有动画）。
 *
 * 现在改为：**只渲染当前页**（见 `ResultCharts`），于是卡片挂载时必然可见、已布局。
 * 初始化流程：等 `offsetWidth > 0` → init → 先喂空数据 → 下一帧喂真数据（原生入场动画）。
 */
function EChart({ option }: { option: EChartsCoreOption }) {
  const box = useRef<HTMLDivElement | null>(null)
  const api = useRef<ReturnType<typeof echarts.init> | null>(null)
  const lastOpt = useRef<EChartsCoreOption | null>(null)

  useEffect(() => {
    const host = box.current
    if (!host) return
    if (!document.createElement('canvas').getContext('2d')) return   // jsdom：没有 canvas

    let raf = 0
    let initRo: ResizeObserver | null = null
    let sizeRo: ResizeObserver | null = null
    let done = false

    const init = (): boolean => {
      if (done || !host.isConnected || !host.offsetWidth) return false
      done = true
      api.current = echarts.init(host)
      // 先空 → 再真：ECharts 才会走原生入场动画（饼图 expansion / 折线描边 / 柱状生长）
      api.current.setOption(emptyData(option), true)
      lastOpt.current = option
      requestAnimationFrame(() => { api.current?.setOption(option, false) })
      initRo?.disconnect()
      // 之后容器尺寸再变（切页签、窗口缩放、侧栏收起）要跟着 resize，否则图会被拉伸/裁掉
      if (typeof ResizeObserver !== 'undefined') {
        sizeRo = new ResizeObserver(() => api.current?.resize())
        sizeRo.observe(host)
      }
      return true
    }

    /*
     * ⚠️ **宽度为 0 时绝不 init**（2026-10-28 修）。
     *
     * 原实现是"重试 20 帧，还没宽度就照样 init" —— 那会在隐藏状态（窗口最小化、
     * 结果区还在 0 宽容器里、路由切换动画中）留下一个 **0×0 的画布**，之后再也不会
     * resize ⇒ 用户看到的就是"卡片框和标题都在、里面**永远空白**"。
     *
     * 现在改成：等它**第一次有宽度**再 init（ResizeObserver + 帧重试双保险）。
     */
    if (!init()) {
      if (typeof ResizeObserver !== 'undefined') {
        initRo = new ResizeObserver(() => { init() })
        initRo.observe(host)
      }
      let tries = 0
      const retry = () => {
        if (init() || tries >= 600 || !host.isConnected) return   // 600 帧 ≈ 10s 兜底
        tries += 1
        raf = requestAnimationFrame(retry)
      }
      raf = requestAnimationFrame(retry)
    }
    return () => {
      cancelAnimationFrame(raf)
      initRo?.disconnect()
      sizeRo?.disconnect()
    }
    // 只在挂载时初始化：后续数据更新走 key 重建（dataStamp），不需要重新 init
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => { api.current?.dispose(); api.current = null }, [])
  return <div ref={box} className="wb-chart" />
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
export default function ResultCharts({ items, pool, tab, attBins, charts, dataStamp, empty, emptyHint }: Props) {
  const [page, setPage] = useState(0)

  /** 「隐藏昵称」（2026-10-28）：贡献榜那两张图的图例/饼图扇区文字换成 uid */
  const hide = useHideNicknames()

  const cards = useMemo<Card[]>(() => {
    const out: Card[] = []

    /**
     * 贡献榜的显示名（2026-10-28）。
     *
     * `labels` 是后端按昵称拼的（`其他 N 人` 那条没有对应的人）；`uids` 与它**等长同序**，
     * 尾部那条是 `null`。开了「隐藏昵称」就用 uid 顶掉昵称，尾部那条照旧显示
     * 「其他 N 人」（它不是某个人）。`uids` 缺失（老响应/旧快照）时**退回昵称** ——
     * 宁可显示昵称，也不要把它渲染成 `undefined`。
     */
    const displayLabel = (index: number, labels: string[], uids?: (string | null)[]) => {
      const name = labels[index] ?? ''
      if (!hide) return name
      return uids?.[index] || name
    }

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
            series: [
              {
                // 线：只负责描边（不画点，避免点和线抢同一套动画时序）
                type: 'line', data: lh.counts, smooth: true, showSymbol: false,
                lineStyle: { color: PINK[0] },
                areaStyle: { color: 'rgba(255,162,180,0.18)' },
                animationDuration: 700,
              },
              {
                // 点：单独一个 scatter 系列，逐点延迟弹出（折线自带的 symbol
                // 只跟线一起出现，`animationDelay` 在 line 上不生效 —— 2026-10-27 实测）
                type: 'scatter', data: lh.counts, symbolSize: 7,
                itemStyle: { color: PINK[0] },
                animationDuration: 500,
                animationEasing: 'cubicOut',
                animationDelay: (idx: number) => 700 + idx * 80,
              },
            ],
          },
        })
      }
    }

    if (tab === 'interaction') {
      // ① 弹幕量贡献（Top 8 + 其他）：把"互动鲸鱼"单独展示
      const mc = charts?.msg_split_top
      if (mc?.values?.length) {
        const data = mc.values.map((value, i) => ({
          name: displayLabel(i, mc.labels, mc.uids), value,
        }))
        out.push({
          key: 'msgshare', title: '弹幕量贡献', note: 'Top 8 + 其他',
          option: pieOption(data),
          legend: data,
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
      const data = pc.values.map((value, i) => ({
        name: displayLabel(i, pc.labels, pc.uids), value,
      }))
      out.push({
        key: 'payshare', title: '付费贡献', note: 'Top 8 + 其他（鲸鱼单列）',
        option: pieOption(data, true),
        legend: data,
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
  }, [items, pool, tab, attBins, charts, hide])

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
  /** 翻页瞬间（约 300ms）：给视口加一层"边缘→中心"的径向淡出，
   *  让从外侧进来的下一页看起来是**渐显**而不是硬切（2026-10-26 用户口径） */
  const [flipping, setFlipping] = useState(false)

  useEffect(() => {
    setPage(0)
    setFlash(true)
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

  /**
   * 空态：**同样的两卡一页框**（`.wb-charts` / `.wb-charts-page` / `.wb-card.wb-chart-card`），
   * 只把内容换成空态文本。两处刻意的差别：
   * ① 该页签的卡**一次全列出来** —— 空态没有"第几页"的概念，用户该一眼看到将来会出现哪些卡；
   * ② **不渲染左右箭头**（没有第二页可翻）。
   * ⚠️ 必须放在所有 hook 之后、`if (!pages.length) return null` 之前 ——
   *    否则 `empty` 一变，hook 数量就变，React 会报错。
   */
  if (empty) {
    const dir = EMPTY_CARDS[tab as RankedTab] ?? []
    /* 用户口径（2026-10-28 第 1 条修订）：空态**只保留一张卡**，标题跟随当前页签的
       第一张（总览→核心度分层 / 互动→弹幕量贡献…）。卡框与有结果时同一套样式，
       副标题点明"分析后这里会出现几张图"，用户仍能预期页面最终长什么样。 */
    const card = dir[0]
    return (
      <div className="wb-charts" data-testid="result-charts-empty">
        <div className="wb-charts-viewport">
          <div className="wb-charts-pages" data-page={0}>
            {/* ⚠️ **不加 `is-single`**（2026-10-28 用户口径：空态那张卡保持**半宽**，
                与图二一致）。两列网格里只放一个卡片，天然占左半边。 */}
            <div className="wb-charts-page">
              <section className="wb-card wb-chart-card" data-testid="chart-empty">
                <h3 className="wb-card-title">
                  {card?.title ?? '分析结果'}
                  <span className="wb-card-note" style={{ marginLeft: 8 }}>
                    {dir.length > 1 ? `分析完成后这里会出现 ${dir.length} 张图` : card?.note}
                  </span>
                </h3>
                <div className="wb-empty wb-empty-card">
                  <p className="wb-empty-title">{EMPTY_TEXT.title}</p>
                  <p>{emptyHint ?? EMPTY_TEXT.hint}</p>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    )
  }

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
            setPage(Math.max(0, cur - 1))
            setFlipping(true); window.setTimeout(() => setFlipping(false), 340)
          }}
        >
          <ChevronLeft className="size-4" />
        </button>
      </div>}

      <div className="wb-charts-viewport">
        <div className="wb-charts-pages" data-page={cur}>
          <div className="wb-charts-page" key={`${tab}-${cur}-${dataStamp ?? ''}`}>
            {pages[cur]?.map((c) => (
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
                    <EChart option={c.option} />
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
                  <EChart option={c.option} />
                )}
                {c.footer}
              </section>
            ))}
          </div>
        </div>
      </div>

      {pages.length > 1 && <div className="wb-charts-edge is-right"
           onMouseEnter={() => setHoverEdge('right')}
           onMouseLeave={() => setHoverEdge(null)}>
        <button
          type="button" className="wb-charts-arrow" aria-label="下一页"
          data-testid="charts-next" disabled={cur >= maxPage}
          onClick={() => {
            setPage(Math.min(maxPage, cur + 1))
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
