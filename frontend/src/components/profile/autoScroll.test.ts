import { describe, expect, it } from 'vitest'

import {
  AUTO_SCROLL_MAX_PX_S, AUTO_SCROLL_RUNWAY_PX, AUTO_SCROLL_ZONE_PX,
  autoScrollSpeed, nextScrollTop,
} from './autoScroll'

/**
 * 自动滚动（R37-P4d，规格 §5.7）。
 *
 * 这一层只回答"这一帧该滚多快"；"下探"与"拓展"都是它的结果。
 * 用例盯的是三类错法：中间带误滚（拖到一半自己跑）、ramp 方向反了（越靠边越慢）、
 * 越界不夹（滚过头/负数 scrollTop）。
 */

const TOP = 100
const BOTTOM = 700      // 视口 600px 高

describe('autoScrollSpeed — 指针在哪 ⇒ 滚多快', () => {
  it('中间带不动（上下各留一个触发区）', () => {
    expect(autoScrollSpeed(400, TOP, BOTTOM)).toBe(0)
    expect(autoScrollSpeed(BOTTOM - AUTO_SCROLL_ZONE_PX, TOP, BOTTOM)).toBe(0)  // 正好在区边界外
    expect(autoScrollSpeed(TOP + AUTO_SCROLL_ZONE_PX, TOP, BOTTOM)).toBe(0)
  })

  it('进入下区：从 0 线性 ramp 到满速（越靠边越快）', () => {
    const edge = autoScrollSpeed(BOTTOM - AUTO_SCROLL_ZONE_PX + 1, TOP, BOTTOM)
    const half = autoScrollSpeed(BOTTOM - AUTO_SCROLL_ZONE_PX / 2, TOP, BOTTOM)
    const near = autoScrollSpeed(BOTTOM - 4, TOP, BOTTOM)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(half)
    expect(half).toBeLessThan(near)
    expect(near).toBeLessThanOrEqual(AUTO_SCROLL_MAX_PX_S)
    expect(half).toBe(Math.round(AUTO_SCROLL_MAX_PX_S / 2))
  })

  it('贴上缘/下缘、以及**拖出容器**：该方向满速（不然拖到窗口外就没反应）', () => {
    expect(autoScrollSpeed(BOTTOM, TOP, BOTTOM)).toBe(AUTO_SCROLL_MAX_PX_S)
    expect(autoScrollSpeed(BOTTOM + 300, TOP, BOTTOM)).toBe(AUTO_SCROLL_MAX_PX_S)
    expect(autoScrollSpeed(TOP, TOP, BOTTOM)).toBe(-AUTO_SCROLL_MAX_PX_S)
    expect(autoScrollSpeed(TOP - 300, TOP, BOTTOM)).toBe(-AUTO_SCROLL_MAX_PX_S)
  })

  it('上区为负（向上滚）且对称', () => {
    expect(autoScrollSpeed(TOP + AUTO_SCROLL_ZONE_PX / 2, TOP, BOTTOM))
      .toBe(-Math.round(AUTO_SCROLL_MAX_PX_S / 2))
  })

  it('还没量到容器尺寸（高 0）⇒ 不滚（不许拿 0 当除数量）', () => {
    expect(autoScrollSpeed(400, 0, 0)).toBe(0)
    expect(autoScrollSpeed(400, 700, 100)).toBe(0)
  })

  it('口径常量就是拍板值（改常量不改断言 ⇒ 红）', () => {
    expect(AUTO_SCROLL_ZONE_PX).toBe(64)
    expect(AUTO_SCROLL_MAX_PX_S).toBe(900)
    expect(AUTO_SCROLL_RUNWAY_PX).toBe(240)
  })
})

describe('nextScrollTop — 这一帧滚到哪', () => {
  it('按速度 × 时间前进', () => {
    expect(nextScrollTop(0, 900, 100, 5000)).toBeCloseTo(90, 5)
    expect(nextScrollTop(1000, -900, 100, 5000)).toBeCloseTo(910, 5)
  })

  it('夹在 [0, maxScrollTop]：不许滚成负数、也不许越过内容底部', () => {
    expect(nextScrollTop(0, -900, 100, 5000)).toBe(0)
    expect(nextScrollTop(4990, 900, 100, 5000)).toBe(5000)
  })

  it('速度为 0 或时间为 0 ⇒ 原地（不产生无意义写入）', () => {
    expect(nextScrollTop(123, 0, 16, 5000)).toBe(123)
    expect(nextScrollTop(123, 900, 0, 5000)).toBe(123)
  })

  it('没有可滚空间（maxScrollTop = 0）⇒ 停在 0（跑道就是为它准备的）', () => {
    expect(nextScrollTop(0, 900, 500, 0)).toBe(0)
  })
})
