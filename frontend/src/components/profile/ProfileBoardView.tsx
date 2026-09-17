/**
 * 档案视图（R37-P1，devlog/141）—— 卡片画布，取代原来的「档案卡改版中」占位。
 *
 * 用户口径（2026-09-17）：「我们把它称作**档案视图**……以卡片为基本单位，用户可以编辑
 * 卡片的大小、位置、排布，卡片内容由用户自定义（纪念日、优质投稿、大事记、时间线…），
 * 然后支持拓展和自定义」。
 *
 * ## 本批（P1）做到哪一步
 *
 * ✅ 命名（档案卡 → 档案视图 / 档案 → 数据视图）· ✅ 只读网格 + 卡片注册表 ·
 * ✅ 两种内置卡片（纪念日 / 优质投稿）。
 * ⛔ 拖拽缩放与落库（P2，表 `profile_cards`）· ⛔ 自定义卡片与扩展点（P3）。
 * 所以本批**没有**编辑态：布局来自 `defaultLayout(注册表)`，窄窗降级单列。
 *
 * ## 三条与其它视图一致的纪律
 *
 * 1. **数据由卡片自己取**（每张卡的数据源不同，页面不该认识卡片需要什么）；
 * 2. **高度由网格算**（`ROW_H × h + GAP × (h-1)`，探针按这个式子核对实渲染）；
 * 3. **窄窗降级看容器宽而不是窗口宽**（面板还要减掉图标栏与左栏）——
 *    用 `ResizeObserver` 量网格自己的宽度。
 */
import { useEffect, useRef, useState } from 'react'

import type { Post, VTuber } from '../../api/types'
import OverlayScroll from '../OverlayScroll'
import { getCardKind, listCardKinds } from './cardRegistry'
import {
  GRID_COLS, ROW_H, GRID_GAP, NARROW_PX, cardHeightPx, defaultLayout, gridStyle,
  isNarrow, toSingleColumn, type CardLayout,
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

export default function ProfileBoardView({ vtuber, refreshTick, onOpenPost }: Props) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  // 容器宽 → 单列降级。首帧 `width=0` 时**不**降级（`isNarrow(0) === false`），
  // 否则宽屏打开档案页会先闪一下单列。
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const kinds = listCardKinds()
  // 布局每次渲染重算：注册表随包固定、循环只有几行，比 memo（依赖一个每次新建的数组）
  // 更简单也更不容易出"memo 依赖写错导致不更新"的错。
  const base = defaultLayout(
    kinds.map((k) => ({ kind: k.kind, defaultSize: k.defaultSize })),
  )
  const narrow = isNarrow(width)
  const layout: CardLayout[] = narrow ? toSingleColumn(base) : base
  const account = pickAccount(vtuber)

  return (
    <OverlayScroll className="board-view">
      <div className="board-head">
        <span className="board-title">档案视图</span>
        <span className="board-note">
          {kinds.length} 张卡片 · {narrow ? '窄窗单列' : `${GRID_COLS} 列网格`}
        </span>
      </div>
      <div
        className={`board-grid${narrow ? ' narrow' : ''}`}
        ref={gridRef}
        data-board
        data-board-cols={narrow ? 1 : GRID_COLS}
        data-board-narrow={NARROW_PX}
        style={{ '--board-row': `${ROW_H}px`, '--board-gap': `${GRID_GAP}px` } as React.CSSProperties}
      >
        {layout.map((card) => {
          const meta = getCardKind(card.kind)
          if (!meta) return null
          return (
            <section
              key={card.id}
              className="pcard"
              data-card-kind={card.kind}
              data-card-h={card.h}
              data-card-hpx={cardHeightPx(card)}
              style={gridStyle(card)}
            >
              <header className="pcard-head">
                <span className="pcard-title">{meta.title}</span>
              </header>
              <div className="pcard-body">
                {meta.render({ vtuber, account, onOpenPost, refreshTick })}
              </div>
            </section>
          )
        })}
        {!layout.length && <p className="pcard-empty">还没有注册任何卡片</p>}
      </div>
    </OverlayScroll>
  )
}