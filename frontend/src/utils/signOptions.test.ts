import { describe, expect, it } from 'vitest'

import { buildSignOptions } from './signOptions'
import type { Account } from '../api/types'

/**
 * 签名下拉栏的行数据（devlog/072）。三条规则各断一条，外加两条边界。
 * 这些规则错的方向都**不会报错**：空签名进列表是一行空白、主账号没标出来
 * 用户就不知道卡片上的签名取自谁、active 判定错则"当前生效"标错行。
 */
const acc = (id: number, platform: string, sign: string | null): Account =>
  ({ id, platform, sign }) as Account

describe('buildSignOptions', () => {
  it('只列有签名的账号（空白签名不进列表）', () => {
    const rows = buildSignOptions(
      [acc(1, 'bilibili', '晚安'), acc(2, 'weibo', '   '), acc(3, 'weibo', null)],
      null, '',
    )
    expect(rows.map((r) => r.id)).toEqual([1])
  })

  it('主账号标记 + 平台展示名', () => {
    const rows = buildSignOptions(
      [acc(1, 'bilibili', '晚安'), acc(2, 'weibo', '早点休息')], 1, '',
    )
    expect(rows[0]).toMatchObject({ isHero: true, label: 'B站' })
    expect(rows[1]).toMatchObject({ isHero: false, label: '微博' })
  })

  it('未显式选过（输入框为空）→ 主账号即当前项', () => {
    const rows = buildSignOptions(
      [acc(1, 'bilibili', '晚安'), acc(2, 'weibo', '早点休息')], 2, '',
    )
    expect(rows.find((r) => r.active)?.id).toBe(2)
  })

  it('输入框有值 → 与内容相同的那条为当前项（手打一半也跟着动）', () => {
    const rows = buildSignOptions(
      [acc(1, 'bilibili', '晚安'), acc(2, 'weibo', '早点休息')], 1, '早点休息')
    expect(rows.filter((r) => r.active).map((r) => r.id)).toEqual([2])
    // 输入框内容与任何一条都不同 → 一个都不标
    expect(buildSignOptions(
      [acc(1, 'bilibili', '晚安')], 1, '手打的别的').some((r) => r.active)).toBe(false)
  })

  it('没有主账号 / 空账号列表都不炸', () => {
    expect(buildSignOptions([], null, '')).toEqual([])
    const rows = buildSignOptions([acc(1, 'bilibili', '晚安')], null, '')
    expect(rows[0].isHero).toBe(false)
    expect(rows.some((r) => r.active)).toBe(false)
  })

  it('前后空白按内容看待（避免"看着一样却没标"）', () => {
    const rows = buildSignOptions([acc(1, 'bilibili', ' 晚安 ')], 1, '晚安')
    expect(rows[0].active).toBe(true)
    expect(rows[0].sign).toBe('晚安')
  })
})
