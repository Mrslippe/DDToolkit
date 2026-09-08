import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2, X } from 'lucide-react'
import type { LiveSession, LiveSessionDetail } from '../api/types'
import { api } from '../api/api'
import OverlayScroll from './OverlayScroll'
import SmartImage from './SmartImage'
import { LIVE_TYPE_ORDER, inferLiveType, liveTypeLabel } from '../utils/liveType'
import { MosaicPacker } from '../utils/wordCloudLayout'
import type { CloudCell, CloudWord } from '../utils/wordCloudLayout'

interface Props {
  /** 账号 id（null=无账号，显示空态）；切换账号自动重拉。
   *  user 2026-09-07：默认只检索「主账号」直播信息（调用方传 heroAcc=
   *  bilibili 优先账号，见 PostsPage）；其他账号作为可选项，入口待以后做。 */
  accountId: number | null
  /** 刷新信号（fetch-idle 边沿后重拉场次） */
  refreshTick?: number
}

/** 英文表头（设计稿 Frame10612 规格） */
const WEEKDAYS_EN = ['Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.', 'Sun.']
/** 月份浮窗：12 月中文名 */
const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

/** 浮层关闭宽限（ms）：鼠标从格子滑向浮层中途不闪关 */
const POP_CLOSE_GRACE_MS = 120

function dayKeyIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 「2026年09月」（月份胶囊内文字） */
function fmtMonth(y: number, m: number): string {
  return `${y}年${String(m + 1).padStart(2, '0')}月`
}

/** 「20:31」（真实分钟——M4 起数据为秒级起止，不再取整点） */
function fmtTime(d: Date): string {
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 「3小时12分」 */
function fmtDur(min: number | null | undefined): string {
  if (min == null || min < 1) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}小时${m}分` : `${m}分`
}

/** 「¥10,501.5」 */
function fmtMoney(v: number | null | undefined): string {
  if (v == null) return ''
  return `¥${v.toLocaleString('zh-CN')}`
}

/** 类型 key（服务端）→ 展示；缺失时按标题关键词兜底 */
function keyOf(s: LiveSession): string {
  return s.category ?? inferLiveType(s.live_title).key
}

type CellState = 'live' | 'tbd'

interface DayCell {
  date: Date
  key: string
  /** 属于当前月（false=上/下月补位）——透明度只由它决定（user 2026-09-06） */
  inMonth: boolean
  sessions: LiveSession[]
  isToday: boolean
  state: CellState
}

interface PopState {
  key: string
  rect: DOMRect
  sessions: LiveSession[]
}

/** 场次详情弹窗（点击日期格打开；data=详情端点（含预留 danmaku/analysis）） */
interface DetailState {
  key: string              // 日期 key（防异步回写错位）
  sessions: LiveSession[]  // 当日场次（多场切换用）
  idx: number              // 当前查看第 idx 场
  data: LiveSessionDetail | null
  loading: boolean
}

/** 词云配色（浅色填充——user 2026-09-07：填充浅色、文字同色系深色；按词哈希取色稳定） */
const CLOUD_COLORS = ['#ffc9c4', '#a5e6ff', '#dccff7', '#bee9ec', '#ffd5b8',
  '#fff2a0', '#fda5ff', '#b2f3c0', '#ffdfe8', '#d8e8ff']

function hashOf(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 997
  return h
}

/** 填充色（浅） */
function cloudWordColor(w: { text: string }): string {
  return CLOUD_COLORS[hashOf(w.text) % CLOUD_COLORS.length]
}

/** 同色系深色（文字用）：HSL 压暗同色相 */
function cloudWordText(w: { text: string }): string {
  const hex = cloudWordColor(w)
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const [h, s] = rgbToHsl(r, g, b)
  return hslToHex(h, Math.min(s, 0.9), 0.28)
}

/** rgb(0-255) → [h(0-360), s(0-1)] */
function rgbToHsl(r: number, g: number, b: number): [number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return [0, 0]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0))
  else if (max === gg) h = ((bb - rr) / d + 2)
  else h = ((rr - gg) / d + 4)
  return [h * 60, s]
}

/** h(0-360), s(0-1), l(0-1) → hex */
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let rr = 0, gg = 0, bb = 0
  if (h < 60) { rr = c; gg = x }
  else if (h < 120) { rr = x; gg = c }
  else if (h < 180) { gg = c; bb = x }
  else if (h < 240) { gg = x; bb = c }
  else if (h < 300) { rr = x; bb = c }
  else { rr = c; bb = x }
  const to2 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to2(rr)}${to2(gg)}${to2(bb)}`
}

/**
 * 增量摊铺拼贴词云（2026-09-07 user 定案参考图形态）：
 * ① 面积 ∝ 词频：power diagram λ 驱动（力导向站点滑动 + λ 面积收敛，见 wordCloudLayout.ts）；
 * ② 逐个入池：词按频次降序每 150ms 入场（放当前最大空腔），泡泡在缝隙中滑动、逐渐平衡；
 * ③ 终端稳定：全部入场后 alpha 冷却 → 静止即停（无循环装饰）；reduced-motion 直接终态；
 * ④ 破泡：点击词 → 删词 → 幸存词面积按词频重归一化 → 力+λ 重新平衡闭合；
 *    段头「已破泡 N · 恢复」胶囊由父级渲染（onPoppedChange/restoreTick 联动）。
 * 容器宽度运行时测量（ResizeObserver），高度 210px。
 */
function MosaicCloud({
  data,
  boxH,
  restoreTick = 0,
  onPoppedChange,
}: {
  data: CloudWord[]
  boxH: number
  restoreTick?: number
  onPoppedChange?: (n: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 560, h: boxH })
  const [snap, setSnap] = useState<{ cells: CloudCell[] } | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string; count: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const packerRef = useRef<MosaicPacker | null>(null)
  /** 当前活跃 rAF id（入场/破泡共用一个槽；重建时取消旧的） */
  const rafRef = useRef(0)
  const dataRef = useRef(data)
  dataRef.current = data
  const poppedRef = useRef(0)

  // 宽度自适应：容器实际宽度（user 2026-09-07：池子宽度不对 → 实测）
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((es) => {
      const w = Math.round(es[0]?.contentRect.width ?? 0)
      if (w > 80) setSize((s) => (s.w === w ? s : { ...s, w }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 重建并启动入场动画（data/尺寸/恢复信号变化时） */
  const start = (words: CloudWord[], w: number, h: number) => {
    cancelAnimationFrame(rafRef.current)
    if (words.length === 0) {
      packerRef.current = null
      setSnap(null)
      poppedRef.current = 0
      onPoppedChange?.(0)
      return
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const packer = new MosaicPacker([w, h])
    packerRef.current = packer
    let raf = 0
    let alive = true
    let next = 0
    const held = words.slice()
    let entered = 0
    let alpha = 1
    if (reduceMotion) {
      // 直接最终稳态（插入全部词后长收尾，不播动画）
      for (const wd of held) packer.addWord(wd)
      while (alpha > 0.01) {
        alpha = Math.max(alpha * 0.994, 0.01)
        packer.step(alpha, alpha < 0.3 ? 80 : 2)
      }
      setSnap(packer.state())
      poppedRef.current = 0
      onPoppedChange?.(0)
      return
    }
    const loop = (tNow: number) => {
      if (!alive) return
      while (entered < held.length && next <= tNow) {
        packer.addWord(held[entered])
        entered++
        next += 150
      }
      if (entered < held.length) {
        alpha = 1
      } else {
        alpha = Math.max(alpha * 0.994, 0.01)
      }
      let rounds = entered < held.length ? 1 : 2
      if (entered >= held.length && alpha < 0.3) rounds = 20
      packer.step(alpha, rounds)
      setSnap(packer.state())
      if (entered >= held.length && alpha <= 0.05) return   // 静止即停
      raf = requestAnimationFrame(loop)
      rafRef.current = raf
    }
    raf = requestAnimationFrame(loop)
    rafRef.current = raf
    poppedRef.current = 0
    onPoppedChange?.(0)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      if (packerRef.current === packer) packerRef.current = null
    }
  }

  // 数据/尺寸变化 → 重排
  useEffect(() => {
    const words = dataRef.current
    if (words.length === 0) {
      setSnap(null)
      packerRef.current = null
      return
    }
    return start(words, size.w, size.h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, size.w, size.h])

  // 恢复信号（父级「已破泡 N · 恢复」按钮）→ 重建初始布局
  useEffect(() => {
    if (!restoreTick) return
    const words = dataRef.current
    if (words.length > 0) {
      packerRef.current = null
      const cleanup = start(words, size.w, size.h)
      if (typeof cleanup === 'function') return cleanup
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreTick])

  /**
   * 破泡 = 局部闭合（node 验证：缺口填充 2 词、远处位移 avg 6.5px/max 16px、
   * 偏差 15%、单调 100%）：
   * 1. 删词（站点/λ 移除）——对应 cell **立即消失**，缺口出现（无卡顿：纯同步删）；
   * 2. rAF 局部松弛：α=0.15 起步（力场几乎不动）+ kCenter=0（停中心引力）——
   *    λ 修正把缺口面积重新分配给相邻 cell（power 边界自动"鼓胀"塞住缺口），
   *    站点只极轻微挪动（视觉上邻泡"挤入"缺口）——远处纹丝不动；
   * 3. α 渐冷至 0.05 停止（静止即停）。
   * 节奏（user 2026-09-07 反馈"慢一点"）：λ 8 轮/帧（原 20，每帧鼓胀 40% 速度）、
   *    α 0.997 冷却（原 0.994）——填充过程 ~3.5s 渐显，可看清邻泡缓缓鼓起封缺口。
   */
  const popWord = (text: string) => {
    const p = packerRef.current
    if (!p || p.size === 0) return
    if (!p.removeWord(text)) return
    poppedRef.current += 1
    onPoppedChange?.(poppedRef.current)
    if (p.size === 0) {
      setSnap({ cells: [] })
      return
    }
    // 立即反映（词消失、缺口出现）
    setSnap(p.state())
    // 局部松弛循环
    cancelAnimationFrame(rafRef.current)
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (reduceMotion) {
      let alpha = 0.15
      while (alpha > 0.05) {
        alpha = Math.max(alpha * 0.997, 0.05)
        p.step(alpha, alpha < 0.3 ? 8 : 2, 0)
      }
      setSnap(p.state())
      return
    }
    let alpha = 0.15
    let alive = true
    const loop = () => {
      if (!alive) return
      alpha = Math.max(alpha * 0.997, 0.05)
      // 站点几乎不动：α 0.15 起步（力微扰）；kCenter=0（停中心引力拖拽）
      p.step(alpha, alpha < 0.3 ? 8 : 2, 0)
      setSnap(p.state())
      if (alpha <= 0.05) return   // 静止即停
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  return (
    <div ref={ref} className="lc-dlg-cloud">
      {snap && snap.cells.length > 0 && (
        <svg width={size.w} height={size.h} className="lc-dlg-cloud-svg">
          {snap.cells.map((c) => {
            const { word, poly, cx, cy, r } = c
            const d = poly.length
              ? `M${poly.map(([x, y]) => `${x - cx},${y - cy}`).join('L')}Z`
              : ''
            const fs = Math.max(8.5, Math.min(26, r * 0.8, (r * 2.2) / Math.max(2, word.text.length)))
            const showText = r > 9 && word.text.length <= 6 && fs >= 8.5
            const hovered = hover === word.text
            const dimmed = hover !== null && !hovered
            return (
              <g
                key={word.text}
                className="lc-dlg-cloud-cell"
                style={{ transform: `translate(${cx}px, ${cy}px)` }}
                onMouseEnter={(e) => {
                  setHover(word.text)
                  setTip({ x: e.clientX, y: e.clientY, text: word.text, count: word.count })
                }}
                onMouseMove={(e) =>
                  setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
                onMouseLeave={() => {
                  setHover(null)
                  setTip(null)
                }}
                onClick={() => popWord(word.text)}
              >
                <path
                  d={d}
                  fill={cloudWordColor(word)}
                  fillOpacity={hovered ? 1 : dimmed ? 0.4 : 0.92}
                  stroke="var(--c-bg-card)"
                  strokeWidth={2}
                />
                {showText && (
                  <text
                    x={0}
                    y={0}
                    textAnchor="middle"
                    dy="0.35em"
                    fontSize={fs}
                    fill={cloudWordText(word)}
                    fontWeight={hovered ? 700 : 600}
                    opacity={dimmed ? 0.25 : 1}
                    pointerEvents="none"
                  >
                    {word.text}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      {snap && snap.cells.length === 0 && (
        <div className="lc-dlg-ph">已全部破泡（点击「恢复」还原）</div>
      )}
      {tip && (
        <span className="lc-dlg-cloud-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text} · {tip.count.toLocaleString('zh-CN')} 次
        </span>
      )}
    </div>
  )
}


/**
 * 直播日历（v0.9.2 重建 → v0.9.x M4 内容管道）：
 * - 卡片 870 定宽上限居中（用户参数）；网格 7 列 × 115.714286px + 4px 列/行距
 *   （v0.9.x 审美对齐：2px→4px 密度），6 行 42 格；
 * - 格子 73.1667px 高（v0.9.x 用户：内容拥挤，行高 +4px，卡高 566→590）/ 6px 圆角；
 * - 今天 = 1px 粉描边 rgba(251,119,161,.8)（v0.9.x 审美对齐：设计稿灰描边 → 项目强调粉）；
 * - 透明度 = 月份指示（user）：非本月补位格整体 opacity 0.3，本月格一律实底——与是否有直播无关；
 * - 导航栏（项目浮片族 token：斜切白卡浮片三连——左双箭头+月份+右双箭头，中间点击弹月份选择浮窗）；
 * - 导航栏右侧 = 当月类型统计胶囊（frame 10_642：彩色胶囊 + 计数，服务端 category 口径，仅非零项）；
 * - M4 内容（数据管道 M1-M3 后端闭环后）：
 *   · 格内按最开始布局单场呈现：时间行（HH:MM 真实分钟）+ 右侧「N 场」当日场次计数 + 单行标题
 *     （颜色跟随格类型色系：游戏蓝/杂谈黄/观影紫/投稿绿…，user 2026-09-07）；
 *   · hover 格子 → 浮层（当日全量：起止/时长/标题/类型/分区/收益/峰值在线/弹幕/数据源），
 *     鼠标滑向浮层有 120ms 宽限不闪关；Esc 关闭；保持纯信息展示（user 2026-09-07：
 *     分类校正移出浮层 → 点击日期格进详情弹窗）；
 *   · 点击日期格 → 独立详情弹窗（user 2026-09-07）：
 *     直播信息（起止/分区/收益/峰值/弹幕/数据源/中断段数）+ 分类校正（点左上角胶囊 →
 *     下拉栏全部彩色分类胶囊，点选取；override 源）+
 *     「弹幕信息」（danmakus /api/v2/live 词云与总量，2026-09-07 已接入）+
 *     「直播内容分析」预留区块（analysis 接口先留，内容之后再做）；
 *   · 月份切换滑动动画（user 2026-09-07：前进/后退方向感，keyed 重放）；
 *   · 无场次的格子：今天以前 = 「休息」；今天及以后 = 「待定」（user 2026-09-07）；
 *   · 礼物数据暂不展示（user 2026-09-07：之后从 danmakus 取场次级详细数据；
 *     浮层「收益」即 danmakus 场次级），格内礼物行/当日礼物合计已退役；
 *   · 类型徽章/统计用后端 category（v2 多信号：校正>系列>标题评分>词库>分区>纪念日），
 *     服务端缺失时前端关键词兜底。
 */
const LiveCalendar = memo(function LiveCalendar({ accountId, refreshTick = 0 }: Props) {
  const now = new Date()
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 场次浮层：点击格子的锚点（rect 快照）与当日数据 */
  const [pop, setPop] = useState<PopState | null>(null)

  /** 详情弹窗·分类下拉栏（点左上角胶囊展开：全部彩色分类胶囊，点选取） */
  const [catPopOpen, setCatPopOpen] = useState(false)
  const catPopRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!catPopOpen) return
    const onDown = (e: MouseEvent) => {
      if (catPopRef.current && !catPopRef.current.contains(e.target as Node)) {
        setCatPopOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCatPopOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [catPopOpen])

  /** 月份切换动画方向（1=前进/向右滑入，-1=后退/向左滑入）；keyed 重放 */
  const [navDir, setNavDir] = useState<1 | -1>(1)

  const [detail, setDetail] = useState<DetailState | null>(null)
  // 弹窗打开/切换场次/关闭 → 收起下拉栏
  useEffect(() => {
    setCatPopOpen(false)
  }, [detail])

  // 月份选择浮窗：独立年份游标（打开时同步 ym 的年）
  const [monthPopOpen, setMonthPopOpen] = useState(false)
  const [popYear, setPopYear] = useState(now.getFullYear())
  const navRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!monthPopOpen) return
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setMonthPopOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMonthPopOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [monthPopOpen])

  // 场次拉取（字段 2026-09-07：只检索主账号直播信息；loadSeq 防账号切换回写）
  const loadSeq = useRef(0)
  const load = useCallback(() => {
    if (accountId == null) return
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    api
      .liveSessions(accountId)
      .then((s) => {
        if (seq === loadSeq.current) setSessions(s)
      })
      .catch((e: Error) => {
        if (seq === loadSeq.current) setError(e.message || '场次加载失败')
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false)
      })
  }, [accountId])

  useEffect(() => {
    load()
  }, [load, refreshTick])

  // 数据刷新后浮层锚点已失效 → 关闭（月份/账号切换同理）
  useEffect(() => {
    setPop(null)
  }, [ym, accountId, sessions])

  // 账号切换 → 关闭详情弹窗（数据归属变化）
  useEffect(() => {
    setDetail(null)
  }, [accountId])

  // 弹窗打开期间锁页面滚动（2026-09-07：滚动条贴窗口右缘/越顶问题）
  useEffect(() => {
    if (!detail) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [detail])

  const byDay = useMemo(() => {
    const m = new Map<string, LiveSession[]>()
    for (const sess of sessions) {
      const d = new Date(sess.start_at)
      if (Number.isNaN(d.getTime())) continue
      const k = dayKeyIso(d)
      const list = m.get(k)
      if (list) list.push(sess)
      else m.set(k, [sess])
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.start_at.localeCompare(b.start_at))
    }
    return m
  }, [sessions])

  const todayKey = dayKeyIso(now)

  /** 礼物/跨天展示已退役（user 2026-09-07：礼物数据暂不展示，之后取 danmakus 场次级详细数据）。
   *  42 格固定 6 行（设计稿）：首行从当月 1 号所在周一周起，含上/下月补位 */
  const cells = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1)
    const startWeekday = (first.getDay() + 6) % 7 // 周一=0
    const start = new Date(ym.y, ym.m, 1 - startWeekday)
    const out: DayCell[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const key = dayKeyIso(d)
      const list = byDay.get(key) ?? []
      const inMonth = d.getMonth() === ym.m
      const isToday = key === todayKey
      // 状态：有场次=live；无场次=tbd（休息/待定在渲染层按今天前后区分）
      const state: CellState = list.length > 0 ? 'live' : 'tbd'
      out.push({ date: d, key, inMonth, sessions: list, isToday, state })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym, byDay])

  /** 当月类型统计（导航栏右侧统计胶囊，服务端 category 口径，仅非零项） */
  const monthStats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of cells) {
      if (!c.inMonth) continue
      for (const s of c.sessions) {
        const t = keyOf(s)
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    const order = LIVE_TYPE_ORDER.map((t) => t.key)
    return order.map((key) => ({ key, n: counts.get(key) ?? 0 })).filter((t) => t.n > 0)
  }, [cells])

  const moveMonth = (delta: number) => {
    setMonthPopOpen(false)
    setNavDir(delta > 0 ? 1 : -1)
    setYm(({ y, m }) => {
      const d = new Date(y, m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  const openMonthPop = () => {
    setPopYear(ym.y)
    setMonthPopOpen((o) => !o)
  }

  const pickMonth = (m: number) => {
    setNavDir(popYear * 12 + m >= ym.y * 12 + ym.m ? 1 : -1)
    setYm({ y: popYear, m })
    setMonthPopOpen(false)
  }

  const openCellPop = (c: DayCell, e: ReactMouseEvent<HTMLDivElement>) => {
    clearPopTimer()
    if (c.state !== 'live') {
      setPop(null)
      return
    }
    setPop({ key: c.key, rect: e.currentTarget.getBoundingClientRect(), sessions: c.sessions })
  }

  const closeCellPop = () => {
    clearPopTimer()
    popTimer.current = window.setTimeout(() => setPop(null), POP_CLOSE_GRACE_MS)
  }

  // Esc 关闭浮层
  useEffect(() => {
    if (!pop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pop])

  /** hover 浮层计时器（离开格子 → 120ms 宽限关闭，允许滑到浮层） */
  const popTimer = useRef<number | null>(null)
  const clearPopTimer = () => {
    if (popTimer.current != null) {
      window.clearTimeout(popTimer.current)
      popTimer.current = null
    }
  }

  /** 用户校正分类（v2 第⑦信号）：PUT/DELETE 后重拉（override/series/learned 后端全链重算） */
  const onPickCategory = async (s: LiveSession, value: string) => {
    const liveId = s.live_id
    if (!liveId || !accountId) return
    try {
      if (value === 'auto') {
        if (s.category_from === 'override') {
          await api.clearLiveSessionCategory(accountId, liveId)
        }
      } else {
        await api.setLiveSessionCategory(accountId, liveId, value)
      }
      load()
      // 详情弹窗内校正 → 同步刷新详情（徽章/分类来源即时更新）
      const d = await api.liveSessionDetail(accountId, liveId)
      setDetail((prev) => (prev ? { ...prev, data: d } : prev))
    } catch (e) {
      setError((e as Error).message || '分类保存失败')
    }
  }

  /** 打开场次详情弹窗（点击日期格；当日多场从第一场起，顶部可切换） */
  const openDetail = (c: DayCell) => {
    clearPopTimer()
    setPop(null)
    if (c.state !== 'live' || c.sessions.length === 0) return
    const first = c.sessions[0]
    setDetail({
      key: c.key, sessions: c.sessions, idx: 0,
      data: null, loading: !!(first.live_id && accountId),
    })
    if (first.live_id && accountId) {
      api.liveSessionDetail(accountId, first.live_id)
        .then((d) => setDetail((p) => (p && p.key === c.key ? { ...p, data: d, loading: false } : p)))
        .catch(() => setDetail((p) => (p && p.key === c.key ? { ...p, loading: false } : p)))
    }
  }

  /** 详情弹窗内切换当日第 idx 场 */
  const switchDetailIdx = (idx: number) => {
    if (!detail || idx === detail.idx) return
    const s = detail.sessions[idx]
    const key = detail.key
    setDetail({ ...detail, idx, data: null, loading: !!(s.live_id && accountId) })
    if (s.live_id && accountId) {
      api.liveSessionDetail(accountId, s.live_id)
        .then((d) => setDetail((p) => (p && p.key === key ? { ...p, data: d, loading: false } : p)))
        .catch(() => setDetail((p) => (p && p.key === key ? { ...p, loading: false } : p)))
    }
  }

  // Esc 关闭详情弹窗
  useEffect(() => {
    if (!detail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetail(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [detail])

  const renderCell = (c: DayCell) => {
    const first = c.sessions[0]
    const toneKey = first ? keyOf(first) : null

    let toneCls = ''
    if (c.state === 'live' && toneKey) toneCls = ` lc-tone-${toneKey}`
    else toneCls = ' tbd'
    // 月份指示（透明度）：非本月一律 pad 淡化，与场次状态无关
    if (!c.inMonth) toneCls += ' pad'
    if (c.isToday) toneCls += ' today'

    let badge = '待定'
    if (c.state === 'live' && toneKey) badge = liveTypeLabel(toneKey)
    // user 2026-09-07：当天没有直播（含礼物日，礼物展示已退役）一律显示休息；
    // 今天及以后（尚未发生）= 待定
    else if (c.key < todayKey) badge = '休息'

    return (
      <div
        key={c.key}
        className={'lc-cell' + toneCls}
        onMouseEnter={(e) => openCellPop(c, e)}
        onMouseLeave={closeCellPop}
        onClick={() => openDetail(c)}
      >
        <div className="lc-cell-head">
          <span className="lc-day">{c.date.getDate()}</span>
          <span className="lc-badge">{badge}</span>
        </div>
        {c.state === 'live' && first ? (
          <div className="lc-cell-body">
            <div className="lc-time-row">
              <span className="lc-time">{fmtTime(new Date(first.start_at))}</span>
              <span className="lc-count">{c.sessions.length} 场</span>
            </div>
            <span className="lc-cell-title">{first.live_title || '场次'}</span>
          </div>
        ) : null}
      </div>
    )
  }

  /** 浮层位置：优先格下方，越界翻上方、水平收进视口 */
  const popStyle = (() => {
    if (!pop) return undefined
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = 300
    const estimate = Math.min(430, 120 + pop.sessions.length * 74)
    const left = Math.min(Math.max(12, pop.rect.left), Math.max(12, vw - width - 12))
    const below = pop.rect.bottom + 8
    const top = below + estimate > vh ? Math.max(12, pop.rect.top - estimate - 8) : below
    return { left, top, width }
  })()

  const renderPop = () => {
    if (!pop || !popStyle) return null
    return createPortal(
      <OverlayScroll className="lc-pop" style={popStyle} role="tooltip">
        <div onMouseEnter={clearPopTimer} onMouseLeave={closeCellPop}>
          <div className="lc-pop-head">
            <span className="lc-pop-date">{pop.key}</span>
            <span className="lc-pop-count">{pop.sessions.length} 场</span>
          </div>
          <div className="lc-pop-list">
            {pop.sessions.map((s, i) => {
              const d0 = new Date(s.start_at)
              const d1 = s.end_at ? new Date(s.end_at) : null
              const t = keyOf(s)
              const meta: string[] = []
              if (s.area_name || s.parent_area_name) {
                meta.push([s.parent_area_name, s.area_name].filter(Boolean).join(' / '))
              }
              meta.push(`${fmtDur(s.duration_minutes)}${d1 ? '' : ' 进行中'}`.trim())
              if ((s.segment_count ?? 1) > 1) meta.push(`中断续播·${s.segment_count} 段合并`)
              const figures: string[] = []
              if ((s.total_income ?? 0) > 0) figures.push(`收益 ${fmtMoney(s.total_income)}`)
              if ((s.max_online_count ?? 0) > 0) figures.push(`峰值在线 ${s.max_online_count!.toLocaleString('zh-CN')}`)
              if ((s.danmakus_count ?? 0) > 0) figures.push(`弹幕 ${s.danmakus_count!.toLocaleString('zh-CN')}`)
              const srcs = (s.source ?? 'self').split('+').filter(Boolean)
              return (
                <div key={s.live_id ?? `${s.start_at}-${i}`} className="lc-pop-item">
                  <div className="lc-pop-item-row">
                    <span className={`lc-pop-badge lc-stat-pill--${t}`}>{liveTypeLabel(t)}</span>
                    <span className="lc-pop-title">{s.live_title || '场次'}</span>
                  </div>
                  <div className="lc-pop-meta">
                    {fmtTime(d0)} – {d1 ? fmtTime(d1) : '进行中'}
                    {meta.length ? ` · ${meta.join(' · ')}` : ''}
                  </div>
                  {figures.length > 0 && <div className="lc-pop-meta">{figures.join(' · ')}</div>}
                  <div className="lc-pop-src">数据源 {srcs.join(' + ')}</div>
                </div>
              )
            })}
          </div>
        </div>
      </OverlayScroll>,
      document.body,
    )
  }

  /** 词云数据（top40 带次数，按词频降序——增量摊铺：面积∝词频） */
  const cloudBubbles = useMemo<CloudWord[]>(() => {
    return [...(detail?.data?.danmaku?.top_words ?? [])]
      .sort((a, b) => b.count - a.count)
      .slice(0, 40)
  }, [detail])

  /** 词云破泡计数 / 恢复信号（段头右侧「已破泡 N · 恢复」，带破泡时出现） */
  const [cloudPopped, setCloudPopped] = useState(0)
  const [cloudRestoreTick, setCloudRestoreTick] = useState(0)

  /** 详情弹窗：直播信息 + 分类校正 + 弹幕词云/指标/直播间动态 */
  const renderDetail = () => {
    if (!detail) return null
    const s: LiveSessionDetail =
      detail.data ?? { ...detail.sessions[detail.idx], danmaku: null, analysis: null }
    const d0 = new Date(s.start_at)
    const d1 = s.end_at ? new Date(s.end_at) : null
    const t = keyOf(s)
    const srcs = (s.source ?? 'self').split('+').filter(Boolean)
    const area = [s.parent_area_name, s.area_name].filter(Boolean).join(' / ')
    return createPortal(
      <div
        className="lc-dlg-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setDetail(null)
        }}
      >
        <div className="lc-dlg" role="dialog" aria-modal>
          {/* 头部驻留区：不随内容滚动（2026-09-07 user 定案——「标题……X」恒驻留、
              滚动条只在内容区悬浮不覆盖头部）；下缘发丝分隔 */}
          <div className="lc-dlg-head-zone">
            <div className="lc-dlg-head">
              <div className="lc-dlg-title">
                {s.live_id ? (
                  <span className="lc-dlg-badge-wrap" ref={catPopRef}>
                    <button
                      type="button"
                      className="lc-dlg-badge-btn"
                      title="选择分类"
                      onClick={() => setCatPopOpen((o) => !o)}
                    >
                      <span className={`lc-pop-badge lc-stat-pill--${t}`}>{liveTypeLabel(t)}</span>
                      <ChevronDown className="lc-dlg-badge-caret" />
                    </button>
                    {catPopOpen && (
                      <span className="lc-dlg-cat-pop">
                        <span className="lc-dlg-cat-list">
                          <button
                            type="button"
                            className={`lc-dlg-cat-opt lc-dlg-cat-auto${s.category_from === 'override' ? '' : ' on'}`}
                            onClick={() => { setCatPopOpen(false); onPickCategory(s, 'auto') }}
                          >
                            自动（跟随推断）
                          </button>
                          {LIVE_TYPE_ORDER.map((t2) => (
                            <button
                              key={t2.key}
                              type="button"
                              className={`lc-dlg-cat-opt lc-stat-pill--${t2.key}${t === t2.key ? ' on' : ''}`}
                              onClick={() => { setCatPopOpen(false); onPickCategory(s, t2.key) }}
                            >
                              {t2.label}
                            </button>
                          ))}
                        </span>
                      </span>
                    )}
                  </span>
                ) : (
                  <span className={`lc-pop-badge lc-stat-pill--${t}`}>{liveTypeLabel(t)}</span>
                )}
                <span className="lc-dlg-name">{s.live_title || '场次详情'}</span>
                <span className="lc-dlg-sub">{detail.key} {fmtTime(d0)}</span>
                {s.category_from === 'override' && (
                  <span className="lc-pop-corr">已校正</span>
                )}
              </div>
              <button type="button" className="lc-dlg-close" aria-label="关闭" onClick={() => setDetail(null)}>
                <X className="size-4" />
              </button>
            </div>

            {/* 当日多场切换（点格默认第一场）——随头部驻留 */}
            {detail.sessions.length > 1 && (
              <div className="lc-dlg-tabs">
                {detail.sessions.map((x, i) => (
                  <button
                    key={x.live_id ?? `${x.start_at}-${i}`}
                    type="button"
                    className={`lc-dlg-tab${i === detail.idx ? ' on' : ''}`}
                    onClick={() => switchDetailIdx(i)}
                  >
                    {fmtTime(new Date(x.start_at))}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 内容区：独立滚动（覆盖式滚动条，只在此层悬浮） */}
          <OverlayScroll className="lc-dlg-body">
            <div className="lc-dlg-main">
            {/* 左列：场次封面（缺失/失败 → 渐变占位，右下角直播状态徽章） */}
            <div className="lc-dlg-cover">
              <SmartImage
                key={s.cover_url ?? 'none'}
                src={s.cover_url}
                className="lc-dlg-cover-img"
                fallbackClassName="lc-dlg-cover-ph"
                fallback={(s.live_title || liveTypeLabel(t)).trim().charAt(0) || '播'}
              />
              <span className={`lc-dlg-status${d1 ? '' : ' live'}`}>
                {d1 ? '已结束' : '直播中'}
              </span>
            </div>

            {/* 右列：直播信息（行式 label 左 · value 右） */}
            <section className="lc-dlg-sec">
              <h4 className="lc-dlg-sec-title">直播信息</h4>
              <dl className="lc-dlg-rows">
                <div className="lc-dlg-row">
                  <dt>时间</dt>
                  <dd>{fmtTime(d0)} – {d1 ? fmtTime(d1) : '进行中'}
                    {fmtDur(s.duration_minutes) ? `（${fmtDur(s.duration_minutes)}）` : ''}</dd>
                </div>
                <div className="lc-dlg-row"><dt>分区</dt><dd>{area || '—'}</dd></div>
                <div className="lc-dlg-row"><dt>收益</dt><dd>{fmtMoney(s.total_income) || '—'}</dd></div>
                <div className="lc-dlg-row">
                  <dt>峰值在线</dt>
                  <dd>{s.max_online_count ? s.max_online_count.toLocaleString('zh-CN') : '—'}</dd>
                </div>
                <div className="lc-dlg-row">
                  <dt>弹幕数</dt>
                  <dd>{s.danmakus_count ? s.danmakus_count.toLocaleString('zh-CN') : '—'}</dd>
                </div>
                {s.metrics && (
                  <>
                    <div className="lc-dlg-row">
                      <dt>观看</dt>
                      <dd>{s.metrics.watch_count != null ? s.metrics.watch_count.toLocaleString('zh-CN') : '—'}</dd>
                    </div>
                    <div className="lc-dlg-row">
                      <dt>点赞</dt>
                      <dd>{s.metrics.like_count != null ? s.metrics.like_count.toLocaleString('zh-CN') : '—'}</dd>
                    </div>
                    <div className="lc-dlg-row">
                      <dt>打赏</dt>
                      <dd>{s.metrics.pay_count != null ? `${s.metrics.pay_count.toLocaleString('zh-CN')} 人` : '—'}</dd>
                    </div>
                    <div className="lc-dlg-row">
                      <dt>互动</dt>
                      <dd>{s.metrics.interaction_count != null ? s.metrics.interaction_count.toLocaleString('zh-CN') : '—'}</dd>
                    </div>
                    {s.metrics.online_rank != null && (
                      <div className="lc-dlg-row">
                        <dt>在线排名</dt>
                        <dd>#{s.metrics.online_rank.toLocaleString('zh-CN')}</dd>
                      </div>
                    )}
                  </>
                )}
                {(s.segment_count ?? 1) > 1 && (
                  <div className="lc-dlg-row">
                    <dt>段数</dt>
                    <dd>{s.segment_count} 段合并（中断续播）</dd>
                  </div>
                )}
                <div className="lc-dlg-row"><dt>数据源</dt><dd>{srcs.join(' + ')}</dd></div>
              </dl>
            </section>
          </div>

          <section className="lc-dlg-sec lc-dlg-sec--full">
            {/* 段头行：标题 + 破泡计数/恢复胶囊（破泡时出现） */}
            <div className="lc-dlg-sec-head">
              <h4 className="lc-dlg-sec-title">弹幕信息</h4>
              {cloudPopped > 0 && cloudBubbles.length > 0 && (
                <button
                  type="button"
                  className="lc-dlg-cloud-restore"
                  onClick={() => setCloudRestoreTick((t) => t + 1)}
                >
                  已破泡 {cloudPopped} · 恢复
                </button>
              )}
            </div>
            {detail.loading ? (
              <div className="lc-dlg-ph">加载中…</div>
            ) : s.danmaku ? (
              <div className="lc-dlg-danmaku">
                <dl className="lc-dlg-rows">
                  {s.danmaku.total != null && (
                    <div className="lc-dlg-row">
                      <dt>弹幕总量</dt>
                      <dd className="lc-dlg-num">{s.danmaku.total.toLocaleString('zh-CN')}</dd>
                    </div>
                  )}
                  {s.metrics?.is_full === false && (
                    <div className="lc-dlg-row">
                      <dt>完整性</dt>
                      <dd>弹幕数据未全量（部分录制源）</dd>
                    </div>
                  )}
                </dl>
                {cloudBubbles.length ? (
                  <MosaicCloud
                    data={cloudBubbles}
                    boxH={210}
                    restoreTick={cloudRestoreTick}
                    onPoppedChange={setCloudPopped}
                  />
                ) : (
                  <div className="lc-dlg-ph">暂无热词数据</div>
                )}
              </div>
            ) : (
              <div className="lc-dlg-ph">暂无弹幕数据（danmakus 未收录该场次或拉取失败）</div>
            )}
          </section>

          <section className="lc-dlg-sec lc-dlg-sec--full">
            <h4 className="lc-dlg-sec-title">直播动态</h4>
            {detail.loading ? (
              <div className="lc-dlg-ph">加载中…</div>
            ) : (s.events?.length || s.metrics?.peaks?.length) ? (
              <div className="lc-dlg-evts">
                {(s.events ?? []).map((ev, i) => (
                  <div key={`ev-${i}`} className="lc-dlg-evt">
                    <span className={`lc-dlg-evt-dot${ev.type === 7 ? ' stop' : ''}`} />
                    <span className="lc-dlg-evt-time">
                      {ev.send_date ? fmtTime(new Date(ev.send_date)) : '--:--'}
                    </span>
                    <span className="lc-dlg-evt-text">
                      {ev.type === 7 ? '直播中止' : '直播继续'}
                    </span>
                  </div>
                ))}
                {(s.metrics?.peaks?.length ?? 0) > 0 && (
                  <div className="lc-dlg-evt-block">
                    <div className="lc-dlg-evt-label">最热时刻（在线峰值）</div>
                    {(s.metrics!.peaks as { ts: number; count: number }[])
                      .slice(0, 3)
                      .map((p) => (
                        <div key={`peak-${p.ts}`} className="lc-dlg-evt">
                          <span className="lc-dlg-evt-dot peak" />
                          <span className="lc-dlg-evt-time">{fmtTime(new Date(p.ts))}</span>
                          <span className="lc-dlg-evt-text">
                            {Number(p.count ?? 0).toLocaleString('zh-CN')} 人在线
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="lc-dlg-ph">暂无动态数据</div>
            )}
          </section>

          <section className="lc-dlg-sec lc-dlg-sec--full">
            <h4 className="lc-dlg-sec-title">直播内容分析</h4>
            {s.analysis ? (
              <div className="lc-dlg-ph">{s.analysis.summary || '内容分析摘要待接入'}</div>
            ) : (
              <div className="lc-dlg-ph">接口已预留（内容分析服务接入后展示）</div>
            )}
          </section>
          </OverlayScroll>
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <div className="live-calendar">
      {/* 卡片标题（与归档卡标题同规格 16.5px/600）+ 空月提示 */}
      <div className="lc-title">
        直播日历
        {!loading && !error && monthStats.length === 0 && (
          <span className="lc-note">本月暂无直播记录</span>
        )}
      </div>

      {/* 导航行：左=月份浮片组（点击弹选月浮窗） · 右=当月类型统计胶囊（frame 10_642） */}
      <div className="lc-nav-row">
        <div className="lc-nav" ref={navRef}>
          <button type="button" title="上个月" className="lc-nav-btn" onClick={() => moveMonth(-1)}>
            <ChevronsLeft className="lc-nav-icon" />
          </button>
          <button type="button" className="lc-nav-pill" title="选择月份" onClick={openMonthPop}>
            <span className="lc-nav-text">{fmtMonth(ym.y, ym.m)}</span>
          </button>
          <button type="button" title="下个月" className="lc-nav-btn" onClick={() => moveMonth(1)}>
            <ChevronsRight className="lc-nav-icon" />
          </button>

          {/* 月份选择浮窗：年切换 + 12 月宫格 */}
          {monthPopOpen && (
            <div className="lc-month-pop">
              <div className="lc-month-pop-head">
                <button type="button" title="上一年" onClick={() => setPopYear((y) => y - 1)}>
                  <ChevronLeft className="size-4" />
                </button>
                <span className="lc-month-pop-year">{popYear}年</span>
                <button type="button" title="下一年" onClick={() => setPopYear((y) => y + 1)}>
                  <ChevronRight className="size-4" />
                </button>
              </div>
              <div className="lc-month-pop-grid">
                {MONTH_CN.map((name, i) => (
                  <button
                    key={name}
                    type="button"
                    className={`lc-month-pop-btn${i === ym.m && popYear === ym.y ? ' on' : ''}`}
                    onClick={() => pickMonth(i)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 当月类型统计胶囊（彩色胶囊 + 计数，设计稿 frame 10_642；服务端 category 口径） */}
        <div className="lc-stats">
          {monthStats.map((t) => (
            <div key={t.key} className="lc-stat">
              <span className={`lc-stat-pill lc-stat-pill--${t.key}`}>{liveTypeLabel(t.key)}</span>
              <span className="lc-stat-num">{t.n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 月历区（设计稿 frame 10_659：表头与网格 gap 5px） */}
      <div className="lc-body">
        {/* 星期表头（Mon.~Sun.，14px #727272 → --c-text-sub） */}
        <div className="lc-weekdays">
          {WEEKDAYS_EN.map((w) => (
            <div key={w} className="lc-weekday">{w}</div>
          ))}
        </div>

        {/* 月历网格：7 列 × 6 行，列/行距 4px（keyed 重放月份切换滑动动画） */}
        <div key={`${ym.y}-${ym.m}`} className={`lc-grid-anim${navDir === 1 ? '' : ' back'}`}>
          <div className="lc-grid">
            {loading && (
              <div className="lc-state">
                <Loader2 className="lc-state-icon" />
              </div>
            )}
            {!loading && error && <div className="lc-state lc-error">{error}</div>}
            {!loading && !error && cells.map((c) => renderCell(c))}
          </div>
        </div>
      </div>

      {renderPop()}
      {renderDetail()}
    </div>
  )
})

export default LiveCalendar
