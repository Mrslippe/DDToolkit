import { describe, expect, it } from 'vitest'
import {
  buildPayload,
  dirtyKeys,
  fieldError,
  parseField,
  valueOf,
  type RangeSpec,
} from './settingsDraft'

/**
 * 设置弹窗的输入处理（R14a，devlog/091）。
 * 判错的代价都是"界面看不出来"的那种：清空 → 0（间隔变 0 秒，贴着风控跑）、
 * 中间态被吞（输入框自己清空）、前端阈值与后端分叉（界面允许、后端 400）。
 */
const int = (min: number, max: number, value = 10): RangeSpec =>
  ({ kind: 'int', min, max, unit: '秒', default: 10, value })
const float = (min: number, max: number, value = 3): RangeSpec =>
  ({ kind: 'float', min, max, unit: '秒', default: 3, value })
const bool = (value = true): RangeSpec =>
  ({ kind: 'bool', min: null, max: null, unit: '', default: true, value })

describe('输入文本 → 草稿', () => {
  it('清空**不许**当成 0（否则保存出去就是"间隔 0 秒"）', () => {
    expect(parseField('', 'int')).toBe('')
    expect(parseField('   ', 'float')).toBe('')
    expect(parseField('', 'int')).not.toBe(0)
  })

  it('非法中间态保留为"空"，不写 NaN 回受控输入框', () => {
    expect(parseField('abc', 'int')).toBe('')
    expect(parseField('.', 'float')).toBe('')
    expect(parseField('1.', 'float')).toBe(1)      // parseFloat 认它，允许
    expect(parseField('2.5', 'int')).toBe(2)       // 整数键：取整（后端还会再校验一次）
  })

  it('正常值按类型解析', () => {
    expect(parseField('12', 'int')).toBe(12)
    expect(parseField('1.25', 'float')).toBe(1.25)
    expect(parseField('-3', 'float')).toBe(-3)
  })
})

describe('单字段校验（范围来自后端 spec）', () => {
  it('越界给出带单位的可读原因', () => {
    expect(fieldError(int(1, 100), 0)).toBe('不能小于 1秒')
    expect(fieldError(int(1, 100), 101)).toBe('不能大于 100秒')
    expect(fieldError(float(0.5, 10), 0.4)).toContain('不能小于 0.5')
  })

  it('边界值本身合法（闭区间）', () => {
    expect(fieldError(int(1, 100), 1)).toBeNull()
    expect(fieldError(int(1, 100), 100)).toBeNull()
  })

  it('清空与非法值都提示"需要一个数字"', () => {
    expect(fieldError(int(1, 100), '')).toBe('需要一个数字')
    expect(fieldError(int(1, 100), Number.NaN)).toBe('需要一个数字')
    expect(fieldError(int(1, 100), true)).toBe('需要一个数字')
  })

  it('bool 键不参与数值校验', () => {
    expect(fieldError(bool(), true)).toBeNull()
    expect(fieldError(bool(), false)).toBeNull()
  })
})

describe('草稿合并与提交体', () => {
  const specs = [
    { key: 'A', ...int(1, 100, 10) },
    { key: 'B', ...float(0.5, 10, 3) },
    { key: 'C', ...bool(true) },
  ]

  it('显示值 = 草稿优先，否则后端生效值', () => {
    expect(valueOf(specs[0], {}, 'A')).toBe(10)
    expect(valueOf(specs[0], { A: 20 }, 'A')).toBe(20)
  })

  it('只有真正改过的键会被提交（没碰过的键不进 payload）', () => {
    const draft = { A: 20, B: 3 }             // B 填了但与原值相同
    expect(dirtyKeys(specs, draft)).toEqual(['A'])
    expect(buildPayload(['A'], draft)).toEqual({ A: 20 })
  })

  it('清空的键算改过，但不会被拼进提交体（保存按钮此时是禁用的）', () => {
    const draft = { A: '' as const }
    expect(dirtyKeys(specs, draft)).toEqual(['A'])
    expect(buildPayload(['A'], draft)).toEqual({})
  })

  it('布尔开关算改过并原样提交', () => {
    const draft = { C: false }
    expect(dirtyKeys(specs, draft)).toEqual(['C'])
    expect(buildPayload(['C'], draft)).toEqual({ C: false })
  })
})
