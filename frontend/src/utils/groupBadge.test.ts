/**
 * 企划徽章的纯逻辑（需求 6，B3，`devlog/457`）。
 *
 * ⚠️ 这里**不测"图标文件在不在"**（那是构建期 `import.meta.glob` 的事，且素材还没做），
 * 测的是三条规则本身：slug 怎么折、标签怎么截、以及**没有图标时必须退到文字**（不许空壳）。
 */
import { describe, expect, it } from 'vitest'

import { PERSONAL_GROUP, groupIcon, groupLabel, groupSlug, knownGroupIcons, vtuberGroup, vtuberGroupOptions } from './groupBadge'

describe('groupSlug', () => {
  it('小写 + 空格折成连字符', () => {
    expect(groupSlug('VirtuaReal')).toBe('virtuareal')
    expect(groupSlug('NIJISANJI EN')).toBe('nijisanji-en')
  })

  it('汉字**原样保留**（不转拼音：那会让"素材该叫什么名"变成猜谜）', () => {
    expect(groupSlug('虚研社')).toBe('虚研社')
    expect(groupSlug('极光社')).toBe('极光社')
  })

  it('标点/括号折成一个连字符，首尾不留', () => {
    expect(groupSlug('  .Live  ')).toBe('live')
    expect(groupSlug('A-SOUL')).toBe('a-soul')
    expect(groupSlug('（某）企划!')).toBe('某-企划')
  })

  it('空值 → 空串（调用方据此跳过一切渲染）', () => {
    expect(groupSlug('')).toBe('')
    expect(groupSlug(null)).toBe('')
    expect(groupSlug(undefined)).toBe('')
    expect(groupSlug('   ')).toBe('')
  })
})

describe('groupLabel', () => {
  it('短的照原样，长的截断加省略号（`title` 由调用方给全名）', () => {
    expect(groupLabel('VirtuaReal')).toBe('Virtua…')     // 10 > 6（默认上限）
    expect(groupLabel('Hololive')).toBe('Hololi…')
    expect(groupLabel('虚研社')).toBe('虚研社')
    expect(groupLabel('')).toBe('')
  })

  it('上限可调（胶囊宽度跟着字号走时用得上）', () => {
    expect(groupLabel('VirtuaReal', 10)).toBe('VirtuaReal')
    expect(groupLabel('NIJISANJI EN', 9)).toBe('NIJISANJI…')
  })
})

describe('groupIcon', () => {
  it('素材还没进来时**一律返回 null** —— 徽章退成文字胶囊，而不是空壳', () => {
    // 这条是"素材缺失也不许画空壳"的判据：只要 `assets/groups/` 是空的，
    // 任何企划名都必须拿到 null（组件据此渲染文字）。
    expect(groupIcon('VirtuaReal')).toBeNull()
    expect(groupIcon('虚研社')).toBeNull()
    expect(groupIcon('')).toBeNull()
    expect(groupIcon(null)).toBeNull()
  })

  it('图标表当前是空的（素材未制作）—— 放进来之后这条会提醒你更新用例', () => {
    const icons = knownGroupIcons()
    expect(Object.keys(icons)).toHaveLength(0)
  })
})


describe('vtuberGroup：界面上唯一那份"企划"', () => {
  it('手填优先，否则用自动检测的（用户 2026-10-10 报的"筛不出来"就出在这里）', () => {
    expect(vtuberGroup({ faction: '我填的', group_name: '自动的' })).toBe('我填的')
    expect(vtuberGroup({ faction: '', group_name: '自动的' })).toBe('自动的')
    expect(vtuberGroup({ faction: null, group_name: '自动的' })).toBe('自动的')
    expect(vtuberGroup({ faction: '   ', group_name: ' 自动的 ' })).toBe('自动的')
  })

  it('★ 两边都没有 ⇒ **「个人势」**（用户 2026-10-13：没有企划的统一用它代替，也算一个类型）', () => {
    // 改前返回 null ⇒ 徽章不渲染、也不进筛选选项。用户改口径之后它是**一个真实取值**：
    // 「她不属于任何企划」本身就是一条信息，而且它因此自然成为一枚可筛选项。
    expect(vtuberGroup({})).toBe(PERSONAL_GROUP)
    expect(vtuberGroup({ faction: null, group_name: null })).toBe('个人势')
    expect(vtuberGroup({ faction: '  ', group_name: ' ' })).toBe('个人势')
    expect(vtuberGroup(null)).toBe('个人势')
  })

  it('「个人势」也能筛：它进选项、且与手填/自动两条来源去重', () => {
    expect(vtuberGroupOptions([
      { faction: '甲', group_name: null },
      { faction: null, group_name: '甲' },        // 与第一条去重（同一企划的两个来源）
      { faction: null, group_name: '乙' },
      { faction: null, group_name: null },        // ⇒ 个人势
      { faction: '丙', group_name: '乙' },
      { faction: PERSONAL_GROUP, group_name: null },   // 手填成同一个词也只出现一次
    ])).toEqual(['甲', '乙', '个人势', '丙'])
  })
})