import { describe, expect, it } from 'vitest'

import {
  FLIP_MIN_PX, FLIP_ROW_PX, flipDelta, flipDurationMs, movedBetween, needsFlip,
} from './flip'

/**
 * 退避动画的几何（R37-P4c，规格 §5.2）。
 *
 * 这一组用例盯的是"差一点点"的那类错：补偿量的正负号搞反（卡片会飞出去）、
 * 亚像素抖动也开过渡（看着像在抖）、时长不随距离变（跨三行和挪一格一样快）。
 */

describe('flipDelta — 补偿位移', () => {
  it('旧位置在左上 ⇒ 补偿量为负（先把它"按回"旧位置）', () => {
    expect(flipDelta({ x: 100, y: 200 }, { x: 170, y: 296 })).toEqual({ x: -70, y: -96 })
  })

  it('旧位置在右下（归位：被挤开的卡升回去）⇒ 补偿量为正', () => {
    expect(flipDelta({ x: 170, y: 296 }, { x: 100, y: 200 })).toEqual({ x: 70, y: 96 })
  })

  it('没动 ⇒ 零向量（不该开过渡）', () => {
    expect(flipDelta({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 0, y: 0 })
  })
})

describe('needsFlip — 值不值得开一次过渡', () => {
  it('位移小于 0.5px 不做（亚像素抖动）', () => {
    expect(FLIP_MIN_PX).toBe(0.5)
    expect(needsFlip({ x: 10, y: 10 }, { x: 10.2, y: 10 })).toBe(false)
    expect(needsFlip({ x: 10, y: 10 }, { x: 10.6, y: 10 })).toBe(true)
  })

  it('纯纵向位移也算（跨行让位就是这么发生的）', () => {
    expect(needsFlip({ x: 10, y: 10 }, { x: 10, y: 106 })).toBe(true)
  })
})

describe('flipDurationMs — 时长由距离决定', () => {
  it('一行以内 = 220ms（--motion-base）', () => {
    expect(FLIP_ROW_PX).toBe(96)
    expect(flipDurationMs(96)).toBe(220)
    expect(flipDurationMs(-96)).toBe(220)
  })

  it('跨 ≥2 行 = 320ms（--motion-slow，位移大才配得上更长时间）', () => {
    expect(flipDurationMs(97)).toBe(320)
    expect(flipDurationMs(-200)).toBe(320)
  })

  it('横向位移不影响时长（列窄，挪一列不该跟跨一行一个待遇）', () => {
    expect(flipDurationMs(0)).toBe(220)
  })
})

describe('movedBetween — 只比位置', () => {
  const a = { x: 0, y: 0, w: 5, h: 3 }

  it('位置变了 ⇒ true', () => {
    expect(movedBetween(a, { ...a, y: 3 })).toBe(true)
    expect(movedBetween(a, { ...a, x: 5 })).toBe(true)
  })

  it('**只变尺寸 ⇒ false**：缩放不走 FLIP（scale 压扁内容 / width 动画重排，两条都更难看）', () => {
    expect(movedBetween(a, { ...a, w: 8 })).toBe(false)
    expect(movedBetween(a, { ...a, w: 8, h: 5 })).toBe(false)
  })
})
