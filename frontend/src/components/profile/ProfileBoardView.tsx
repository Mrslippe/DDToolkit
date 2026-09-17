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
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { Check, GripVertical, RotateCcw, SlidersHorizontal } from 'lucide-react'

import { api } from '../../api/api'
import type { Post, ProfileCardRow, VTuber } from '../../api/types'
import usePrefersReducedMotion from '../../hooks/usePrefersReducedMotion'
import { pill } from '../../utils/pill'
import OverlayScroll from '../OverlayScroll'
import { getCardKind, listCardKinds } from './cardRegistry'
import {
  GRID_COLS, GRID_GAP, ROW_H, NARROW_PX, cardHeightPx, cellsFromPx, columnWidthPx,
  defaultLayout, gridStyle, isNarrow, moveCard, resizeCard, toSingleColumn,
  type CardLayout,
} from './layoutModel'
import {
  LONG_PRESS_MS, SETTLE_GRACE_MS, type CardPhase, isDrag, liftOffset, motionPlan, nextPhase,
  phaseTransform,
} from './motion'
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

  /** 手势的**可见**部分（相位 + 跟手位移）—— 这个进 state，因为要画出来 */
  const [gesture, setGesture] = useState<
    { id: string; phase: CardPhase; x: number; y: number } | null
  >(null)
  const pressTimer = useRef<number | null>(null)

  const reduced = usePrefersReducedMotion()
  const plan = motionPlan(reduced)

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
    // 两态两种语义（2026-09-18 实现细化）：
    //   · **阅读态**：按住 350ms 才拿起（手机语义；也避免误触把卡片碰乱），长按即进编辑态；
    //   · **编辑态**：按下即拖（桌面习惯）—— 用户点「编辑布局」本来就是为了排布，
    //     若每拖一次还得先按住 350ms，按钮就白点了。拿起时的缩放/阴影两态一致。
    setGesture({ id: card.id, phase: editing ? 'lifted' : 'pressing', x: 0, y: 0 })
    if (!editing) {
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null
        const d = dragRef.current
        if (!d) return
        setGesture((g) => (g && g.id === d.id ? { ...g, phase: nextPhase(g.phase, 'hold') } : g))
        setEditing(true)
      }, LONG_PRESS_MS)
    }
  }

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dxPx = e.clientX - d.startX
    const dyPx = e.clientY - d.startY
    // 防抖：还没够得上"拖动"就什么都不做（否则点一下就会挪卡片）
    if (!d.moved && !isDrag(dxPx, dyPx)) return
    const colW = columnWidthPx(gridRef.current?.clientWidth ?? 0)
    const { dx, dy } = cellsFromPx(dxPx, dyPx, colW, ROW_H + GRID_GAP)

    // 长按还没成立就开始拖 ⇒ 取消这一次手势（把它让给原生滚动/选择）
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
      dragRef.current = null
      setGesture(null)
      return
    }

    let next = d.base
    if (dx || dy) {                              // 没跨格就不重算布局
      d.moved = true
      next = d.mode === 'move'
        ? moveCard(d.base, d.id, d.origin.x + dx, d.origin.y + dy)
        : resizeCard(d.base, d.id, d.origin.w + dx, d.origin.h + dy)
      setCards(next)
    }

    // 跟手位移（只对"移动"）：卡片视觉位置 = 指针位移 − 它所在格子的位移。
    // 格子位移**用模型算**（不读 DOM）：拖动期间读 rect 会强制重排，而且拿到的还可能是
    // 上一帧的位置。
    //
    // ⚠️ 这里**刻意不做 rAF 节流**（第一版做了，被探针逼回来）：pointermove 本来就是
    // 每帧一两次，React 自己会把同一批事件的状态更新合掉；再加一层 rAF 只会让"跟手位移
    // 落在下一帧"，而**探针在多远的将来读到它就成了竞态**（实测默认档绿、reduced 档红，
    // 差别只是那一帧有没有被服务）。手感相关的东西不该有竞态。
    const cur = next.find((c) => c.id === d.id) ?? d.origin
    const cellDx = (cur.x - d.origin.x) * (colW + GRID_GAP)
    const cellDy = (cur.y - d.origin.y) * (ROW_H + GRID_GAP)
    const off = liftOffset(dxPx, dyPx, cellDx, cellDy)
    setGesture((g) => (g && g.id === d.id && g.phase === 'lifted' ? { ...g, ...off } : g))
  }

  const endDrag = () => {
    clearGestureTimers()
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
    setCards(layout)
    void persist(layout)
  }

  if (cards === null) {
    return (
      <OverlayScroll className="board-view">
        <div className="board-head"><span className="board-title">档案视图</span></div>
        <p className="pcard-empty">正在读取卡片布局…</p>
      </OverlayScroll>
    )
  }

  const layout = narrow ? toSingleColumn(cards) : cards
  const account = pickAccount(vtuber)
  const changed = editing && JSON.stringify(cards) !== JSON.stringify(savedRef.current)

  return (
    <OverlayScroll className="board-view">
      <div className="board-head">
        <span className="board-title">档案视图</span>
        <span className="board-note">
          {kinds.length} 张卡片 · {narrow ? '窄窗单列' : `${GRID_COLS} 列网格`}
        </span>
        <span className="board-actions">
          {editing ? (
            <>
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
      {editing && (
        <p className="board-hint">
          拖动卡片可换位置、拖右下角可改大小；撞到别人会把它挤下去。{' '}
          {changed ? '（保存中…）' : '每次松手即保存'}
        </p>
      )}
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
          // 手势期间的内联 transform / 过渡：**相位驱动**（跟手时无过渡，落位时有）
          const liftStyle: React.CSSProperties | undefined = g
            ? {
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
          return (
            <section
              key={card.id}
              className={`pcard${editing ? ' editing' : ''}${dragging ? ' dragging' : ''}`}
              data-card-kind={card.kind}
              data-card-h={card.h}
              data-card-hpx={cardHeightPx(card)}
              data-card-key={card.id}
              data-card-phase={phase}
              /* R37-P4a：注册表下发的**默认行数** —— 探针只在"卡片不低于默认高度"时
                 才要求正文不裁切（用户主动缩小的卡片允许裁掉内容，见规格 §8）。 */
              data-card-min-h={meta.defaultSize.h}
              style={{ ...gridStyle(card), ...liftStyle }}
            >
              <header className="pcard-head"
                      onPointerDown={(e) => beginDrag(e, card, 'move')}>
                <span className="pcard-title">{meta.title}</span>
                {editing && <GripVertical className="pcard-grip" size={13} aria-hidden="true" />}
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
      {/* 动效调测页（R37-P4b）：只在 `?motion=cards` 时**动态**载入 —— 与 `main.tsx` 载探针
          同一路数（生产构建里 `import.meta.env.DEV` 为 false，整段被摇掉）。 */}
      {Lab && <Lab gridRef={gridRef} />}
    </OverlayScroll>
  )
}
