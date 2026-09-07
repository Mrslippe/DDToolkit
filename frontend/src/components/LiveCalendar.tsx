import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2, X } from 'lucide-react'
import type { LiveSession, LiveSessionDetail } from '../api/types'
import { api, imgProxyUrl } from '../api/api'
import { normalizeImageUrl } from '../utils/format'
import OverlayScroll from './OverlayScroll'
import { LIVE_TYPE_ORDER, inferLiveType, liveTypeLabel } from '../utils/liveType'

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

/**
 * 弹窗封面（全站图片方案同款，devlog/015）：
 * 1. 直连 CDN（https 归一 + no-referrer 绕防盗链——裸 img 漏了 referrerPolicy
 *    曾致 403，2026-09-07 用户反馈 bootDiag 右上角报错胶囊）
 * 2. onError → 后端代理 /img-proxy（磁盘缓存）
 * 3. 代理也失败 → 渐变占位（首字），不挂破图
 */
function CoverImage({ src, fallbackChar }: { src?: string | null; fallbackChar: string }) {
  const [stage, setStage] = useState<'direct' | 'proxy' | 'failed'>('direct')
  if (src == null || stage === 'failed') {
    return <span className="lc-dlg-cover-ph">{fallbackChar}</span>
  }
  const direct = normalizeImageUrl(src)
  return (
    <img
      className="lc-dlg-cover-img"
      src={stage === 'direct' ? direct : imgProxyUrl(direct)}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setStage((st) => (st === 'direct' ? 'proxy' : 'failed'))}
    />
  )
}

/** 词云配色（浅色粉系——2026-09-07 用户：浅色更符合卡片整体风格；文字用深色） */
const CLOUD_COLORS = ['#ffc9c4', '#a5e6ff', '#dccff7', '#bee9ec', '#ffd5b8',
  '#fff2a0', '#fda5ff', '#b2f3c0', '#ffdfe8', '#d8e8ff']

function cloudWordColor(w: { text?: string }): string {
  const s = w.text ?? ''
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 997
  return CLOUD_COLORS[h % CLOUD_COLORS.length]
}

interface BubbleWord {
  text: string
  count: number
}

/**
 * ── 圆形气泡簇（disk bubble cluster，2026-09-07 user 定案·从头开始）──
 * ① 半径恒定 ∝ √词频（面积 ∝ 词频，一以贯之：打开/破泡/恢复全程不变）；
 * ② 径向边界 R = √(Σr²)（团簇面积守恒圆半径），圆心 = 容器中心 →
 *    整簇天然圆形；允许 10% 挤压 → 贴合处呈现「被邻泡压出的弧」（交界不规则）；
 * ③ 破泡 = 去掉该词 + R 收缩 + 有限时长（24 帧）衰减洞吸力 →
 *    周围泡泡立即被拉向洞口闭合（接触链分配）；边界弹簧恒定场 → 单调收敛。
 * 参数经 node 原型调参：初始稳态重叠 ≤8.1%、面积比例严格 ∝ 词频、闭合后无 NaN。
 */

/** 泡泡模拟状态（位置/速度；半径恒定不变） */
interface CircleWord {
  word: BubbleWord
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

/** 破泡洞吸力（有限时长，随帧衰减） */
interface HolePull {
  x: number
  y: number
  r: number
  strength: number
}

const CLUSTER_PACK = 0.72        // 团簇面积 / 容器面积（泡沫堆积密度）
const CLUSTER_RATIO_R = 0.46     // 团簇半径上限：min(w,h)·0.46（直径 ≤ 0.92·高）
const CLUSTER_OVERLAP = 0.10     // 允许挤入 10%（贴合压弧的视觉来源）
const KR = 24                    // 重叠软弹簧（线性，px/s² per px）
const KB = 10                    // 径向边界软弹簧
const DAMP = 9                   // 阻尼 exp(−9·dt)
const VMAX = 420                 // 速度上限 px/s
const FILL_FRAMES = 24           // 洞吸力持续帧数（随帧线性衰减到 0）
const FILL_STRENGTH = 140        // 洞吸力初始加速度 px/s²
const SETTLE_DISP = 1.0          // 帧位移总和阈值（<1px ≈ 0.08px/盘，视为静止）
const SETTLE_CAP = 90            // 模拟帧帽（渐近蠕动到不了阈值时的兜底）
const INIT_SOLVE = 320           // 初始预求解帧数（打开即稳态，无开场动画）

/** 半径：总盘面积 = 容器面积×密度；团簇直径受高度限制（圆形优先） */
function computeRadii(words: BubbleWord[], w: number, h: number): number[] {
  const maxC = Math.max(...words.map((x) => x.count)) || 1
  const ratio = words.map((x) => x.count / maxC)
  const areaSum = ratio.reduce((a, b) => a + b, 0)
  let rBase = Math.sqrt((w * h * CLUSTER_PACK) / (Math.PI * areaSum))
  rBase = Math.min(rBase, (Math.min(w, h) * CLUSTER_RATIO_R) / Math.sqrt(areaSum))
  return ratio.map((r) => Math.max(5, rBase * Math.sqrt(r)))
}

/** 初始布局：螺旋（大词在内、黄金角）——确定性，无随机 */
function buildClusterWords(words: BubbleWord[], w: number, h: number): CircleWord[] {
  const rs = computeRadii(words, w, h)
  const x0 = w / 2
  const y0 = h / 2
  let acc = 0
  return rs.map((r, i) => {
    if (i > 0) acc += Math.PI * rs[i - 1] * rs[i - 1]
    const rad = Math.sqrt(acc) * 1.05
    const ang = i * 2.399963 // 黄金角
    return { word: words[i], x: x0 + rad * Math.cos(ang), y: y0 + rad * Math.sin(ang), vx: 0, vy: 0, r }
  })
}

/** 团簇边界半径（面积守恒）：R = √(Σr²) */
function clusterRadius(pts: CircleWord[]): number {
  return Math.sqrt(pts.reduce((s, p) => s + p.r * p.r, 0))
}

/**
 * 单帧演化（就地更新位置/速度，返回帧位移总和）：
 * 力 = 径向边界软弹簧（outside R 才推回）+ 重叠软弹簧（< 0.9·(ri+rj) 才推挤）
 *       + 可选洞吸力（有限时长衰减）→ 速度阻尼积分 + 容器 clamp。
 */
function clusterStep(pts: CircleWord[], w: number, h: number, dt: number, pull?: HolePull | null): number {
  const n = pts.length
  if (n === 0) return 0
  const cx = w / 2
  const cy = h / 2
  const R = clusterRadius(pts)
  const ax = new Array(n).fill(0)
  const ay = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const dx = cx - p.x
    const dy = cy - p.y
    const d = Math.hypot(dx, dy) || 1e-6
    const over = d + p.r - R
    if (over > 0) {
      ax[i] += (dx / d) * KB * over
      ay[i] += (dy / d) * KB * over
    }
    if (pull) {
      const pdx = pull.x - p.x
      const pdy = pull.y - p.y
      const pd = Math.hypot(pdx, pdy) || 1e-6
      const wgt = Math.max(0, 1 - (pd - p.r - pull.r) / 110) // 越近受力越大
      const a = pull.strength * wgt
      ax[i] += (pdx / pd) * a
      ay[i] += (pdy / pd) * a
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = pts[i]
      const b = pts[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.hypot(dx, dy) || 1e-6
      const delta = (a.r + b.r) * (1 - CLUSTER_OVERLAP) - d
      if (delta > 0) {
        const f = KR * delta
        const wa = (b.r * b.r) / (a.r * a.r + b.r * b.r)
        ax[i] -= (dx / d) * f * wa
        ay[i] -= (dy / d) * f * wa
        ax[j] += (dx / d) * f * (1 - wa)
        ay[j] += (dy / d) * f * (1 - wa)
      }
    }
  }
  let disp = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    let vx = (p.vx + ax[i] * dt) * Math.exp(-DAMP * dt)
    let vy = (p.vy + ay[i] * dt) * Math.exp(-DAMP * dt)
    const sp = Math.hypot(vx, vy)
    if (sp > VMAX) {
      vx = (vx / sp) * VMAX
      vy = (vy / sp) * VMAX
    }
    p.vx = vx
    p.vy = vy
    p.x += vx * dt
    p.y += vy * dt
    disp += Math.hypot(vx, vy) * dt
    if (p.x < p.r) { p.x = p.r; if (p.vx < 0) p.vx = 0 }
    if (p.x > w - p.r) { p.x = w - p.r; if (p.vx > 0) p.vx = 0 }
    if (p.y < p.r) { p.y = p.r; if (p.vy < 0) p.vy = 0 }
    if (p.y > h - p.r) { p.y = h - p.r; if (p.vy > 0) p.vy = 0 }
  }
  return disp
}

/** 同步预求解：打开/恢复时跑到手近稳态（无开场动画） */
function clusterSettle(pts: CircleWord[], w: number, h: number): void {
  const dt = 1 / 60
  for (let f = 0; f < INIT_SOLVE; f++) {
    if (clusterStep(pts, w, h, dt) < SETTLE_DISP) break
  }
  for (const p of pts) {
    p.vx = 0
    p.vy = 0
  }
}
/**
 * 圆形气泡簇词云（2026-09-07 user 定案「从头开始」；参考图形态：圆形泡沫团）。
 * - 半径恒定 ∝ √词频 → 面积 ∝ 词频（一以贯之：打开/破泡/恢复全程不变）；
 * - 整簇天然圆形（径向边界 R=√Σr²，圆心=容器中心），贴合处 10% 挤压呈现
 *   被邻泡压出的弧（交界不规则）；
 * - 破泡 = 去词 + 洞吸力（24 帧衰减）+ 边界收缩 → 周围泡泡立即闭合空洞；
 *   无需任何装饰动画（无鼓泡/环波/过冲，user：多余动画不需要）；
 * - hover 高亮 + 「词 · N 次」提示 + 「已破泡 N · 恢复」一键复原；
 * - 静止即停：帧位移总和 < 1px 或 90 帧帽 → 停帧。
 */
function VoronoiCloud({
  data,
  restoreTick,
  onPoppedChange,
}: {
  data: BubbleWord[]
  /** 外部恢复信号（父级「已破泡 N · 恢复」按钮），>0 时执行一次复原 */
  restoreTick?: number
  /** 破泡数量变化回调（父级计数胶囊显示/更新） */
  onPoppedChange?: (n: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 210 })
  const [tip, setTip] = useState<{ x: number; y: number; text: string; count: number } | null>(null)
  // hover 以词 text 为键（破泡后索引会错位，text 稳定）
  const [hover, setHover] = useState<string | null>(null)
  /** 破泡计数（供恢复胶囊；simRef 同步删词） */
  const poppedN = useRef(0)

  /** 气泡簇权威状态（静止时也持有）；rebuildTick 驱动重渲染（每帧模拟后自增） */
  const simRef = useRef<CircleWord[]>([])
  const pullRef = useRef<{ x: number; y: number; r: number; frame: number } | null>(null)
  const loopRef = useRef<{ raf: number } | null>(null)
  const [, setRebuildTick] = useState(0)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const dataRef = useRef(data)
  dataRef.current = data

  const stopLoop = useCallback(() => {
    if (loopRef.current) {
      window.cancelAnimationFrame(loopRef.current.raf)
      loopRef.current = null
    }
  }, [])

  /** 重建簇（初始/切换/恢复/尺寸变化）：螺旋初值 + 同步预求解（打开即稳态） */
  const rebuildCluster = useCallback(() => {
    stopLoop()
    pullRef.current = null
    const d = dataRef.current
    const w = sizeRef.current.w
    const h = sizeRef.current.h
    simRef.current = w >= 80 && d.length > 0
      ? buildClusterWords(d, w, h)
      : []
    clusterSettle(simRef.current, w, h)
    setRebuildTick((t) => t + 1)
  }, [stopLoop])

  // 数据/尺寸变化依赖重建（引用变化即触发；数据为空时清空）
  useEffect(() => {
    rebuildCluster()
  }, [data, size.w, size.h, rebuildCluster])

  // 场次切换 → 破泡计数清零（重开弹窗语义）
  useEffect(() => {
    poppedN.current = 0
    setHover(null)
    setTip(null)
    onPoppedChange?.(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // 外部恢复信号：重建全量簇（物理归位到初始稳态）
  useEffect(() => {
    if (!restoreTick) return
    poppedN.current = 0
    setHover(null)
    setTip(null)
    rebuildCluster()
    onPoppedChange?.(0)
  }, [restoreTick, rebuildCluster, onPoppedChange])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((es) => {
      const w = Math.round(es[0]?.contentRect.width ?? 0)
      if (w > 0) setSize((s) => ({ ...s, w }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => () => stopLoop(), [stopLoop])

  /** 模拟主循环：每帧 clusterStep（携带残余洞吸力），帧位移阈值或帧帽 → 停帧 */
  const startLoop = useCallback(() => {
    let last = performance.now()
    let frame = 0
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30)
      last = now
      const pts = simRef.current
      frame += 1
      const pull = pullRef.current
      const activePull = pull && frame <= FILL_FRAMES
        ? {
            x: pull.x,
            y: pull.y,
            r: pull.r,
            strength: FILL_STRENGTH * (1 - frame / FILL_FRAMES),
          }
        : null
      if (frame > FILL_FRAMES) pullRef.current = null
      if (pts.length === 0) {
        loopRef.current = null
        return
      }
      const disp = clusterStep(pts, sizeRef.current.w, sizeRef.current.h, dt, activePull)
      setRebuildTick((t) => t + 1)
      if (disp < SETTLE_DISP && frame > 8) {
        loopRef.current = null // 静止即停：终态即当前簇
        return
      }
      if (frame >= SETTLE_CAP) {
        loopRef.current = null // 帧帽兜底（渐近蠕动不可见）
        return
      }
      loopRef.current = { raf: requestAnimationFrame(step) }
    }
    loopRef.current = { raf: requestAnimationFrame(step) }
  }, [])

  /** 破泡：去词（立即消失，无动画）→ 洞吸力 + 边界收缩 → 启动闭合 */
  const popWord = (text: string) => {
    const S = simRef.current
    const pop = S.find((s) => s.word.text === text)
    if (!pop) return
    const x = pop.x
    const y = pop.y
    const r = pop.r
    simRef.current = S.filter((s) => s.word.text !== text)
    poppedN.current += 1
    onPoppedChange?.(poppedN.current)
    setHover(null)
    setTip(null)
    pullRef.current = { x, y, r, frame: 0 }
    if (simRef.current.length === 0) {
      setRebuildTick((t) => t + 1)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // 无障碍：同步结算到近稳态（瞬时闭合），不跑动画
      clusterSettle(simRef.current, sizeRef.current.w, sizeRef.current.h)
      setRebuildTick((t) => t + 1)
      return
    }
    setRebuildTick((t) => t + 1)
    startLoop()
  }

  return (
    <div ref={ref} className="lc-dlg-cloud">
      {size.w > 0 && simRef.current.length > 0 && (
        <svg width={size.w} height={size.h} className="lc-dlg-cloud-svg">
          {simRef.current.map((c) => {
            const { word, x, y, r } = c
            const hero = simRef.current[0].word.text === word.text
            // 2026-09-07：字号随半径（面积∝词频）——下限 8.5px，长词自缩减
            const fs = Math.max(8.5, Math.min(hero ? 34 : 26, r * 0.9, (r * 2.2) / Math.max(2, word.text.length)))
            const showText = r > 10.5 && word.text.length <= 6 && fs >= 8.5
            const hovered = hover === word.text
            const dimmed = hover !== null && !hovered
            return (
              <g
                key={word.text}
                className="lc-dlg-cloud-cell"
                style={{ transform: `translate(${x}px, ${y}px)` }}
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
                <circle
                  r={r}
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
                    fill={hovered ? 'var(--c-text-main)' : 'var(--c-text-sub)'}
                    fontWeight={hovered || hero ? 700 : 600}
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
      {size.w > 0 && simRef.current.length === 0 && (
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

  /** 词云数据（top40 带次数；加权 Voronoi 拼贴：面积∝词频） */
  const cloudBubbles = useMemo<BubbleWord[]>(() => {
    return (detail?.data?.danmaku?.top_words ?? []).slice(0, 40)
  }, [detail])

  /** 词云破泡计数 / 恢复信号（2026-09-07：标题行右侧「已破泡 N · 恢复」胶囊；
      切换场次时 VoronoiCloud 经 onPoppedChange(0) 自动归零） */
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
              <CoverImage
                key={s.cover_url ?? 'none'}
                src={s.cover_url}
                fallbackChar={(s.live_title || liveTypeLabel(t)).trim().charAt(0) || '播'}
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
                  <VoronoiCloud
                    data={cloudBubbles}
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
