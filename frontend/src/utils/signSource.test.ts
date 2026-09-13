import { describe, expect, it } from 'vitest'

import { heroAccount, resolveSign } from './signSource'
import type { Account, VTuber } from '../api/types'

/**
 * 卡片签名的解析链（devlog/074）。三条规则各断一条 —— 错了都**不会报错**，
 * 只会让卡片显示的签名不是你以为的那个：
 * ① 覆盖优先；② 来源失效/未设 → 回落主账号（不是显示空）；③ 空串归一化。
 */
const acc = (id: number, platform: string, sign: string | null,
             uid = String(id)): Account =>
  ({ id, platform, sign, platform_uid: uid }) as Account

const vt = (patch: Partial<VTuber>): VTuber =>
  ({ id: 1, name: 'V', sign_override: null, sign_source_account_id: null, ...patch }) as VTuber

describe('heroAccount — 主账号口径', () => {
  it('B 站优先，其次首个有 uid 的账号', () => {
    expect(heroAccount([acc(1, 'weibo', 'w'), acc(2, 'bilibili', 'b')])?.id).toBe(2)
    expect(heroAccount([acc(1, 'weibo', 'w', ''), acc(2, 'twitter', 't')])?.id).toBe(2)
    expect(heroAccount([])).toBeNull()
  })
})

describe('resolveSign — 覆盖 → 来源账号 → 主账号', () => {
  const accounts = [acc(1, 'bilibili', 'B站签名'), acc(2, 'weibo', '微博签名')]

  it('未设任何东西 → 主账号（B 站）', () => {
    expect(resolveSign(vt({}), accounts)).toEqual(
      { text: 'B站签名', from: 'account', accountId: 1 })
  })

  it('设了来源 → 跟随那个账号（且不改它的签名）', () => {
    const r = resolveSign(vt({ sign_source_account_id: 2 }), accounts)
    expect(r).toEqual({ text: '微博签名', from: 'account', accountId: 2 })
    expect(accounts[1].sign).toBe('微博签名')      // 只读：解析不改数据
  })

  it('覆盖优先于来源', () => {
    const r = resolveSign(vt({ sign_override: '自定义', sign_source_account_id: 2 }), accounts)
    expect(r).toEqual({ text: '自定义', from: 'override', accountId: null })
  })

  it('来源账号被删 / 指向不存在的 id → 回落主账号（不是空）', () => {
    expect(resolveSign(vt({ sign_source_account_id: 999 }), accounts).accountId).toBe(1)
  })

  it('空串 / 空白覆盖不算覆盖', () => {
    expect(resolveSign(vt({ sign_override: '   ' }), accounts).from).toBe('account')
  })

  it('谁都没有签名 → none', () => {
    expect(resolveSign(vt({}), [acc(1, 'bilibili', null), acc(2, 'weibo', '  ')])).toEqual(
      { text: '', from: 'none', accountId: null })
    expect(resolveSign(vt({}), [])).toEqual({ text: '', from: 'none', accountId: null })
  })
})
