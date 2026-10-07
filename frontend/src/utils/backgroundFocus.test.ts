// @vitest-environment jsdom
/**
 * 背景取景的纯逻辑（需求 7；口径 2026-10-07 由用户选 C 定案，`devlog/420`）。
 *
 * 值钱的判据（每条都能被改坏，所以每条都钉住）：
 * ① **坏 JSON ⇒ 原样铺**（不抛、不白屏）—— 这一格是能被手工改坏的；
 * ② ★**锚点守恒**：锚点永远落在取景框的第 `x`/`y` 比例处，**与窗口宽度无关、与缩放倍数无关**；
 * ③ ★**任何 x/y 都不露边**（`scale ≥ 1`、`x,y∈[0,1]` ⇒ 图片始终盖住整框）；
 * ④ ★**拖拽 1:1**：拖 100px 之后，图上那个点真的在屏幕上挪了 100px。
 *
 * ⚠️ ②④ 判的是 **CSS 语义的模型**（`cover` + `background-position` + 绕锚点的 `scale`），
 *    不是我们自己的某个表达式 —— 所以它们能证伪"支点写错了/符号反了"，而不是自我循环。
 *    这个模型也写在下面 `screenX/screenY` 里，②④ 都基于它。
 */
import { describe, expect, it } from 'vitest'

import {
  clampFocus, coverScale, FOCUS_CENTER, focusObjectStyle, focusStyle, panDelta,
  parseBackgroundFocus, serializeBackgroundFocus, type BackgroundFocus,
} from './backgroundFocus'

/** CSS 语义：`cover` + `background-position: x% y%` + 绕 `(x%, y%)` 的 `scale(s)`。 */
function screenX(x: number, s: number, u: number, box: { w: number; h: number }, nat: { w: number; h: number }) {
  const k = coverScale(nat, box)
  return x * box.w + s * k * (u - x * nat.w)
}
function screenY(y: number, s: number, u: number, box: { w: number; h: number }, nat: { w: number; h: number }) {
  const k = coverScale(nat, box)
  return y * box.h + s * k * (u - y * nat.h)
}
/** 错的支点（绕中心缩放）—— 只用来证明判据②不是恒等式。 */
function screenXCenterOrigin(x: number, s: number, u: number, box: { w: number; h: number }, nat: { w: number; h: number }) {
  const k = coverScale(nat, box)
  const px = x * (box.w - k * nat.w) + k * u
  return box.w / 2 + s * (px - box.w / 2)
}

const NAT = { w: 900, h: 1200 }                       // 3:4 竖图
const BOXES = [{ w: 716, h: 750 }, { w: 1336, h: 750 }, { w: 558, h: 750 }, { w: 900, h: 600 }]
const XS = [0, 0.25, 0.5, 0.75, 1]
const SS = [1, 1.2, 1.5, 2, 3]

describe('backgroundFocus', () => {
  it('没有取景 ⇒ **一个属性都不生成**（样式表里的默认值就是"居中 + 不缩放"）', () => {
    expect(focusStyle(null)).toEqual({})
  })

  it('喂给 CSS 的百分比**限两位小数**（拖一下就是 28.57142857142857%，内联样式里难看且没法判）', () => {
    expect(focusStyle({ x: 1 / 3, y: 0.5, scale: 1 }).backgroundPosition).toBe('33.33% 50%')
    expect(focusStyle({ x: 0.123456, y: 0.987654, scale: 2 }).transformOrigin).toBe('12.35% 98.77%')
    // 但**库里那份**不许被这个收敛动到（否则每次拖拽都会把取景改一点点）
    expect(JSON.parse(serializeBackgroundFocus({ x: 1 / 3, y: 0.5, scale: 1 })).x).toBeCloseTo(1 / 3, 12)
  })

  it('★ 替换元素那一版（`<video>`/`<img>`）：三件套齐全、支点同源，键名换成 `objectPosition`', () => {
    expect(focusObjectStyle(null)).toEqual({})
    expect(focusObjectStyle({ x: 0.3, y: 0.35, scale: 1 })).toEqual({ objectPosition: '30% 35%' })
    const st = focusObjectStyle({ x: 0.3, y: 0.35, scale: 2 })
    expect(st.objectPosition).toBe('30% 35%')
    expect(st.transform).toBe('scale(2)')
    expect(st.transformOrigin, '支点必须与锚点同源').toBe(st.objectPosition)
    // ⚠️ 两个函数**不能互换**：对 `<video>` 而言 `background-position` 毫无作用
    //    （症状：取景只在图上有、视频永远居中）—— 键名不同就是这条的机器判据
    expect(Object.keys(focusObjectStyle({ x: 0.3, y: 0.35, scale: 2 })).sort())
      .toEqual(['objectPosition', 'transform', 'transformOrigin'])
  })

  it('★ 三件套：`scale>1` 时位置、缩放、支点**一起**出现，且支点与锚点**同源**', () => {
    const st = focusStyle({ x: 0.3, y: 0.35, scale: 2 })
    expect(st.backgroundPosition).toBe('30% 35%')
    expect(st.transform).toBe('scale(2)')
    // 这一条是"放大后锚点不漂"的全部秘密：支点必须是锚点，不是 50% 50%
    expect(st.transformOrigin, '支点必须与 background-position 同源').toBe(st.backgroundPosition)
  })

  it('`scale=1` ⇒ 只给位置（**位置照给**：此时纵横仍可能有溢出，取景是有用的）', () => {
    expect(focusStyle(FOCUS_CENTER)).toEqual({ backgroundPosition: '50% 50%' })
    expect(focusStyle({ x: 1, y: 0, scale: 1 })).toEqual({ backgroundPosition: '100% 0%' })
  })

  it('★ 锚点守恒：同一组取景，换窗口宽度、换缩放倍数，锚点都落在**同一比例位置**', () => {
    for (const x of XS) {
      for (const y of XS) {
        for (const s of SS) {
          for (const box of BOXES) {
            const ax = screenX(x, s, x * NAT.w, box, NAT) / box.w
            const ay = screenY(y, s, y * NAT.h, box, NAT) / box.h
            expect(ax, `x=${x} s=${s} box=${box.w}x${box.h} 锚点横向漂了`).toBeCloseTo(x, 9)
            expect(ay, `y=${y} s=${s} box=${box.w}x${box.h} 锚点纵向漂了`).toBeCloseTo(y, 9)
          }
        }
      }
    }
    // 反面：支点若用中心（写错成 50% 50%），锚点立刻漂 —— 证明上面那条不是恒等式
    const bad = screenXCenterOrigin(0, 2, 0, { w: 1336, h: 750 }, NAT) / 1336
    expect(bad, '绕中心缩放时 x=0 的锚点会漂到别处，所以②是有内容的').not.toBeCloseTo(0, 3)
  })

  it('★ 永不露边：`x,y∈[0,1]` + `scale ≥ 1` ⇒ 图片始终盖满取景框', () => {
    for (const box of BOXES) {
      for (const s of SS) {
        for (const x of XS) {
          // 左缘 ≤ 0 且 右缘 ≥ W
          expect(screenX(x, s, 0, box, NAT), `x=${x} s=${s} 左边露了`).toBeLessThanOrEqual(1e-9)
          expect(screenX(x, s, NAT.w, box, NAT), `x=${x} s=${s} 右边露了`).toBeGreaterThanOrEqual(box.w - 1e-9)
        }
        for (const y of XS) {
          expect(screenY(y, s, 0, box, NAT)).toBeLessThanOrEqual(1e-9)
          expect(screenY(y, s, NAT.h, box, NAT)).toBeGreaterThanOrEqual(box.h - 1e-9)
        }
      }
    }
  })

  it('★ 拖拽 1:1：按 `panDelta` 挪完之后，图上那个点真的在屏幕上挪了那么多像素', () => {
    const box = { w: 800, h: 750 }                    // 900 宽的竖图铺在 800 宽的框里 ⇒ 横向由宽度驱动
    const k = coverScale(NAT, box)
    const imgW = NAT.w * k, imgH = NAT.h * k
    for (const s of [1.5, 2, 3]) {
      const dPx = 60
      const dx = panDelta(dPx, box.w, imgW, s)
      const before = screenX(0.5, s, 0.5 * NAT.w, box, NAT)
      const after = screenX(0.5 + dx, s, 0.5 * NAT.w, box, NAT)
      expect(after - before, `s=${s} 拖 ${dPx}px 没挪够`).toBeCloseTo(dPx, 6)
      expect(dx, '往右拖 ⇒ 图往右 ⇒ 锚点变小').toBeLessThan(0)
      // 纵向同理
      const dy = panDelta(dPx, box.h, imgH, s)
      const by = screenY(0.5, s, 0.5 * NAT.h, box, NAT)
      expect(screenY(0.5 + dy, s, 0.5 * NAT.h, box, NAT) - by).toBeCloseTo(dPx, 6)
    }
  })

  it('这条轴正好铺满（没有余量）⇒ 挪不动，返回 0 而不是无穷跳变', () => {
    const box = { w: 716, h: 750 }
    const k = coverScale(NAT, box)
    const imgW = NAT.w * k                          // 宽度驱动 ⇒ 横向恰好 = 框宽
    expect(imgW).toBeCloseTo(box.w, 6)
    expect(panDelta(50, box.w, imgW, 1), '横轴没余量').toBe(0)
    // 余量只有 0.4px（浮点误差级别）也当没有 —— 否则 50/0.4 = 125，锚点一跳到底
    expect(panDelta(50, box.w, imgW * 0.9995, 1), '余量不到 1px 也当没有').toBe(0)
    // 但纵向照挪（竖图铺在横框里，纵向必然有溢出）
    expect(panDelta(50, box.h, NAT.h * k, 1)).not.toBe(0)
  })

  it('坏 JSON / 缺字段 ⇒ 退回「原样铺」，**绝不抛**', () => {
    for (const bad of ['', '{', 'null', '[]', '"x"', '{"x":', 'not json at all', '42']) {
      expect(parseBackgroundFocus(bad), `坏值：${bad}`).toBeNull()
    }
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
    // 夹住之后再套样式，仍然是合法 CSS（不许出现 -50% / 900%）
    expect(focusStyle({ x: -1, y: 9, scale: 99 })).toEqual({
      backgroundPosition: '0% 100%', transform: 'scale(3)', transformOrigin: '0% 100%',
    })
  })

  it('`coverScale` 取两条轴的较大者（量不到图片尺寸时退回 1，不许 NaN 传下去）', () => {
    expect(coverScale({ w: 900, h: 1200 }, { w: 716, h: 750 })).toBeCloseTo(716 / 900, 9)
    expect(coverScale({ w: 900, h: 1200 }, { w: 400, h: 750 })).toBeCloseTo(750 / 1200, 9)
    expect(coverScale({ w: 0, h: 0 }, { w: 400, h: 750 })).toBe(1)
  })

  it('缩放上下限与后端同值（1..3）', () => {
    expect(clampFocus({ x: 0.5, y: 0.5, scale: 0 }).scale).toBe(1)
    expect(clampFocus({ x: 0.5, y: 0.5, scale: 9 }).scale).toBe(3)
  })
})
