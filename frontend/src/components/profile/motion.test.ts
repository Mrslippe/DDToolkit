import { describe, expect, it } from 'vitest'

import {
  DRAG_SLOP_PX, LONG_PRESS_MS, SETTLE_MS, type CardPhase,
  isDrag, isLongPress, liftOffset, motionPlan, nextPhase, phaseTransform,
} from './motion'

/**
 * 档案视图手势与动效口径（R37-P4b，规格 `docs/design-archive-cards.md` §5）。
 *
 * 这一组用例盯的是"看着能忍但其实是错的"那几件事：
 * 相位乱跳（抬手之后长按定时器才到 ⇒ 卡片又自己拿起来了）、
 * 跟手算式漏掉格子自身的位移（拖起来越拖越偏）、
 * reduced-motion 把跟手一起关掉（那不是减少动效，是拖动失灵）。
 */

describe('nextPhase — 相位机', () => {
  it('按下 → 长按成立 → 抬手 → 落位完成', () => {
    let p: CardPhase = 'idle'
    p = nextPhase(p, 'down')
    expect(p).toBe('pressing')
    p = nextPhase(p, 'hold')
    expect(p).toBe('lifted')
    p = nextPhase(p, 'up')
    expect(p).toBe('settling')
    p = nextPhase(p, 'settled')
    expect(p).toBe('idle')
  })

  it('**迟到的长按定时器无害**：抬手之后才到 ⇒ 不许把卡片重新拿起来', () => {
    const afterUp = nextPhase('pressing', 'up')          // 短按：直接回 idle
    expect(afterUp).toBe('idle')
    expect(nextPhase(afterUp, 'hold')).toBe('idle')      // 定时器这时才到
    expect(nextPhase('settling', 'hold')).toBe('settling')
  })

  it('跟手期间相位不变（避免每个 pointermove 都触发一次渲染语义变化）', () => {
    expect(nextPhase('lifted', 'drag')).toBe('lifted')
    expect(nextPhase('pressing', 'drag')).toBe('pressing')
  })

  it('短按（还没长按就抬手）直接回 idle —— 不经过落位', () => {
    expect(nextPhase('pressing', 'up')).toBe('idle')
  })

  it('取消（指针被系统收走）回 idle；未在落位时收到 settled 也不会乱跳', () => {
    expect(nextPhase('lifted', 'cancel')).toBe('idle')
    expect(nextPhase('pressing', 'cancel')).toBe('idle')
    expect(nextPhase('idle', 'settled')).toBe('idle')
  })
})

describe('isLongPress / isDrag — 两个阈值', () => {
  it('长按阈值 350ms（与 Hero 药丸重排同值，全站只教用户一个数字）', () => {
    expect(LONG_PRESS_MS).toBe(350)
    expect(isLongPress(349)).toBe(false)
    expect(isLongPress(350)).toBe(true)
  })

  it('防抖 6px：斜向位移按 hypot 算（只看单轴会在对角方向漏判）', () => {
    expect(DRAG_SLOP_PX).toBe(6)
    expect(isDrag(5, 0)).toBe(false)
    expect(isDrag(6, 0)).toBe(true)
    expect(isDrag(4, 4)).toBe(false)         // hypot(4,4)=5.66 < 6：单轴都没超，斜着也不该算
    expect(isDrag(5, 5)).toBe(true)          // hypot(5,5)=7.07 ≥ 6
  })
})

describe('liftOffset — 跟手算式', () => {
  it('格子没动时 = 指针位移', () => {
    expect(liftOffset(37, -12, 0, 0)).toEqual({ x: 37, y: -12 })
  })

  it('**减去格子自身的位移**：格子往右跳了一列，卡片在屏幕上不该跟着跳', () => {
    // 指针右移 120px、格子右移 70.8px（一列 + 间隙）⇒ 视觉上只该走 49px
    expect(liftOffset(120, 0, 70.833, 0)).toEqual({ x: 49, y: 0 })
  })

  it('取整到整像素（分数像素的 transform 会让拖动中的文字发虚）', () => {
    expect(liftOffset(20.4, -3.6, 0.83, 0.83)).toEqual({ x: 20, y: -4 })
    expect(liftOffset(0.4, 0, 0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('格子往下跳一行（84 + 12）时同理', () => {
    expect(liftOffset(0, 200, 0, 96)).toEqual({ x: 0, y: 104 })
  })
})

describe('motionPlan — reduced-motion 的口径', () => {
  it('默认：按下缩一点、拾起弹一次、落位滑 220ms', () => {
    expect(motionPlan(false)).toEqual({ pressScale: 0.985, liftScale: 1.055, settleMs: SETTLE_MS })
    expect(SETTLE_MS).toBe(220)
  })

  it('减少动效：**去掉缩放与滑行，但保留跟手**（跟手是输入反馈，不是动画）', () => {
    expect(motionPlan(true)).toEqual({ pressScale: 1, liftScale: 1, settleMs: 0 })
  })

  it('过冲幅度是"轻微"档：≤5.5%（规格 §11 的拍板值）', () => {
    expect(motionPlan(false).liftScale).toBeLessThanOrEqual(1.055)
  })
})

describe('phaseTransform — 相位 → 内联 transform', () => {
  const plan = motionPlan(false)

  it('按下只缩放、不位移（还没拿起来）', () => {
    expect(phaseTransform('pressing', 0, 0, plan)).toBe('scale(0.985)')
  })

  it('拾起：位移 + 缩放一起给（跟手 + 弹一次）', () => {
    expect(phaseTransform('lifted', 12, -8, plan)).toBe('translate3d(12px, -8px, 0) scale(1.055)')
  })

  it('落位 / 静止：**不给内联 transform**（交给 CSS 过渡回 none，否则没有"落下"的过程）', () => {
    expect(phaseTransform('settling', 12, -8, plan)).toBeUndefined()
    expect(phaseTransform('idle', 0, 0, plan)).toBeUndefined()
  })

  it('减少动效下按下不给 transform（没有缩放就没有中间态）', () => {
    expect(phaseTransform('pressing', 0, 0, motionPlan(true))).toBeUndefined()
    // 但拾起仍然要位移 —— 跟手不能关
    expect(phaseTransform('lifted', 5, 5, motionPlan(true)))
      .toBe('translate3d(5px, 5px, 0) scale(1)')
  })
})
