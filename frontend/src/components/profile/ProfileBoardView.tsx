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
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, GripVertical, RotateCcw, SlidersHorizontal } from 'lucide-react'

import { api } from '../../api/api'
import type { Post, ProfileCardRow, VTuber } from '../../api/types'
import { pill } from '../../utils/pill'
import OverlayScroll from '../OverlayScroll'
import { getCardKind, listCardKinds } from './cardRegistry'
import {
  GRID_COLS, GRID_GAP, ROW_H, NARROW_PX, cardHeightPx, cellsFromPx, columnWidthPx,
  defaultLayout, gridStyle, isNarrow, moveCard, resizeCard, toSingleColumn,
  type CardLayout,
} from './layoutModel'
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

  // ── 指针拖拽 / 缩放（手势 → 格子位移 → 纯函数算新布局）──────────────
  const dragRef = useRef<{
    id: string
    mode: 'move' | 'resize'
    startX: number
    startY: number
    base: CardLayout[]
    origin: CardLayout
    moved: boolean
  } | null>(null)

  const beginDrag = (e: React.PointerEvent, card: CardLayout, mode: 'move' | 'resize') => {
    if (!editing || narrow || busy) return
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
  }

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const colW = columnWidthPx(gridRef.current?.clientWidth ?? 0)
    const { dx, dy } = cellsFromPx(e.clientX - d.startX, e.clientY - d.startY,
                                   colW, ROW_H + GRID_GAP)
    if (!dx && !dy) return                       // 没跨格就不重算（避免每像素一次 setState）
    d.moved = true
    setCards(d.mode === 'move'
      ? moveCard(d.base, d.id, d.origin.x + dx, d.origin.y + dy)
      : resizeCard(d.base, d.id, d.origin.w + dx, d.origin.h + dy))
  }

  const endDrag = () => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.moved) void persist(cardsRef.current)
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
          const dragging = dragRef.current?.id === card.id && dragRef.current.moved
          return (
            <section
              key={card.id}
              className={`pcard${editing ? ' editing' : ''}${dragging ? ' dragging' : ''}`}
              data-card-kind={card.kind}
              data-card-h={card.h}
              data-card-hpx={cardHeightPx(card)}
              data-card-key={card.id}
              style={gridStyle(card)}
            >
              <header className="pcard-head"
                      onPointerDown={(e) => beginDrag(e, card, 'move')}>
                <span className="pcard-title">{meta.title}</span>
                {editing && <GripVertical className="pcard-grip" size={13} aria-hidden="true" />}
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
    </OverlayScroll>
  )
}
