// @vitest-environment jsdom
/**
 * 背景取景的纯逻辑（需求 7，`devlog/418`）。
 *
 * 最值钱的两条判据：
 * ① **坏 JSON ⇒ 原样铺**（不抛、不白屏）—— 这一格是能被手工改坏的；
 * ② **平移范围被缩放倍数卡住** ⇒ 在任何 x/y 上都**露不出边**（取景不是"把图挪开"）。
 */
import { describe, expect, it } from 'vitest'

import {
  clampFocus, FOCUS_CENTER, focusTransform, parseBackgroundFocus, serializeBackgroundFocus,
  type BackgroundFocus,
} from './backgroundFocus'

/** 从 `translate(a%, b%) scale(s)` 里抠出三个数。 */
function decompose(t: string) {
  const m = /translate\((-?[\d.]+)%, (-?[\d.]+)%\) scale\(([\d.]+)\)/.exec(t)
  expect(m, `transform 形状变了：${t}`).toBeTruthy()
  return { dx: Number(m![1]), dy: Number(m![2]), s: Number(m![3]) }
}

describe('backgroundFocus', () => {
  it('看不出效果的取景 ⇒ **连 transform 都不生成**（恒等变换只会让 DOM 多一个属性）', () => {
    expect(focusTransform(null)).toBeUndefined()
    expect(focusTransform(FOCUS_CENTER)).toBeUndefined()
    expect(focusTransform({ x: 1, y: 0, scale: 1 }), 'scale=1 时 x/y 无效果').toBeUndefined()
    // ⚠️ 但"居中 + 放大"**不是**这种情况：translate 是 0，scale 本身有效果
    expect(focusTransform({ x: 0.5, y: 0.5, scale: 2 })).toBe('translate(0%, 0%) scale(2)')
  })

  it('解析**不把"等价于居中"的值折成 null**（x/y 是用户存下来的意图，调大缩放时要还在）', () => {
    expect(parseBackgroundFocus(serializeBackgroundFocus(FOCUS_CENTER))).toEqual(FOCUS_CENTER)
    expect(parseBackgroundFocus('{"x":1}')).toEqual({ x: 1, y: 0.5, scale: 1 })
  })

  it('★ 坏 JSON / 缺字段 ⇒ 退回「原样铺」，**绝不抛**', () => {
    for (const bad of ['', '{', 'null', '[]', '"x"', '{"x":', 'not json at all', '42']) {
      expect(parseBackgroundFocus(bad), `坏值：${bad}`).toBeNull()
    }
    // 缺字段：按居中补
    expect(parseBackgroundFocus('{"scale":2}')).toEqual({ x: 0.5, y: 0.5, scale: 2 })
    expect(parseBackgroundFocus(null)).toBeNull()
    expect(parseBackgroundFocus(undefined)).toBeNull()
  })

  it('存取的形状与后端一致（`{"x","y","scale"}`），且往返不丢', () => {
    const f: BackgroundFocus = { x: 0.25, y: 0.75, scale: 1.5 }
    expect(JSON.parse(serializeBackgroundFocus(f))).toEqual(f)
    expect(parseBackgroundFocus(serializeBackgroundFocus(f))).toEqual(f)
  })

  it('越界一律**夹住**（交互里夹住比报错合适；后端那边是 422，两端各管一段）', () => {
    expect(clampFocus({ x: -1, y: 9, scale: 99 })).toEqual({ x: 0, y: 1, scale: 3 })
    expect(clampFocus({ x: 2, y: -2, scale: 0.1 })).toEqual({ x: 1, y: 0, scale: 1 })
  })

  it('★ 平移范围被缩放倍数卡住 —— 任何取值都**露不出边**', () => {
    for (const scale of [1.4, 2, 3]) {          // ⚠️ scale=1 不在此列：那时压根不生成 transform
      const limit = (scale - 1) * 50          // 半溢出，换算成"占元素宽度的百分比"
      for (const x of [0, 0.25, 0.5, 0.75, 1]) {
        const { dx, dy } = decompose(focusTransform({ x, y: x, scale })!)
        expect(Math.abs(dx), `scale=${scale} x=${x} 不该越过半边溢出`).toBeLessThanOrEqual(limit + 1e-9)
        expect(Math.abs(dy)).toBeLessThanOrEqual(limit + 1e-9)
      }
      // 边界上：恰好顶到边（不是"永远差一点"，那等于没取到边）
      const edge = decompose(focusTransform({ x: 1, y: 0, scale })!)
      expect(edge.dx).toBeCloseTo(limit, 6)
      expect(edge.dy).toBeCloseTo(-limit, 6)
    }
  })

  it('⚠️ 顺序必须是 `translate(...) scale(...)` —— 反过来同样的 x 会跑到不同地方', () => {
    const t = focusTransform({ x: 1, y: 0.5, scale: 2 })!
    expect(t.indexOf('translate')).toBeLessThan(t.indexOf('scale'))
  })

  it('scale=1 时**不生成**任何变换（此时本来就没有溢出可挪）', () => {
    expect(focusTransform({ x: 0, y: 1, scale: 1 })).toBeUndefined()
  })
})
