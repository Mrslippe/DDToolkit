import { describe, expect, it } from 'vitest'
import {
  ABOUT_ID,
  APPEARANCE_ID,
  buildNav,
  buildSections,
  categoryOfKey,
  groupDirty,
  keysOfGroup,
  resetDraftOfGroup,
} from './settingsNav'

/**
 * 设置窗口的导航结构（R17，devlog/094）。
 * 判错的代价：① 后端加了参数组而界面看不到（"设了个寂寞"）；
 * ② 切分类把未保存的草稿丢了；③ 圆点标错页 —— 用户找不到自己改过哪一项。
 */
const SPECS = [
  { key: 'REQUEST_INTERVAL_MIN', group: '抓取节奏' },
  { key: 'REQUEST_INTERVAL_MAX', group: '抓取节奏' },
  { key: 'FETCH_BATCH_SIZE', group: '抓取节奏' },
  { key: 'DYNAMICS_BUDGET_RPM', group: '动态流与轮询' },
  { key: 'EXTERNAL_ENABLED', group: '第三方数据' },
]

describe('导航结构（数据驱动）', () => {
  it('外观第一、关于最后、中间按后端声明序', () => {
    const nav = buildNav(SPECS, 1, 10)
    expect(nav.map((n) => n.id)).toEqual([
      APPEARANCE_ID, '抓取节奏', '动态流与轮询', '第三方数据', ABOUT_ID,
    ])
    expect(nav.map((n) => n.label)).toEqual(['外观', '抓取节奏', '动态流与轮询', '第三方数据', '关于'])
  })

  it('**后端加一组，导航自己多一项**（不许维护前端清单）', () => {
    const withNew = [...SPECS, { key: 'DANMAKU_LIMIT', group: '弹幕采集' }]
    const nav = buildNav(withNew, 1, 10)
    expect(nav.map((n) => n.id)).toContain('弹幕采集')
    expect(nav.find((n) => n.id === '弹幕采集')?.count).toBe(1)
    // 未知分组也要有图标（不能让新分组变成没有图标的孤儿项）
    expect(nav.find((n) => n.id === '弹幕采集')?.icon).toBeTruthy()
  })

  it('项数是该分组的字段条数；外观/关于用自己的计数', () => {
    const nav = buildNav(SPECS, 1, 10)
    expect(nav.find((n) => n.id === '抓取节奏')?.count).toBe(3)
    expect(nav.find((n) => n.id === APPEARANCE_ID)?.count).toBe(1)
    expect(nav.find((n) => n.id === ABOUT_ID)?.count).toBe(10)
  })

  it('只有抓取参数类可「恢复本类默认」（外观立即生效、关于只读）', () => {
    const nav = buildNav(SPECS, 1, 10)
    expect(nav.filter((n) => n.resettable).map((n) => n.id))
      .toEqual(['抓取节奏', '动态流与轮询', '第三方数据'])
  })

  it('空 specs 也不炸（后端还没起来时导航只剩外观与关于）', () => {
    expect(buildNav([], 1, 0).map((n) => n.id)).toEqual([APPEARANCE_ID, ABOUT_ID])
  })
})

describe('分组内容', () => {
  it('键列表照 specs 声明序', () => {
    expect(keysOfGroup(SPECS, '抓取节奏'))
      .toEqual(['REQUEST_INTERVAL_MIN', 'REQUEST_INTERVAL_MAX', 'FETCH_BATCH_SIZE'])
    expect(keysOfGroup(SPECS, '不存在')).toEqual([])
  })

  it('恢复本类默认只给该分类的键（不碰别的分类）', () => {
    const specs = SPECS.map((s) => ({ ...s, default: 1 }))
    expect(Object.keys(resetDraftOfGroup(specs, '第三方数据'))).toEqual(['EXTERNAL_ENABLED'])
  })

  it('categoryOfKey 能定位到分类；定位不到返回 null（不许瞎猜）', () => {
    expect(categoryOfKey(SPECS.map((s) => ({ ...s, value: 1 })), 'FETCH_BATCH_SIZE'))
      .toBe('抓取节奏')
    expect(categoryOfKey(SPECS.map((s) => ({ ...s, value: 1 })), 'NOPE')).toBeNull()
  })
})

describe('未保存圆点', () => {
  const specs = SPECS.map((s) => ({ ...s, value: 10 }))

  it('改过的分类才亮；别的分类不受影响', () => {
    expect(groupDirty(specs, { FETCH_BATCH_SIZE: 4 }, '抓取节奏')).toBe(true)
    expect(groupDirty(specs, { FETCH_BATCH_SIZE: 4 }, '动态流与轮询')).toBe(false)
  })

  it('填了但与原值相同 → 不算改过（与"待保存 N 项"同一口径）', () => {
    expect(groupDirty(specs, { FETCH_BATCH_SIZE: 10 }, '抓取节奏')).toBe(false)
  })

  it('清空输入（`\'\'`）也算改动 —— 它会被校验拦住，但"这页动过"要如实显示', () => {
    expect(groupDirty(specs, { FETCH_BATCH_SIZE: '' }, '抓取节奏')).toBe(true)
  })
})

/**
 * 页内布局（R21，devlog/100）：用户口径「可选项太多、设置很杂，没有专业背景的人
 * 不知道每一项意味着什么」⇒ 字段按**用途**分成小组，非关键项收进「高级（默认收起）」。
 *
 * 判错的代价：① 普通用户又被一堆参数糊脸（分组没生效）；
 * ② 关键项被误判成高级项 → 用户找不到它（**成对的上下限被拆开**是最坏的一种）。
 */
describe('页内小组与高级折叠', () => {
  const ROWS = [
    { key: 'A', group: '抓取设置', section: '风控与节流', advanced: false },
    { key: 'B', group: '抓取设置', section: '风控与节流', advanced: false },
    { key: 'C', group: '抓取设置', section: '开播信息抓取', advanced: false },
    { key: 'D', group: '抓取设置', section: '风控与节流', advanced: true },
    { key: 'E', group: '数据源', section: '', advanced: false },
  ]

  it('小组按声明序、组内也按声明序', () => {
    const p = buildSections(ROWS, '抓取设置')
    expect(p.sections.map((s) => s.name)).toEqual(['风控与节流', '开播信息抓取'])
    expect(p.sections[0].keys).toEqual(['A', 'B'])
    expect(p.sections[1].keys).toEqual(['C'])
  })

  it('多于一组才渲染小组标题（单组是噪音：页标题已经说明白了）', () => {
    expect(buildSections(ROWS, '抓取设置').showHeadings).toBe(true)
    expect(buildSections(ROWS, '数据源').showHeadings).toBe(false)
  })

  it('section 为空串 → 归到页名那一组（后端不必为单页写重复的 section）', () => {
    expect(buildSections(ROWS, '数据源').sections).toEqual([
      { name: '数据源', keys: ['E'] },
    ])
  })

  it('高级项从小组里抽走，且不进任何标题', () => {
    const p = buildSections(ROWS, '抓取设置')
    expect(p.advanced).toEqual(['D'])
    expect(p.sections.flatMap((s) => s.keys)).not.toContain('D')
  })

  it('不存在的分类 → 空布局（不抛错：切页时序不该让界面炸）', () => {
    expect(buildSections(ROWS, '没有这个分类')).toEqual({
      sections: [], showHeadings: false, advanced: [],
    })
  })
})
