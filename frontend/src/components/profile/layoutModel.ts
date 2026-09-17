/**
 * 档案视图的卡片网格几何（R37-P1，devlog/141）—— **纯函数，可单测**。
 *
 * 用户口径（2026-09-17）：「我们把它称作**档案视图**……以卡片为基本单位，用户可以编辑
 * 卡片的大小、位置、排布，卡片内容由用户自定义，例如有纪念日、优质投稿、大事记、
 * 时间线等等，然后支持拓展和自定义」。
 *
 * 同日拍板的四个选型：**自研**网格（不用 `react-grid-layout`）· 布局存**新表
 * `profile_cards`**（P2 落，P1 先只读）· 碰撞**推开** · 编辑/阅读态**分离** ·
 * 窄窗**降级单列**。
 *
 * ## 为什么先写纯函数
 *
 * 本仓 vitest 跑在 **node 环境**（无 jsdom / 无 testing-library）⇒ 拖拽与缩放本身测不了；
 * 但"落点算得对不对、会不会重叠、窄窗怎么排"全是**几何判断**，必须能被穷举断言。
 * 组件只负责把算好的 `x/y/w/h` 画成 CSS Grid 的 `grid-column/grid-row`（`gridStyle`）。
 */
export const GRID_COLS = 12
/** 单行高度（px）：卡片高 = h × ROW_H + (h-1) × GRID_GAP（探针按这个式子核对实渲染） */
export const ROW_H = 84
export const GRID_GAP = 12
/**
 * 窄窗阈值（**容器**宽度，不是窗口宽度）：低于它降级单列。
 *
 * 560 是量出来的：探针三档窗口下网格容器的实宽是 **1100→498 · 1280→678 · 1440→838**
 * （面板要减掉图标栏 50 与左栏）。默认布局是 5+7 两张卡，窄的那张占 5/12 ≈ 0.42×W，
 * 要留住 ~220px 的可读宽度就需要 W ≥ ~530 —— 取 560 留一点余量。
 * ⇒ 1100 档单列、1280/1440 档 12 列，探针两分支都真的走到（这条跨宽度不变量由
 * `scripts/ui_probe.py::_assert_board` 守，阈值本身经 `data-board-narrow` 下发给探针，
 * 免得 TS 与 Python 各写一份数字漂掉）。
 */
export const NARROW_PX = 560

export interface CardSize {
  w: number
  h: number
}

export interface CardLayout {
  /** 稳定 id（P2 起落库；P1 用 kind 当 id） */
  id: string
  kind: string
  /** 列起点 0..GRID_COLS-1 */
  x: number
  /** 行起点 0..∞ */
  y: number
  /** 列宽 1..GRID_COLS */
  w: number
  /** 行高（行数） */
  h: number
}

/** 把一张卡夹回合法范围（拖拽/缩放/落库脏数据共用；P1 用于兜底默认布局）。 */
export function clampCard(card: CardLayout): CardLayout {
  const w = Math.min(GRID_COLS, Math.max(1, Math.round(card.w)))
  const h = Math.max(1, Math.round(card.h))
  const x = Math.min(GRID_COLS - w, Math.max(0, Math.round(card.x)))
  const y = Math.max(0, Math.round(card.y))
  return { ...card, x, y, w, h }
}

/** 两块矩形是否相交（同网格坐标；`h` 以行数计）。 */
export function cardsOverlap(a: CardLayout, b: CardLayout): boolean {
  if (a.id === b.id) return false
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** 找出所有相交对（探针与单测共用：只读布局**不许重叠**）。 */
export function findOverlaps(cards: CardLayout[]): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      if (cardsOverlap(cards[i], cards[j])) out.push([cards[i].id, cards[j].id])
    }
  }
  return out
}

/**
 * 默认布局：按注册顺序**从左到右填行**，填不下就换行（"书架"式，零重叠）。
 *
 * 为什么不用"每张卡占一整行"：档案视图一屏要放下 2~4 张卡才谈得上"一眼看全"；
 * 卡片自带 `defaultSize`，横向拼满 12 列再换行即可。P2 的拖拽/推开都从这里出发。
 */
export function defaultLayout(kinds: { kind: string; defaultSize: CardSize }[]): CardLayout[] {
  const out: CardLayout[] = []
  let x = 0
  let y = 0
  let rowH = 0
  for (const { kind, defaultSize } of kinds) {
    const w = Math.min(GRID_COLS, Math.max(1, Math.round(defaultSize.w)))
    const h = Math.max(1, Math.round(defaultSize.h))
    if (x + w > GRID_COLS) {      // 本行放不下 → 换行
      x = 0
      y += rowH
      rowH = 0
    }
    out.push({ id: kind, kind, x, y, w, h })
    x += w
    rowH = Math.max(rowH, h)
  }
  return out
}

/**
 * 归一化：去重（同 id 只留第一张）→ 夹范围 → 按 (y, x) 排序 → **向下推开**消重叠。
 *
 * 推开的方向选**向下**（不是向右）：网格是"从上往下读"的，被推开的卡往下一行更符合
 * 直觉，也不会把同一行的邻居挤出 12 列。P2 的拖拽碰撞复用同一个函数（口径一致）。
 */
export function normalizeLayout(cards: CardLayout[]): CardLayout[] {
  const seen = new Set<string>()
  const uniq: CardLayout[] = []
  for (const c of cards) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    uniq.push(clampCard(c))
  }
  uniq.sort((a, b) => (a.y - b.y) || (a.x - b.x))
  const out: CardLayout[] = []
  for (const card of uniq) {
    let placed = { ...card }
    let guard = 0
    while (out.some((o) => cardsOverlap(o, placed)) && guard < 200) {
      placed = { ...placed, y: placed.y + 1 }
      guard += 1
    }
    out.push(placed)
  }
  return out
}

/** 窄窗降级：按 (y, x) 顺序**单列堆叠**（宽拉满、行高保留各自 h）——用户口径里的第三项。 */
export function toSingleColumn(cards: CardLayout[]): CardLayout[] {
  const sorted = [...cards].sort((a, b) => (a.y - b.y) || (a.x - b.x))
  let y = 0
  return sorted.map((c) => {
    const out: CardLayout = { ...c, x: 0, w: GRID_COLS, y }
    y += c.h
    return out
  })
}

export function isNarrow(containerWidth: number): boolean {
  return containerWidth > 0 && containerWidth < NARROW_PX
}

/** 卡片 → CSS Grid 内联样式（1-based；span 用 `h` 行）。 */
export function gridStyle(card: CardLayout): {
  gridColumn: string
  gridRow: string
} {
  return {
    gridColumn: `${card.x + 1} / span ${card.w}`,
    gridRow: `${card.y + 1} / span ${card.h}`,
  }
}

/** 卡片应有的像素高（探针按它核对实渲染 —— 高度写错时卡片会互相压住）。 */
export function cardHeightPx(card: CardLayout): number {
  return card.h * ROW_H + (card.h - 1) * GRID_GAP
}

/** 卡片最小尺寸：再小就放不下标题 + 一行内容（拖到极限时由 `clampCard` 兜住）。 */
export const MIN_W = 3
export const MIN_H = 2

/**
 * 消重叠：`fixedId` 那张**不动**，其余按 (y, x) 顺序**向下推开**直到不再相交。
 *
 * 这就是四个选型里的「碰撞**推开**」（而不是"拒绝移动"）：拖到别人身上时把别人挤下去，
 * 而不是让被拖的卡弹回原位 —— 后者会让人反复试、还以为是自己没拖准。
 * `normalizeLayout` 也在用它（口径只此一份）。
 */
export function pushDown(cards: CardLayout[], fixedId?: string): CardLayout[] {
  const fixed = cards.find((c) => c.id === fixedId)
  const rest = cards
    .filter((c) => c.id !== fixedId)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
  const out: CardLayout[] = fixed ? [fixed] : []
  for (const card of rest) {
    let placed = { ...card }
    let guard = 0
    while (out.some((o) => cardsOverlap(o, placed)) && guard < 200) {
      placed = { ...placed, y: placed.y + 1 }
      guard += 1
    }
    out.push(placed)
  }
  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x))
}

/** 拖拽：把 `id` 那张移到 `(x, y)`（夹范围），其余被压住的**向下推开**。 */
export function moveCard(cards: CardLayout[], id: string, x: number, y: number): CardLayout[] {
  const next = cards.map((c) => (c.id === id ? clampCard({ ...c, x, y }) : c))
  return pushDown(next, id)
}

/** 缩放：把 `id` 那张改成 `(w, h)`，其余被压住的向下推开。
 *
 * ⚠️ 宽度上限是**右侧剩余空间**（`12 - x`）而不是 12：靠 `clampCard` 夹的话，
 * 宽先被放到 12、`x` 再被拉回 0 ⇒ 卡片会**整张左移**（用户拖右下角手柄，
 * 卡片却跳到左边）—— 这是实测抓到的第一版 bug（用例 `上限：宽不超 12…` 抓到）。
 */
export function resizeCard(cards: CardLayout[], id: string, w: number, h: number): CardLayout[] {
  const next = cards.map((c) => (c.id === id
    ? clampCard({
        ...c,
        w: Math.min(GRID_COLS - c.x, Math.max(MIN_W, w)),
        h: Math.max(MIN_H, h),
      })
    : c))
  return pushDown(next, id)
}

/** 像素位移 → 格子位移（拖拽手势层用；四舍五入到最近的格）。 */
export function cellsFromPx(dxPx: number, dyPx: number,
                            colWidth: number, rowHeight: number): { dx: number; dy: number } {
  return {
    dx: Math.round(dxPx / Math.max(1, colWidth)),
    dy: Math.round(dyPx / Math.max(1, rowHeight)),
  }
}

/** 网格单列宽（手势层把像素换算成格时要用）：`(容器宽 - 11×gap) / 12`。 */
export function columnWidthPx(gridWidth: number): number {
  return (gridWidth - (GRID_COLS - 1) * GRID_GAP) / GRID_COLS
}