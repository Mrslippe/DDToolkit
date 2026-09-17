import { describe, expect, it, beforeEach } from 'vitest'

import {
  getCardKind, listCardKinds, registerCardKind, resetCardKinds,
  type CardKindMeta,
} from './cardRegistry'

/**
 * 卡片注册表（R37-P1，devlog/141）。
 *
 * 这是"支持拓展"的唯一入口，两条纪律各一条用例：
 *   ① **重复 kind 必须抛错** —— 静默覆盖会让"注册了却没显示/显示成别人的样子"极难排查；
 *   ② **顺序 = 注册顺序** —— 默认布局按它排卡片，顺序漂了用户的档案页就跟着变。
 */

const meta = (kind: string, title = kind): CardKindMeta =>
  ({ kind, title, defaultSize: { w: 6, h: 3 }, render: () => null })

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
})