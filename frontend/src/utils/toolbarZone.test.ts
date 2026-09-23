import { describe, expect, it } from 'vitest'

import { inHotZone, type HotRect } from './toolbarZone'

/** 造一个矩形：`{ x, y, w, h }` → `HotRect`。 */
const r = (x: number, y: number, w: number, h: number): HotRect => ({
  left: x,
  top: y,
  right: x + w,
  bottom: y + h,
  width: w,
})

// 1100 档（面板 558）的真实几何：条 176 居中 ⇒ x=191..367，y=6..52。
const BAR = r(191, 6, 176, 46)
const PAD = 8

describe('inHotZone —— 页面工具条热区（R45）', () => {
  it('条中心命中', () => {
    expect(inHotZone(279, 29, [BAR], PAD)).toBe(true)
  })

  it('条外扩 pad 之内仍命中（边界含端点）', () => {
    expect(inHotZone(BAR.left - PAD, BAR.top - PAD, [BAR], PAD)).toBe(true)
    expect(inHotZone(BAR.right + PAD, BAR.bottom + PAD, [BAR], PAD)).toBe(true)
  })

  it('超出 pad 一点点就不命中 —— 这是"去够别的东西不误触发"的分界', () => {
    expect(inHotZone(BAR.left - PAD - 1, 29, [BAR], PAD)).toBe(false)
    expect(inHotZone(279, BAR.bottom + PAD + 1, [BAR], PAD)).toBe(false)
  })

  it('**多矩形取并集**：右上组自己也能触发（条够不到的地方）', () => {
    const tools = r(502, 14, 32, 30)
    // 点在右上组里、条外
    expect(inHotZone(518, 29, [BAR, tools], PAD)).toBe(true)
    // 去掉右上组就不命中 —— 证明上面那次命中的确是它
    expect(inHotZone(518, 29, [BAR], PAD)).toBe(false)
  })

  it('两个矩形**之间**的空隙不算命中 —— 热区不是"从条左缘到右上组右缘"的一整条', () => {
    // x=450 在条右缘(367)+8=375 之外、右上组左缘(502)-8=494 之内
    expect(inHotZone(450, 29, [BAR, r(502, 14, 32, 30)], PAD)).toBe(false)
  })

  it('`null` 项跳过（右上组只在卡片页渲染，其它视图量到 null）', () => {
    expect(inHotZone(279, 29, [null, BAR], PAD)).toBe(true)
    expect(inHotZone(279, 29, [null, undefined], PAD)).toBe(false)
  })

  it('**零宽矩形跳过** —— 否则会造出一块看不见却能触发的热区', () => {
    expect(inHotZone(0, 0, [r(0, 0, 0, 46)], PAD)).toBe(false)
    // 零宽项不该"吃掉"同批里的正常项
    expect(inHotZone(279, 29, [r(0, 0, 0, 46), BAR], PAD)).toBe(true)
  })

  it('空数组不命中（元素全不在页面上时不该有任何热区）', () => {
    expect(inHotZone(279, 29, [], PAD)).toBe(false)
  })

  it('pad=0 时就是矩形本体，不外扩', () => {
    expect(inHotZone(BAR.left - 1, 29, [BAR], 0)).toBe(false)
    expect(inHotZone(BAR.left, 29, [BAR], 0)).toBe(true)
  })

  it('**纵向下沿**：条底 52 + pad 8 = 60，61 就不命中 —— 分类胶囊在 y=52 起，'
    + '这条保证"悬停胶囊"不会把工具条叫出来', () => {
    expect(inHotZone(279, 60, [BAR], PAD)).toBe(true)
    expect(inHotZone(279, 61, [BAR], PAD)).toBe(false)
  })
})
