import { describe, expect, it, beforeEach } from 'vitest'
import { Cake } from 'lucide-react'

import {
  getCardKind, listCardKinds, registerCardKind, resetCardKinds,
  type CardKindMeta,
} from './cardRegistry'

/**
 * 卡片注册表（R37-P1，devlog/141；R37-P4a 加了贴纸角标契约）。
 *
 * 这是"支持拓展"的唯一入口，四条纪律各有用例：
 *   ① **重复 kind 必须抛错** —— 静默覆盖会让"注册了却没显示/显示成别人的样子"极难排查；
 *   ② **顺序 = 注册顺序** —— 默认布局按它排卡片，顺序漂了用户的档案页就跟着变；
 *   ③ **色调必须在封闭清单里**（P4a）—— 否则会得到一枚脱离项目色系的贴纸角标；
 *   ④ **必须有贴纸角标图标**（P4a）—— 没图标就是一枚空圆片，看着像加载失败。
 */

const meta = (kind: string, title = kind, over: Partial<CardKindMeta> = {}): CardKindMeta =>
  ({ kind, title, defaultSize: { w: 6, h: 3 }, icon: Cake, tone: 'pink',
     render: () => null, ...over })

beforeEach(() => resetCardKinds())

describe('registerCardKind / listCardKinds', () => {
  it('注册后能取到，且顺序 = 注册顺序', () => {
    registerCardKind(meta('a'))
    registerCardKind(meta('b'))
    expect(listCardKinds().map((k) => k.kind)).toEqual(['a', 'b'])
    expect(getCardKind('b')?.title).toBe('b')
  })

  it('重复 kind 抛错（不静默覆盖）', () => {
    registerCardKind(meta('dup', '第一版'))
    expect(() => registerCardKind(meta('dup', '第二版'))).toThrow(/重复注册/)
    expect(getCardKind('dup')?.title).toBe('第一版')
  })

  it('没注册过的 kind → undefined（视图据此跳过，而不是崩）', () => {
    expect(getCardKind('nope')).toBeUndefined()
  })

  it('清空后为空（用例之间隔离模块级状态）', () => {
    registerCardKind(meta('a'))
    resetCardKinds()
    expect(listCardKinds()).toEqual([])
  })

  it('色调与图标随 meta 一起存下来（视图直接读它们画贴纸角标）', () => {
    registerCardKind(meta('a', '甲', { tone: 'navy' }))
    expect(getCardKind('a')?.tone).toBe('navy')
    expect(getCardKind('a')?.icon).toBe(Cake)
  })

  it('色调不在封闭清单里 → 抛错（不静默退化成默认色）', () => {
    // 故意绕过类型：扩展点将来可能由 JS/数据驱动，运行时这一关必须在
    expect(() => registerCardKind(meta('bad', '野色', { tone: 'chartreuse' as never })))
      .toThrow(/色调/)
    expect(getCardKind('bad')).toBeUndefined()
  })

  it('没给图标 → 抛错（空圆片会被当成加载失败）', () => {
    expect(() => registerCardKind(meta('noicon', '无图标', { icon: undefined as never })))
      .toThrow(/贴纸角标图标/)
    expect(getCardKind('noicon')).toBeUndefined()
  })
})