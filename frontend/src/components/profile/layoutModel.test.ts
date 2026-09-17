import { describe, expect, it } from 'vitest'

import {
  GRID_COLS, GRID_GAP, MIN_H, MIN_W, NARROW_PX, ROW_H, cardHeightPx, cardsOverlap,
  cellsFromPx, clampCard, columnWidthPx, defaultLayout, findOverlaps, gridStyle, isNarrow,
  moveCard, normalizeLayout, pushDown, resizeCard, toSingleColumn,
  type CardLayout,
} from './layoutModel'

/**
 * 档案视图的网格几何（R37-P1，devlog/141）。
 *
 * 这一层是"自研网格"的**全部判断**：落点、夹范围、消重叠、窄窗单列、CSS 映射。
 * 拖拽与缩放的**手势**（P2）测不了（node 环境无 DOM），但它们最终都要经过这里的函数 ——
 * 所以把口径钉在这里，P2 的手势层只负责"把指针位置翻译成 x/y/w/h"。
 */

const mk = (over: Partial<CardLayout> = {}): CardLayout =>
  ({ id: 'a', kind: 'a', x: 0, y: 0, w: 4, h: 3, ...over })

describe('clampCard — 夹回合法范围', () => {
  it('宽高有下限（1 列 / 1 行）且宽不超 12 列', () => {
    expect(clampCard(mk({ w: 0, h: 0 })).w).toBe(1)
    expect(clampCard(mk({ w: 0, h: 0 })).h).toBe(1)
    expect(clampCard(mk({ w: 99 })).w).toBe(GRID_COLS)
  })

  it('x 被夹到「放得下」的位置（宽 4 的卡最右只能到第 8 列）', () => {
    expect(clampCard(mk({ x: 11, w: 4 })).x).toBe(GRID_COLS - 4)
    expect(clampCard(mk({ x: -3 })).x).toBe(0)
  })

  it('y 不为负、小数被四舍五入（拖拽半格不该落库成小数）', () => {
    expect(clampCard(mk({ y: -1 })).y).toBe(0)
    expect(clampCard(mk({ x: 2.4, y: 3.6 })).x).toBe(2)
    expect(clampCard(mk({ x: 2.4, y: 3.6 })).y).toBe(4)
  })
})

describe('cardsOverlap / findOverlaps — 只读布局不许重叠', () => {
  it('相邻不算相交（边界相接 = 合法）', () => {
    expect(cardsOverlap(mk({ x: 0, w: 4 }), mk({ id: 'b', x: 4, w: 4 }))).toBe(false)
    expect(cardsOverlap(mk({ y: 0, h: 3 }), mk({ id: 'b', y: 3, h: 3 }))).toBe(false)
  })

  it('同 id 永不判相交（自己和自己不算）', () => {
    expect(cardsOverlap(mk(), mk())).toBe(false)
  })

  it('找出所有相交对', () => {
    const cards = [
      mk({ id: 'a', x: 0, y: 0, w: 6, h: 3 }),
      mk({ id: 'b', x: 3, y: 1, w: 6, h: 3 }),
      mk({ id: 'c', x: 6, y: 4, w: 6, h: 3 }),
    ]
    expect(findOverlaps(cards)).toEqual([['a', 'b']])
  })
})

describe('defaultLayout — 书架式默认排布', () => {
  const kinds = [
    { kind: 'anniversary', defaultSize: { w: 5, h: 3 } },
    { kind: 'top-posts', defaultSize: { w: 7, h: 3 } },
    { kind: 'timeline', defaultSize: { w: 6, h: 4 } },
  ]

  it('先横向拼满 12 列再换行', () => {
    const out = defaultLayout(kinds)
    expect(out.map((c) => [c.x, c.y, c.w])).toEqual([
      [0, 0, 5], [5, 0, 7], [0, 3, 6],
    ])
  })

  it('零重叠、全部落在 12 列内', () => {
    const out = defaultLayout(kinds)
    expect(findOverlaps(out)).toEqual([])
    expect(out.every((c) => c.x + c.w <= GRID_COLS)).toBe(true)
  })

  it('换行的 y 用**本行最高**的卡（矮卡不浪费下一行的空间）', () => {
    const out = defaultLayout([
      { kind: 'a', defaultSize: { w: 6, h: 2 } },
      { kind: 'b', defaultSize: { w: 6, h: 5 } },
      { kind: 'c', defaultSize: { w: 4, h: 2 } },
    ])
    expect(out[2].y).toBe(5)          // 不是 2
  })

  it('空注册表 → 空布局（视图里表现为"还没有卡片"而不是崩）', () => {
    expect(defaultLayout([])).toEqual([])
  })
})

describe('normalizeLayout — 脏数据兜底', () => {
  it('同 id 去重（只留第一张）', () => {
    const out = normalizeLayout([mk({ id: 'x', y: 0 }), mk({ id: 'x', y: 5 })])
    expect(out).toHaveLength(1)
    expect(out[0].y).toBe(0)
  })

  it('重叠时把后来的**向下推开**直到不重叠', () => {
    const out = normalizeLayout([
      mk({ id: 'a', x: 0, y: 0, w: 6, h: 3 }),
      mk({ id: 'b', x: 0, y: 0, w: 6, h: 2 }),
    ])
    expect(findOverlaps(out)).toEqual([])
    expect(out.find((c) => c.id === 'b')?.y).toBe(3)
  })

  it('输出按 (y, x) 排序（渲染顺序 = 阅读顺序）', () => {
    const out = normalizeLayout([
      mk({ id: 'b', x: 6, y: 4 }), mk({ id: 'a', x: 0, y: 0 }), mk({ id: 'c', x: 6, y: 0 }),
    ])
    expect(out.map((c) => c.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('窄窗降级 — 单列堆叠', () => {
  it('阈值以**容器宽**判定（窗口宽不是判据：面板还要减掉图标栏与左栏）', () => {
    expect(isNarrow(NARROW_PX - 1)).toBe(true)
    expect(isNarrow(NARROW_PX)).toBe(false)
    expect(isNarrow(0)).toBe(false)        // 还没量到宽度时不降级（避免首帧闪一下单列）
  })

  it('单列：宽拉满 12、x=0、按阅读顺序纵向堆叠', () => {
    const cards = [
      mk({ id: 'a', x: 0, y: 0, w: 5, h: 3 }),
      mk({ id: 'b', x: 5, y: 0, w: 7, h: 3 }),
      mk({ id: 'c', x: 0, y: 3, w: 6, h: 4 }),
    ]
    const out = toSingleColumn(cards)
    expect(out.map((c) => [c.x, c.w, c.y])).toEqual([[0, 12, 0], [0, 12, 3], [0, 12, 6]])
    expect(findOverlaps(out)).toEqual([])
  })
})

describe('gridStyle / cardHeightPx — 与 CSS 的契约', () => {
  it('CSS Grid 是 1-based，span 用行数', () => {
    expect(gridStyle(mk({ x: 4, y: 2, w: 7, h: 3 }))).toEqual({
      gridColumn: '5 / span 7', gridRow: '3 / span 3',
    })
  })

  it('像素高 = h×ROW_H + (h-1)×GAP（探针按这个式子核对实渲染）', () => {
    expect(cardHeightPx(mk({ h: 1 }))).toBe(ROW_H)
    expect(cardHeightPx(mk({ h: 3 }))).toBe(3 * ROW_H + 2 * GRID_GAP)
  })
})

// ── R37-P2b：拖拽 / 缩放（四个选型里的「碰撞推开」） ──────────────────

describe('moveCard — 拖拽，被压住的向下推开', () => {
  const two = () => [
    mk({ id: 'a', x: 0, y: 0, w: 6, h: 3 }),
    mk({ id: 'b', x: 6, y: 0, w: 6, h: 3 }),
  ]

  it('拖到空位就是平移（别人不动）', () => {
    const out = moveCard(two(), 'a', 0, 5)
    expect(out.find((c) => c.id === 'a')?.y).toBe(5)
    expect(out.find((c) => c.id === 'b')?.y).toBe(0)
  })

  it('拖到别人身上 → **推开**（被压的往下让，不弹回原位）', () => {
    const out = moveCard(two(), 'a', 6, 0)     // a 移到 b 的位置
    expect(findOverlaps(out)).toEqual([])
    expect(out.find((c) => c.id === 'a')?.y).toBe(0)     // 被拖的那张留在原地（位置优先）
    expect(out.find((c) => c.id === 'b')?.y).toBe(3)     // b 被推到下一行
  })

  it('拖出右边界 → 夹回（x 最大 = 12 - w）', () => {
    expect(moveCard(two(), 'a', 99, 0).find((c) => c.id === 'a')?.x).toBe(6)
  })

  it('拖出上边界 → y = 0', () => {
    expect(moveCard(two(), 'a', 0, -5).find((c) => c.id === 'a')?.y).toBe(0)
  })

  it('结果零重叠、幂等（再推一次不会再动）', () => {
    const once = moveCard(two(), 'a', 6, 0)
    expect(findOverlaps(once)).toEqual([])
    expect(pushDown(once)).toEqual(once)
  })

  it('三张卡连推：被拖的那张往下压时，下方的依次让位（上面的不动）', () => {
    const cards = [
      mk({ id: 'a', x: 0, y: 0, w: 12, h: 2 }),
      mk({ id: 'b', x: 0, y: 2, w: 12, h: 2 }),
      mk({ id: 'c', x: 0, y: 4, w: 12, h: 2 }),
    ]
    // 把 a 拖到 c 的位置：c 被推到 a 下面；b 在 a 上方，不受影响
    const out = moveCard(cards, 'a', 0, 4)
    expect(findOverlaps(out)).toEqual([])
    const pos = Object.fromEntries(out.map((c) => [c.id, c.y]))
    expect(pos['a']).toBe(4)
    expect(pos['b']).toBe(2)
    expect(pos['c']).toBeGreaterThanOrEqual(6)
  })
})

describe('resizeCard — 缩放，同样推开', () => {
  it('加宽撞到邻居 → 邻居下移', () => {
    const cards = [
      mk({ id: 'a', x: 0, y: 0, w: 4, h: 3 }),
      mk({ id: 'b', x: 4, y: 0, w: 4, h: 3 }),
    ]
    const out = resizeCard(cards, 'a', 8, 3)
    expect(out.find((c) => c.id === 'a')?.w).toBe(8)
    expect(out.find((c) => c.id === 'b')?.y).toBe(3)
    expect(findOverlaps(out)).toEqual([])
  })

  it('下限 MIN_W / MIN_H（拖到极小也不会消失）', () => {
    const out = resizeCard([mk({ id: 'a', x: 0, y: 0, w: 6, h: 3 })], 'a', 0, 0)
    expect(out[0].w).toBe(MIN_W)
    expect(out[0].h).toBe(MIN_H)
  })

  it('上限：宽不超 12、x+w 仍被夹在网格内', () => {
    const out = resizeCard([mk({ id: 'a', x: 8, y: 0, w: 4, h: 3 })], 'a', 12, 3)
    expect(out[0].w).toBe(4)
    expect(out[0].x + out[0].w).toBeLessThanOrEqual(GRID_COLS)
  })

  it('加高撞到下面那张 → 那张下移', () => {
    const cards = [
      mk({ id: 'a', x: 0, y: 0, w: 6, h: 2 }),
      mk({ id: 'b', x: 0, y: 2, w: 6, h: 2 }),
    ]
    const out = resizeCard(cards, 'a', 6, 4)
    expect(out.find((c) => c.id === 'a')?.h).toBe(4)
    expect(out.find((c) => c.id === 'b')?.y).toBe(4)
  })
})

describe('cellsFromPx / columnWidthPx — 手势层的像素→格换算', () => {
  it('列宽 = (容器宽 - 11×gap) / 12', () => {
    expect(columnWidthPx(12 * 100 + 11 * GRID_GAP)).toBe(100)
  })

  it('位移四舍五入到最近的格（拖半格不动、拖过大半格算一格）', () => {
    expect(cellsFromPx(40, 0, 100, 96)).toEqual({ dx: 0, dy: 0 })
    expect(cellsFromPx(60, 96, 100, 96)).toEqual({ dx: 1, dy: 1 })
    expect(cellsFromPx(-60, -96, 100, 96)).toEqual({ dx: -1, dy: -1 })
  })

  it('列宽为 0（还没量到容器宽）时不除零', () => {
    expect(cellsFromPx(300, 300, 0, 0)).toEqual({ dx: 300, dy: 300 })
  })
})