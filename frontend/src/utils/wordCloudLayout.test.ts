import { describe, expect, it } from 'vitest'

import { MosaicPacker, packFinal, roundedRectPolygon } from './wordCloudLayout'

/**
 * 词云几何是最值得机器验证的前端算法（产物是 SVG 多边形，肉眼只能看「像不像」）。
 * 这里锁的**不是像素级快照**，而是算法承诺的不变量：
 *   ① 面积 ∝ 词频（单调性）；
 *   ② 覆盖容器（不留大片空白）；
 *   ③ 确定性（同输入同输出，入场不闪动）；
 *   ④ 破泡/恢复的状态一致性。
 * 阈值按 FRONTEND-ARCH.md §7 红线「只搬不改」取宽裕值 —— 调参若破坏不变量，这里会红。
 */

const BOX: [number, number] = [600, 210]

function cellsArea(cells: { poly: [number, number][] }[]): number {
  return cells.reduce((sum, c) => {
    let a = 0
    for (let i = 0; i < c.poly.length; i++) {
      const [x1, y1] = c.poly[i]
      const [x2, y2] = c.poly[(i + 1) % c.poly.length]
      a += x1 * y2 - x2 * y1
    }
    return sum + Math.abs(a) / 2
  }, 0)
}

describe('roundedRectPolygon — 容器轮廓', () => {
  it('闭合且在容器内（不越界）', () => {
    const poly = roundedRectPolygon(BOX[0], BOX[1], 16)
    expect(poly.length).toBeGreaterThan(4)
    for (const [x, y] of poly) {
      // 允许极小浮点溢出
      expect(x).toBeGreaterThanOrEqual(-0.01)
      expect(x).toBeLessThanOrEqual(BOX[0] + 0.01)
      expect(y).toBeGreaterThanOrEqual(-0.01)
      expect(y).toBeLessThanOrEqual(BOX[1] + 0.01)
    }
  })

  it('圆角半径退化时不炸（半径大于半边长）', () => {
    expect(() => roundedRectPolygon(10, 10, 999)).not.toThrow()
  })
})

describe('MosaicPacker — 面积 ∝ 词频', () => {
  const words = [
    { text: '甲', count: 100 },
    { text: '乙', count: 50 },
    { text: '丙', count: 25 },
    { text: '丁', count: 10 },
    { text: '戊', count: 5 },
  ]

  it('词频越高面积越大（严格单调）', () => {
    const state = packFinal(words, BOX)
    const byText = new Map(state.cells.map((c) => [c.word.text, c]))
    expect(state.cells).toHaveLength(words.length)

    const areas = words.map((w) => {
      const c = byText.get(w.text)
      expect(c, `词「${w.text}」应有自己的 cell`).toBeDefined()
      return cellsArea([c!])
    })
    for (let i = 1; i < areas.length; i++) {
      expect(
        areas[i - 1],
        `「${words[i - 1].text}」(${words[i - 1].count}) 面积应 > 「${words[i].text}」(${words[i].count})`,
      ).toBeGreaterThan(areas[i])
    }
  })

  it('覆盖容器：细胞总面积接近容器面积（不留大片空白）', () => {
    const state = packFinal(words, BOX)
    const cover = cellsArea(state.cells) / (BOX[0] * BOX[1])
    expect(cover).toBeGreaterThan(0.85)
    expect(cover).toBeLessThan(1.05)
  })

  it('确定性：同输入两次结果一致（入场不闪动）', () => {
    const a = packFinal(words, BOX)
    const b = packFinal(words, BOX)
    expect(a.sites.map((s) => [s.x, s.y, s.lam])).toEqual(b.sites.map((s) => [s.x, s.y, s.lam]))
  })

  it('单测：等频词面积应当接近（±25% 容差）', () => {
    const equal = [
      { text: 'A', count: 20 },
      { text: 'B', count: 20 },
      { text: 'C', count: 20 },
      { text: 'D', count: 20 },
    ]
    const state = packFinal(equal, BOX)
    const areas = state.cells.map((c) => cellsArea([c]))
    const mean = areas.reduce((s, a) => s + a, 0) / areas.length
    for (const a of areas) {
      expect(Math.abs(a - mean) / mean).toBeLessThan(0.25)
    }
  })
})

describe('MosaicPacker — 增量入场与破泡', () => {
  it('addWord 按顺序累积，size 与 allWords 同步', () => {
    const p = new MosaicPacker(BOX)
    expect(p.size).toBe(0)
    p.addWord({ text: '甲', count: 10 })
    p.addWord({ text: '乙', count: 5 })
    expect(p.size).toBe(2)
    expect(p.allWords.map((w) => w.text)).toEqual(['甲', '乙'])
    expect(p.state().cells).toHaveLength(2)
  })

  it('removeWord 命中返回 true 且移除，未命中返回 false 且不动状态', () => {
    const p = new MosaicPacker(BOX)
    p.addWord({ text: '甲', count: 10 })
    p.addWord({ text: '乙', count: 5 })

    expect(p.removeWord('不存在')).toBe(false)
    expect(p.size).toBe(2)

    expect(p.removeWord('甲')).toBe(true)
    expect(p.size).toBe(1)
    expect(p.allWords.map((w) => w.text)).toEqual(['乙'])
  })

  it('step 在空池时是安全空操作（首帧不炸）', () => {
    const p = new MosaicPacker(BOX)
    expect(() => p.step(1, 2)).not.toThrow()
  })

  it('reset 清空词与站点（恢复初始态）', () => {
    const p = new MosaicPacker(BOX)
    p.addWord({ text: '甲', count: 10 })
    p.reset()
    expect(p.size).toBe(0)
    expect(p.state().cells).toHaveLength(0)
  })
})
