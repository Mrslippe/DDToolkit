import { describe, expect, it } from 'vitest'
import {
  atBound,
  buildPayload,
  bump,
  dirtyKeys,
  fieldError,
  pairProblems,
  parseField,
  stepOf,
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

/**
 * 跨字段约束（R17）：设置窗口分成多页之后，这个冲突必须能在**当前页**看出来 ——
 * 否则用户改完上限翻到别的页点保存，只会拿到一个看不懂的底部报错。
 * 真判定在后端（`runtime_settings.PAIRS` + 400），这里是同源的提前提示。
 */
describe('跨字段：上限不能小于下限', () => {
  it('上限 < 下限 → 报在"上限"那一行，并带上两个数', () => {
    const out = pairProblems({
      REQUEST_INTERVAL_MIN: 5, REQUEST_INTERVAL_MAX: 2,
    })
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('REQUEST_INTERVAL_MAX')
    expect(out[0].message).toContain('不能小于下限')
    expect(out[0].message).toContain('2')
    expect(out[0].message).toContain('5')
  })

  it('相等是合法的（闭区间，"固定间隔"是一种用法）', () => {
    expect(pairProblems({ REQUEST_INTERVAL_MIN: 3, REQUEST_INTERVAL_MAX: 3 })).toEqual([])
  })

  it('收录间隔那一对也管', () => {
    const out = pairProblems({
      MANUAL_FAST_INTERVAL_MIN: 3, MANUAL_FAST_INTERVAL_MAX: 1,
    })
    expect(out.map((p) => p.key)).toEqual(['MANUAL_FAST_INTERVAL_MAX'])
  })

  it('只给了一个键 / 清空 / 非法值 → 交给 fieldError，不在这里报（避免双份红字）', () => {
    expect(pairProblems({ REQUEST_INTERVAL_MIN: 5 })).toEqual([])
    expect(pairProblems({ REQUEST_INTERVAL_MIN: '', REQUEST_INTERVAL_MAX: 2 })).toEqual([])
    expect(pairProblems({ REQUEST_INTERVAL_MIN: 5, REQUEST_INTERVAL_MAX: '' })).toEqual([])
    expect(pairProblems({ REQUEST_INTERVAL_MIN: Number.NaN, REQUEST_INTERVAL_MAX: 2 })).toEqual([])
  })

  it('布尔键不会被当成数字比较', () => {
    expect(pairProblems({ EXTERNAL_ENABLED: true })).toEqual([])
  })

  it('两对同时冲突 → 两条都报（不互相掩盖）', () => {
    const out = pairProblems({
      REQUEST_INTERVAL_MIN: 5, REQUEST_INTERVAL_MAX: 1,
      MANUAL_FAST_INTERVAL_MIN: 4, MANUAL_FAST_INTERVAL_MAX: 2,
    })
    expect(out.map((p) => p.key).sort())
      .toEqual(['MANUAL_FAST_INTERVAL_MAX', 'REQUEST_INTERVAL_MAX'])
  })
})

/**
 * 数字步进（R21 批 2，devlog/101）：数字框改成"左减右加"的整行步进条。
 * 判错的代价同样在界面上看不出来：步子太大（3 秒调不到 3.5 秒）、
 * 不夹范围（一路按到 999，等后端 400）、空值也给箭头（点一下把 `''` 变成 NaN → 输入框自己清空）。
 */
describe('数字步进', () => {
  it('整数一步 1；小数按跨度分档：窄的 0.5、宽的 1', () => {
    expect(stepOf(int(1, 100))).toBe(1)
    expect(stepOf(float(0.5, 10))).toBe(0.5)        // 账号间隔：用户就是想调半秒
    expect(stepOf(float(0, 3600))).toBe(1)          // 直播轮询：0.5 秒的步子等于没步
  })

  it('加减与夹范围：点 + 到顶就不再涨，点 − 到底就不再降', () => {
    expect(bump(int(1, 100, 3), 3, 1)).toBe(4)
    expect(bump(int(1, 100, 3), 3, -1)).toBe(2)
    expect(bump(int(1, 5, 5), 5, 1)).toBe(5)        // 已经在上界
    expect(bump(int(1, 5, 1), 1, -1)).toBe(1)
  })

  it('小数步进不产生浮点噪声（3.0 + 0.5 = 3.5，不是 3.5000000000000004）', () => {
    expect(bump(float(0.5, 10, 3), 3, 1)).toBe(3.5)
    expect(bump(float(0.1, 5, 0.1), 0.1, 1)).toBe(0.6)
  })

  it('到界了箭头置灰（判据不只"值等于边界"，还包括空值与布尔）', () => {
    expect(atBound(int(1, 5, 5), 5, 1)).toBe(true)
    expect(atBound(int(1, 5, 1), 1, -1)).toBe(true)
    expect(atBound(int(1, 5, 3), 3, 1)).toBe(false)
    expect(atBound(int(1, 5), '', 1)).toBe(true)     // 输入框被清空
    expect(atBound(bool(), true, 1)).toBe(true)      // 开关没有步进
  })

  it('当前值不可用时点击是 no-op（返回 null），不会写出 NaN', () => {
    expect(bump(int(1, 5), '', 1)).toBeNull()
    expect(bump(bool(), true, 1)).toBeNull()
  })
})
