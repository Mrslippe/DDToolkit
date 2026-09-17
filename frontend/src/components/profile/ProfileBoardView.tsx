/**
 * 档案视图（R37-P1 只读画布 → **R37-P2b 可编辑**，devlog/141 / 144）—— 卡片画布。
 *
 * 用户口径（2026-09-17）：「我们把它称作**档案视图**……以卡片为基本单位，用户可以编辑
 * 卡片的大小、位置、排布，卡片内容由用户自定义（纪念日、优质投稿、大事记、时间线…），
 * 然后支持拓展和自定义」。
 *
 * ## 四个选型（同日拍板，本批全部落地）
 *
 * **自研** CSS Grid · 布局存**新表 `profile_cards`** · 碰撞**推开** + 编辑/阅读态**分离** ·
 * 扩展点 = **前端卡片注册表**。
 *
 * ## 本批（P2b）做到哪一步
 *
 * ✅ 读接口（空 = 用默认布局）· ✅ 编辑态（手柄 / 网格辅助线 / 重置默认 / 完成）·
 * ✅ 指针拖拽与缩放（复用 `layoutModel` 的 `moveCard` / `resizeCard`，**推开**口径）·
 * ✅ 松手存一次（整版 PUT；失败回滚到上一版并说明）。
 * ⛔ P3：自定义卡片（新增/删除卡片、`config_json`）与扩展点接线。
 *
 * ## 三条纪律（与其它视图一致）
 *
 * 1. **数据由卡片自己取**（每张卡的数据源不同，页面不该认识卡片需要什么）；
 * 2. **高度由网格算死**（`ROW_H × h + GAP × (h-1)`，探针按这个式子核对实渲染）；
 * 3. **窄窗降级看容器宽**（`ResizeObserver`）—— 且**窄窗下不允许编辑**：
 *    单列布局是模型算出来的，编辑会跟它打架（按钮禁用 + 写明原因）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { Check, GripVertical, Plus, RotateCcw, SlidersHorizontal, X } from 'lucide-react'

import { api } from '../../api/api'
import type { Post, ProfileCardRow, VTuber } from '../../api/types'
import usePrefersReducedMotion from '../../hooks/usePrefersReducedMotion'
import { pill } from '../../utils/pill'
import OverlayScroll from '../OverlayScroll'
import { getCardKind, listCardKinds, type CardKindMeta } from './cardRegistry'
import {
  GRID_COLS, GRID_GAP, ROW_H, MIN_W, MIN_H, NARROW_PX, cardHeightPx, cellsFromPx, columnWidthPx,
  defaultLayout, firstFreeSlot, gridStyle, isNarrow, moveCard, removeCard, resizeCard,
  toSingleColumn, type CardLayout,
} from './layoutModel'
import {
  flipDelta, flipDurationMs, needsFlip,
} from './flip'
import {
  LONG_PRESS_MS, SETTLE_GRACE_MS, type CardPhase, contentDelta, isDrag, liftOffset,
  motionPlan, nextPhase, phaseTransform,
} from './motion'
import { autoScrollSpeed, nextScrollTop } from './autoScroll'
import './cards'                       // 副作用：注册内置卡片（加卡片不用改本文件）
import '../../styles/profile-board.css'
interface Props {
  vtuber: VTuber
  /** 抓取完成边沿（卡片据此重取自己的数据） */
  refreshTick: number
  /** 打开帖子详情抽屉（复用页面里那一个） */
  onOpenPost: (post: Post) => void
}

/** 档案视图跟随的账号：B 站优先、否则第一个有 UID 的（与展示页 hero 同口径）。 */
function pickAccount(vtuber: VTuber) {
  return vtuber.accounts.find((a) => a.platform === 'bilibili' && a.platform_uid)
    ?? vtuber.accounts.find((a) => a.platform_uid)
    ?? null
}

/** 服务端行 → 布局模型（`card_key` 就是实例 id） */
const toLayout = (r: ProfileCardRow): CardLayout =>
  ({ id: r.card_key, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h })

export default function ProfileBoardView({ vtuber, refreshTick, onOpenPost }: Props) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [cards, setCards] = useState<CardLayout[] | null>(null)   // null = 还没取到
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 最近一次**已落库**的布局（保存失败时回滚到它；也用来判断"有没有改动"） */
  const savedRef = useRef<CardLayout[]>([])
  /** 最新布局（pointerup 时读它 —— 事件闭包里的 `cards` 可能落后一帧） */
  const cardsRef = useRef<CardLayout[]>([])
  cardsRef.current = cards ?? []

  /** 还在读布局（首帧渲染骨架，还没有网格可观察） */
  const loading = cards === null

  /** 动效调测页（`?motion=cards`）：dev 构建 + 带参数时才**动态**载入 */
  const [Lab, setLab] = useState<ComponentType<{ gridRef: typeof gridRef }> | null>(null)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!new URLSearchParams(window.location.search).has('motion')) return
    void import('../../dev/MotionLab').then((m) => setLab(() => m.default))
  }, [])

  // 容器宽 → 窄窗降级（首帧 width=0 时不降级，见 layoutModel.isNarrow）
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [loading])   // 骨架换成网格后重新观察（那时才有 [data-board]）

  const kinds = listCardKinds()
  const narrow = isNarrow(width)

  /** 默认排布（注册表顺序 = 默认顺序） */
  const buildDefault = useCallback(
    () => defaultLayout(kinds.map((k) => ({ kind: k.kind, defaultSize: k.defaultSize }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kinds.length],
  )

  // 拉布局：空数组 = 还没排过 ⇒ 用默认布局（**不落库**：用户没动过就不写）
  useEffect(() => {
    let cancelled = false
    setCards(null)
    api.profileCards(vtuber.id)
      .then((rows) => {
        if (cancelled) return
        const layout = rows.length ? rows.map(toLayout) : buildDefault()
        savedRef.current = layout
        setCards(layout)
      })
      .catch(() => {
        if (cancelled) return
        const layout = buildDefault()
        savedRef.current = layout
        setCards(layout)
      })
    return () => { cancelled = true }
  }, [vtuber.id, buildDefault])

  /** 保存（整版 PUT）：成功就用服务端返回的行（id 会重发），失败**回滚**到上一版 */
  const persist = useCallback(async (next: CardLayout[]) => {
    setBusy(true)
    try {
      const rows = await api.saveProfileCards(vtuber.id, next.map((c) => ({
        card_key: c.id, kind: c.kind, x: c.x, y: c.y, w: c.w, h: c.h,
      })))
      const applied = rows.map(toLayout)
      savedRef.current = applied
      setCards(applied)
      pill('布局已保存')
    } catch {
      // 失败必须**退回原样**并说出来 —— 界面上不能留着"看着排好了、其实没存上"
      setCards(savedRef.current)
      pill('布局保存失败，已恢复上一次的排布')
    } finally {
      setBusy(false)
    }
  }, [vtuber.id])

  // ── 指针手势（R37-P4b：长按拾起 → 跟手 1:1 → 松手落位）──────────────────
  //
  // 相位机与算式都在 `motion.ts`（纯函数、有单测）；这里只负责"喂事件 + 画相位"。
  // 三条纪律：
  //   ① 长按 350ms 才算拾起（与 Hero 药丸重排同值）；没到就抬手 ⇒ 只是短按（点击语义照常）；
  //   ② 拾起后位置**跟手**（`pointerDelta − cellDelta`），格子仍逐格换位 ⇒ 观感连续；
  //   ③ 迟到的长按定时器必须无害（抬手之后才到 ⇒ 不许把卡片又拿起来）。
  const dragRef = useRef<{
    id: string
    mode: 'move' | 'resize'
    startX: number
    startY: number
    base: CardLayout[]
    origin: CardLayout
    moved: boolean
  } | null>(null)

  /** 手势的**可见**部分（相位 + 跟手位移 + 缩放中的尺寸）—— 这个进 state，因为要画出来 */
  const [gesture, setGesture] = useState<
    { id: string; phase: CardPhase; x: number; y: number; w?: number; h?: number } | null
  >(null)
  const pressTimer = useRef<number | null>(null)

  /**
   * 退避动画（R37-P4c，规格 §5.2）：**被挤开的卡先补一段"抵消位移"再滑回去**（FLIP）。
   *
   * `settled=false` 的那一帧是 I（Invert：打上补偿位移、`transition: none`，看着没动）；
   * `settled=true` 之后撤掉 transform 并登记过渡，于是 P（Play）——卡片从旧位置滑到新位置。
   * 拖动中的那张卡**不参与**（它由跟手位移驱动，两条动画打架会看出"被拽回去"）。
   */
  const [flips, setFlips] = useState<
    Record<string, { x: number; y: number; ms: number; settled: boolean }>
  >({})
  /** 布局变化前的卡片位置（FLIP 的"F"）；由 `applyLayout` 在改 DOM 之前量 */
  const rectsRef = useRef<Record<string, { x: number; y: number }>>({})

  const reduced = usePrefersReducedMotion()
  const plan = motionPlan(reduced)

  // ── 自动滚动（R37-P4d，规格 §5.7）──────────────────────────────────────
  //
  // 口径一句话：**滚动与跟手用同一套坐标**。`D = P + S`（指针位移 + 滚动量）既喂模型格位、
  // 也喂跟手补偿 ⇒ 卡片视口位置恒等于手指位置（`S` 在代入时抵消），滚动中不可能漂。
  // 驱动方式：**滚动是主量**，`scrollTop` 涨 ⇒ `D` 涨 ⇒ 模型下探 ⇒ 网格长高 ⇒ 能滚更多（自洽）。
  const scrollRef = useRef<HTMLDivElement | null>(null)      // OverlayScroll 的滚动体
  const scroll0Ref = useRef(0)                                // 手势开始时的 scrollTop
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const lastTsRef = useRef(0)
  /**
   * 待落的滚动位置（R37-P4d 的"不许错位"关键）。
   *
   * ⚠️ 为什么不能直接 `sc.scrollTop = next` 了事：滚动是**同步**生效的，而跟手补偿要等
   * React 渲染才落到 DOM 上 —— 中间那一帧卡片就比手指多偏了"这一跳的滚动量"
   * （实测 15px = 24ms × 620px/s，看着就是抖）。所以改成：循环只把目标位置记在这里 +
   * 更新手势状态；由 `useLayoutEffect`（DOM 改完、**绘制之前**）把两者一起落下去 ⇒
   * **任何一帧画出来的都是自洽的**。
   */
  const pendingScroll = useRef<number | null>(null)
  /** 手势相位的**同步**镜像（rAF 循环里读 state 会拿到旧值） */
  const gestureRef = useRef<{ id: string; phase: CardPhase } | null>(null)
  gestureRef.current = gesture

  const scrollDelta = () => (scrollRef.current?.scrollTop ?? 0) - scroll0Ref.current

  const stopAutoScroll = () => {
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingScroll.current = null
    lastTsRef.current = 0
  }

  /**
   * 自动滚动循环：**双驱动**（rAF 为主 + 定时器兜底）。
   *
   * 为什么不能只用 rAF：探针的虚拟时间下 **rAF 几乎不被服务**（实测 400ms 只被叫 1 次），
   * 而"探针看不见的行为等于没护栏"（本仓的老规矩）。定时器在两种环境下都被服务，
   * 于是这条功能可被机器判。真机上两者都在跑，靠一个 8ms 的时间闸门保证**不会滚两倍速**。
   */
  const startAutoScroll = () => {
    if (rafRef.current != null || timerRef.current != null) return
    const schedule = () => {
      rafRef.current = window.requestAnimationFrame(tick)
      timerRef.current = window.setTimeout(tick, 24)
    }
    const tick = () => {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const d = dragRef.current
      if (!d) return                       // 手势结束 ⇒ 真正停表（endDrag 也会调 stop）
      const now = performance.now()
      const since = lastTsRef.current ? now - lastTsRef.current : 16
      if (since < 8) {                     // 同一帧被两个驱动各叫一次 ⇒ 只算一次
        schedule()
        return
      }
      lastTsRef.current = now
      const sc = scrollRef.current
      const lp = lastPointer.current
      if (sc && lp && gestureRef.current?.phase === 'lifted') {
        const box = sc.getBoundingClientRect()
        const speed = autoScrollSpeed(lp.y, box.top, box.bottom)
        const next = nextScrollTop(sc.scrollTop, speed, Math.min(64, since),
                                   sc.scrollHeight - sc.clientHeight)
        if (next !== sc.scrollTop) {
          // 先记账、再让 React 把"用这个新滚动量算出来的补偿"渲染出来；
          // 真正写 scrollTop 的是下面的 useLayoutEffect（与补偿同一帧落下）
          pendingScroll.current = next
          applyDrag(lp.x, lp.y, next)
        }
      }
      schedule()
    }
    schedule()
  }

  /**
   * 把"待落的滚动位置"与跟手补偿**在同一帧**落下（DOM 已改完、绘制之前）。
   * 顺序无所谓：补偿是用 `next` 算的，两边一致；但**必须都在绘制前** —— 否则就是那 15px 的抖。
   */
  useLayoutEffect(() => {
    const p = pendingScroll.current
    const sc = scrollRef.current
    pendingScroll.current = null
    if (p != null && sc && sc.scrollTop !== p) sc.scrollTop = p
  }, [gesture])

  useEffect(() => stopAutoScroll, [])

  /** 量下当前所有卡的位置（FLIP 的 First 步）—— **内容坐标**（rect + scrollTop）：
   *  自动滚动期间视图会滚，用视口坐标量出来的位移会混进滚动量（退避就会算错）。 */
  const captureRects = () => {
    const el = gridRef.current
    if (!el) return
    const st = scrollRef.current?.scrollTop ?? 0
    const out: Record<string, { x: number; y: number }> = {}
    for (const node of el.querySelectorAll<HTMLElement>('.pcard')) {
      const key = node.getAttribute('data-card-key')
      if (!key) continue
      const r = node.getBoundingClientRect()
      out[key] = { x: r.left, y: r.top + st }
    }
    rectsRef.current = out
  }

  /** 改布局的唯一入口：先记旧位置（给 FLIP 用）再落新布局 */
  const applyLayout = (next: CardLayout[]) => {
    if (!reduced) captureRects()      // 减少动效 ⇒ 不做退避动画，也就没必要量
    setCards(next)
  }

  const clearGestureTimers = () => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  const beginDrag = (e: React.PointerEvent, card: CardLayout, mode: 'move' | 'resize') => {
    if (narrow || busy) return
    // 缩放手柄只在编辑态存在
    if (mode === 'resize' && !editing) return
    e.preventDefault()
    e.stopPropagation()
    // 合成事件（探针）带的是假 pointerId，`setPointerCapture` 会抛 —— 拿不到指针捕获
    // 也不影响：move/up 监听挂在网格上，不依赖捕获。
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch { /* 探针环境忽略 */ }
    dragRef.current = {
      id: card.id, mode, startX: e.clientX, startY: e.clientY,
      base: cardsRef.current, origin: card, moved: false,
    }
    // 自动滚动（P4d）：记下起点滚动量与指针位置；循环在"拿起"之后才真的开始跑
    scroll0Ref.current = scrollRef.current?.scrollTop ?? 0
    lastPointer.current = { x: e.clientX, y: e.clientY }
    // 两态两种语义（2026-09-18 实现细化）：
    //   · **阅读态**：按住 350ms 才拿起（手机语义；也避免误触把卡片碰乱），长按即进编辑态；
    //   · **编辑态**：按下即拖（桌面习惯）—— 用户点「编辑布局」本来就是为了排布，
    //     若每拖一次还得先按住 350ms，按钮就白点了。拿起时的缩放/阴影两态一致。
    setGesture({ id: card.id, phase: editing ? 'lifted' : 'pressing', x: 0, y: 0 })
    if (editing) {
      startAutoScroll()
    } else {
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null
        const d = dragRef.current
        if (!d) return
        setGesture((g) => (g && g.id === d.id ? { ...g, phase: nextPhase(g.phase, 'hold') } : g))
        setEditing(true)
        startAutoScroll()
      }, LONG_PRESS_MS)
    }
  }

  /**
   * 手势的唯一计算入口（pointermove 与自动滚动循环**共用**）—— 这是 P4d 的关键：
   * 滚动量一变就要重算一遍，两条路径必须走同一段代码，否则模型与补偿会各算各的。
   *
   * 坐标口径（规格 §5.7）：`D = P + S`（指针位移 + 滚动量），**模型格位与跟手补偿都只喂 D**；
   * 补偿本身用 `liftOffset(P, cellDelta, S)` —— 于是卡片的视口位置恒等于手指位置。
   */
  const applyDrag = (clientX: number, clientY: number, scrollTopOverride?: number) => {
    const d = dragRef.current
    if (!d) return
    lastPointer.current = { x: clientX, y: clientY }
    const physDx = clientX - d.startX
    const physDy = clientY - d.startY
    // 自动滚动那一跳的滚动量由调用方给（那一跳的 scrollTop 还没写进 DOM）；
    // 指针路径则读当前值。
    const scrollDy = scrollTopOverride != null
      ? scrollTopOverride - scroll0Ref.current
      : scrollDelta()
    const D = contentDelta(physDx, physDy, 0, scrollDy)
    // 防抖：还没够得上"拖动"就什么都不做（否则点一下就会挪卡片）
    if (!d.moved && !isDrag(D.x, D.y)) return
    const colW = columnWidthPx(gridRef.current?.clientWidth ?? 0)
    // ⚠️ 传的是**格距**（列宽 + 间隙）：卡片挪一格在屏幕上走的就是格距。
    // 传列宽会让"拖不到半格就跨格"（R37-P4c 探针量出来的 bug）。
    const { dx, dy } = cellsFromPx(D.x, D.y, colW + GRID_GAP, ROW_H + GRID_GAP)

    // 长按还没成立就开始拖 ⇒ 取消这一次手势（把它让给原生滚动/选择）
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
      dragRef.current = null
      setGesture(null)
      stopAutoScroll()
      return
    }

    let next = d.base
    // ⚠️ 判"要不要重算布局"必须拿**目标格位**跟**当前模型格位**比，不能只看"指针有没有跨格线"：
    // 卡片被拖出去一格再拖回来时，指针位移换算回格是 0（= 原点），而模型还停在被拖出去的那一格 ——
    // 只判 `dx||dy` 的话模型不回退，松手时卡片会**凭空跳一格**（R37-P4c 的"归位"断言抓到的）。
    const live = cardsRef.current.find((c) => c.id === d.id) ?? d.origin
    if (d.mode === 'move') {
      const tx = d.origin.x + dx
      const ty = d.origin.y + dy
      const changed = live.x !== tx || live.y !== ty
      if (changed) {
        d.moved = true
        next = moveCard(d.base, d.id, tx, ty)
        applyLayout(next)
      }
      // 跟手位移：卡片视觉位置 = 指针位移 − **它当前所在格子**的位移。
      //
      // ⚠️⚠️ 这里的 `cur` 是这一批最容易写错的一处（2026-09-18 用户报「按住移动时明显闪动、
      // 像是每一点移动都在吸附不同的网格」，就是它）：**没改布局时绝不能用 `d.base` 去取当前格位** ——
      // `d.base` 是手势开始那一刻的快照，卡片早就不在那一格了。用它会得到 `cellDelta = 0`，
      // 于是补偿凭空少一整格：卡片在"正确位置"与"差一格"之间来回跳（跨格那一帧恰好正确，
      // 下一帧就跳走 —— 看着就是闪）。当前格位只有两个来源：
      //   · 这一帧改过布局 ⇒ 用新布局 `next`；
      //   · 没改 ⇒ 用**正在渲染的那一版** `cardsRef.current`（就是 `live`）。
      const cur = changed ? (next.find((c) => c.id === d.id) ?? d.origin) : live
      const cellDx = (cur.x - d.origin.x) * (colW + GRID_GAP)
      const cellDy = (cur.y - d.origin.y) * (ROW_H + GRID_GAP)
      // 补偿 = D − 格子位移（D = 指针位移 + 滚动量）—— 见 `applyDrag` 顶部的坐标口径
      const off = liftOffset(physDx, physDy, cellDx, cellDy, 0, scrollDy)
      setGesture((g) => (g && g.id === d.id && g.phase === 'lifted' ? { ...g, ...off } : g))
      return
    }

    // 缩放（规格 §5.4）：**视觉尺寸 1:1 跟手，模型只在跨格时吸附**。
    // 两者分开是有意的 —— 只在跨格时改模型，才能让"格子"这件事保持离散、可落库；
    // 而视觉上连续，才不会一格一格地跳。
    // ⚠️ 自动滚动时视觉尺寸也要跟着"内容坐标位移"走（`D` 而不是指针位移）：
    // 滚动让内容下探多少，卡片就该长高多少 —— 否则停在底部时手柄会跟内容脱节。
    const spanW = (n: number) => n * colW + (n - 1) * GRID_GAP
    const maxCols = GRID_COLS - d.origin.x
    const minW = spanW(MIN_W)
    const maxW = spanW(maxCols)
    const minH = ROW_H * MIN_H + (MIN_H - 1) * GRID_GAP
    const visW = Math.min(Math.max(spanW(d.origin.w) + D.x, minW), maxW)
    const visH = Math.max(ROW_H * d.origin.h + (d.origin.h - 1) * GRID_GAP + D.y, minH)
    const tw = d.origin.w + dx
    const th = d.origin.h + dy
    if (live.w !== tw || live.h !== th) {
      d.moved = true
      next = resizeCard(d.base, d.id, tw, th)
      applyLayout(next)
    }
    setGesture((g) => (g && g.id === d.id && g.phase === 'lifted'
      ? { ...g, w: Math.round(visW), h: Math.round(visH) }
      : g))
  }

  const onDragMove = (e: React.PointerEvent) => {
    applyDrag(e.clientX, e.clientY)
  }

  const endDrag = () => {
    clearGestureTimers()
    stopAutoScroll()
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    const phase = gesture && gesture.id === d.id ? nextPhase(gesture.phase, 'up') : 'idle'
    if (phase === 'settling') {
      // 落位：撤掉跟手位移（内联 transform 消失 ⇒ CSS 过渡把它滑回格位），
      // 等过渡走完再清相位（清早了卡片会瞬间跳回，就没有"落下"的过程了）
      setGesture((g) => (g && g.id === d.id ? { ...g, phase } : g))
      window.setTimeout(() => {
        setGesture((g) => (g && g.id === d.id ? null : g))
      }, SETTLE_GRACE_MS)
    } else {
      // 短按 / 取消：**立刻**清干净（不留内联过渡，也不留相位）
      setGesture((g) => (g && g.id === d.id ? null : g))
    }
    if (d.moved) void persist(cardsRef.current)
  }

  const resetDefault = () => {
    const layout = buildDefault()
    applyLayout(layout)
    void persist(layout)
  }

  // ── 增删卡片（R37-P3b，规格 §10 的 P3b）────────────────────────────────
  //
  // 本批范围（用户 2026-09-18 拍板）：**只做内置卡片的增删** ——
  // 把已注册、当前不在板上的 kind 加回来，或在编辑态把某张移掉。
  // 自定义内容（文本 / 外链卡 + `config_json`）留到下一批。
  /** 「+ 添加卡片」菜单开着没 */
  const [addOpen, setAddOpen] = useState(false)
  /** 还能加的 kind（已注册 − 已在板上）—— 重复加同一种没有意义，所以不允许 */
  const available = kinds.filter((k) => !(cards ?? []).some((c) => c.kind === k.kind))

  /** 加一张：落点 = 第一个放得下的空位（`firstFreeSlot`），尺寸 = 注册表的默认尺寸 */
  const addKind = (meta: CardKindMeta) => {
    const used = new Set(cardsRef.current.map((c) => c.id))
    let id = meta.kind
    for (let n = 2; used.has(id); n += 1) id = `${meta.kind}-${n}`   // 将来允许重复 kind 时也不撞
    const slot = firstFreeSlot(cardsRef.current, meta.defaultSize)
    const next = [...cardsRef.current, { id, kind: meta.kind, ...slot, ...meta.defaultSize }]
    applyLayout(next)                 // 走同一条路 ⇒ 其余卡片有退避/归位动画
    setAddOpen(false)
    void persist(next)
  }

  /** 移掉一张：**内容不删**（帖/场次/大事记都在库里），随时能加回来，所以不弹确认 */
  const removeAt = (id: string) => {
    const next = removeCard(cardsRef.current, id)
    applyLayout(next)
    void persist(next)
  }

  // ── FLIP 的两步（R37-P4c，规格 §5.2）────────────────────────────────────
  //
  // ⚠️ 必须写在 `useLayoutEffect` 里：它在 DOM 变更之后、**浏览器绘制之前**同步执行，
  // 于是"I（打上补偿位移）"与"A（新布局）"落在同一帧 —— 用户看不到中间态。
  // 若放进 `useEffect`（绘制之后），会先闪一帧新位置再被拉回去（规格 §9.2 的"闪一帧"）。
  useLayoutEffect(() => {
    if (reduced) return
    const el = gridRef.current
    const from = rectsRef.current
    rectsRef.current = {}
    if (!el || !Object.keys(from).length) return
    const next: Record<string, { x: number; y: number; ms: number; settled: boolean }> = {}
    const st = scrollRef.current?.scrollTop ?? 0
    for (const node of el.querySelectorAll<HTMLElement>('.pcard')) {
      const key = node.getAttribute('data-card-key')
      if (!key) continue
      const old = from[key]
      if (!old) continue
      if (dragRef.current?.id === key) continue          // 拖动卡由跟手位移驱动
      const r = node.getBoundingClientRect()             // Last：改完 DOM 的新位置
      const to = { x: r.left, y: r.top + st }            // 内容坐标（与 captureRects 同一坐标系）
      if (!needsFlip(old, to)) continue
      const delta = flipDelta(old, to)
      next[key] = { ...delta, ms: flipDurationMs(delta.y), settled: false }
    }
    if (Object.keys(next).length) setFlips(next)
    // `cards` 是唯一的触发源：布局一变就补一次差
  }, [cards, reduced])

  // I → P：下一帧撤掉补偿位移（同时登记过渡），卡片就从旧位置滑到新位置
  useEffect(() => {
    const ids = Object.keys(flips)
    if (!ids.length) return
    const ms = Math.max(...ids.map((id) => flips[id].ms))
    const timers: number[] = []
    let raf = 0
    if (ids.some((id) => !flips[id].settled)) {
      const play = () => setFlips((prev) => Object.fromEntries(
        Object.entries(prev).map(([k, v]) => [k, { ...v, settled: true }])))
      raf = window.requestAnimationFrame(play)
      // ⚠️ 超时兜底：某些环境**不产帧**（实测 `--force-prefers-reduced-motion` 下
      // `requestAnimationFrame` 永不回调）—— 只靠 rAF 会让卡片永远停在补偿位置上。
      timers.push(window.setTimeout(play, 64))
    }
    // 过渡走完就把条目删掉（别把 transition 常驻在卡片上）。
    // ⚠️ 这个 timer 必须在**每次 flips 变化时都重新排**（第一版在 settled 之后 `return` 了，
    // 于是 cleanup 清掉了上一轮的 timer、新一轮又没排 ⇒ `data-flip` 永远留着 —— 探针抓到的）。
    timers.push(window.setTimeout(() => setFlips({}), ms + 80))
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      for (const t of timers) window.clearTimeout(t)
    }
  }, [flips])

  if (cards === null) {
    return (
      <OverlayScroll className="board-view" scrollRef={scrollRef}>
        <div className="board-head"><span className="board-title">档案视图</span></div>
        <p className="pcard-empty">正在读取卡片布局…</p>
      </OverlayScroll>
    )
  }

  const layout = narrow ? toSingleColumn(cards) : cards
  const account = pickAccount(vtuber)
  const changed = editing && JSON.stringify(cards) !== JSON.stringify(savedRef.current)

  return (
    <OverlayScroll className={`board-view${editing ? ' editing' : ''}`} scrollRef={scrollRef}>
      <div className="board-head">
        <span className="board-title">档案视图</span>
        <span className="board-note">
          {kinds.length} 张卡片 · {narrow ? '窄窗单列' : `${GRID_COLS} 列网格`}
        </span>
        <span className="board-actions">
          {editing ? (
            <>
              {/* 增删卡片（P3b）：菜单列出**已注册但不在板上**的 kind；
                  全都加过了就禁用并说明原因（"点了没反应"是最糟的空态）。 */}
              <span className="board-add">
                <button type="button" className="board-btn" onClick={() => setAddOpen((o) => !o)}
                        disabled={busy || !available.length}
                        title={available.length
                          ? '把还没放上来的卡片加进来'
                          : '已注册的卡片都已在板上（先移除一张，或等新的卡片类型）'}>
                  <Plus size={12} aria-hidden="true" /> 添加卡片
                </button>
                {addOpen && available.length > 0 && (
                  <div className="board-add-pop" role="menu">
                    {available.map((k) => (
                      <button key={k.kind} type="button" className="board-add-item"
                              role="menuitem" data-kind={k.kind} onClick={() => addKind(k)}>
                        <span className="pcard-badge" data-tone={k.tone} aria-hidden="true">
                          <k.icon size={12} strokeWidth={2} />
                        </span>
                        <span className="board-add-title">{k.title}</span>
                        <span className="board-add-size">
                          {k.defaultSize.w}×{k.defaultSize.h}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </span>
              <button type="button" className="board-btn" onClick={resetDefault} disabled={busy}>
                <RotateCcw size={12} aria-hidden="true" /> 重置默认
              </button>
              <button type="button" className="board-btn on" onClick={() => setEditing(false)}
                      disabled={busy}>
                <Check size={12} aria-hidden="true" /> 完成
              </button>
            </>
          ) : (
            <button type="button" className="board-btn" onClick={() => setEditing(true)}
                    disabled={narrow}
                    title={narrow ? '窄窗下先拉宽窗口再排布（单列是自动降级）'
                                  : '拖动卡片换位置、拖右下角改大小'}>
              <SlidersHorizontal size={12} aria-hidden="true" /> 编辑布局
            </button>
          )}
        </span>
      </div>
      {/* ⚠️ 这行提示**必须留在画布下方**（2026-09-18 用户报「按住移动时明显闪动/位移」时量出来的）：
          它原来在画布**上方**，而它只在编辑态出现 —— 长按拾起会顺手进编辑态，于是拾起那一瞬间
          画布被整体推下去 28px（= 行高 16 + gap 12），卡片与邻居一起跳。
          提示放到网格之后，"进编辑态"不再改变网格上方任何东西的尺寸 ⇒ 零位移。
          护栏：`ui_probe.py --motion-cards` 断言拾起前后画布上缘不变。 */}
      <div
        className={`board-grid${narrow ? ' narrow' : ''}${editing ? ' editing' : ''}`}
        ref={gridRef}
        data-board
        data-board-cols={narrow ? 1 : GRID_COLS}
        data-board-narrow={NARROW_PX}
        data-board-editing={editing ? '1' : '0'}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ '--board-row': `${ROW_H}px`, '--board-gap': `${GRID_GAP}px` } as React.CSSProperties}
      >
        {layout.map((card) => {
          const meta = getCardKind(card.kind)
          if (!meta) return null
          const g = gesture && gesture.id === card.id ? gesture : null
          const phase: CardPhase = g?.phase ?? 'idle'
          const dragging = phase === 'lifted' || phase === 'settling'
          const isResize = !!g && dragRef.current?.mode === 'resize'
          const flip = flips[card.id]
          // 手势期间的内联 transform / 过渡：**相位驱动**（跟手时无过渡，落位时有）
          const liftStyle: React.CSSProperties | undefined = g
            ? isResize
              ? (phase === 'lifted' && g.w != null
                  // 缩放：视觉尺寸 1:1 跟手（尺寸动画是规格 §1 约束 2 的**刻意例外**）
                  ? { width: g.w, height: g.h, transition: 'none' }
                  : { transition: `width ${plan.settleMs}ms var(--ease-standard), `
                                + `height ${plan.settleMs}ms var(--ease-standard)` })
              : {
                  transform: phaseTransform(phase, g.x, g.y, plan),
                  transition: phase === 'lifted'
                    ? 'none'
                    : phase === 'settling'
                      ? `transform ${plan.settleMs}ms var(--ease-emphasized)`
                      : `transform var(--motion-instant) var(--ease-standard)`,
                  // 只有拿起来的时候才常驻图层；落定后就撤（留下 `will-change` 是常驻显存开销）
                  willChange: dragging ? 'transform' : undefined,
                  zIndex: dragging ? 5 : undefined,
                }
            : undefined
          // 退避（FLIP）：settled=false 是"打上补偿位移"那一帧，之后交给过渡滑回去
          const flipStyle: React.CSSProperties | undefined = flip
            ? flip.settled
              ? { transition: `transform ${flip.ms}ms var(--ease-standard)` }
              : { transform: `translate(${flip.x}px, ${flip.y}px)`, transition: 'none' }
            : undefined
          return (
            <section
              key={card.id}
              className={`pcard${editing ? ' editing' : ''}${dragging ? ' dragging' : ''}`}
              data-card-kind={card.kind}
              data-card-h={card.h}
              data-card-w={card.w}
              data-card-y={card.y}
              data-card-hpx={cardHeightPx(card)}
              data-card-key={card.id}
              data-card-phase={phase}
              /* 退避动画的证据（探针读它 + 时长）：值就是补偿位移，`P` 阶段仍在（表示"正在滑回去"） */
              data-flip={flip ? `${Math.round(flip.x)},${Math.round(flip.y)}` : undefined}
              data-flip-ms={flip ? flip.ms : undefined}
              /* R37-P4a：注册表下发的**默认行数** —— 探针只在"卡片不低于默认高度"时
                 才要求正文不裁切（用户主动缩小的卡片允许裁掉内容，见规格 §8）。 */
              data-card-min-h={meta.defaultSize.h}
              style={{ ...gridStyle(card), ...flipStyle, ...liftStyle }}
            >
              <header className="pcard-head"
                      onPointerDown={(e) => beginDrag(e, card, 'move')}>
                <span className="pcard-title">{meta.title}</span>
                {editing && <GripVertical className="pcard-grip" size={13} aria-hidden="true" />}
                {/* 移除（P3b，仅编辑态）：**不弹确认** —— 内容都在库里（帖子 / 场次 / 大事记），
                    这里只是把卡片从板上拿下来，随时能加回来。真会丢东西的是下一批的
                    「自定义卡（用户自己写的文本）」，那种删除才需要问一句。 */}
                {editing && (
                  <button type="button" className="pcard-remove"
                          title="把这张卡片移出档案视图（内容不会被删，随时可以加回来）"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => removeAt(card.id)}>
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
                {/* 贴纸角标（规格 §3 的签名元素）：图标 + 色调都来自注册表，
                    视图不认识具体卡片 —— 加一种卡片仍然只改 `cards/index.tsx`。 */}
                <span className="pcard-badge" data-card-badge data-tone={meta.tone}
                      aria-hidden="true">
                  <meta.icon size={13} strokeWidth={2} />
                </span>
              </header>
              <div className="pcard-body">
                {meta.render({ vtuber, account, onOpenPost, refreshTick })}
              </div>
              {editing && (
                <span className="pcard-resize" title="拖动改大小"
                      onPointerDown={(e) => beginDrag(e, card, 'resize')} />
              )}
            </section>
          )
        })}
        {!layout.length && <p className="pcard-empty">还没有注册任何卡片</p>}
      </div>
      {/* 编辑态的操作提示：放**网格之后**（见上面的说明 —— 放前面会在拾起那一刻把画布推下去） */}
      {editing && (
        <p className="board-hint">
          拖动卡片可换位置、拖右下角可改大小；撞到别人会把它挤下去。{' '}
          {changed ? '（保存中…）' : '每次松手即保存'}
        </p>
      )}
      {/* 动效调测页（R37-P4b）：只在 `?motion=cards` 时**动态**载入 —— 与 `main.tsx` 载探针
          同一路数（生产构建里 `import.meta.env.DEV` 为 false，整段被摇掉）。 */}
      {Lab && <Lab gridRef={gridRef} />}
    </OverlayScroll>
  )
}
