import { describe, expect, it } from 'vitest'
import { applyVtuberUpdate } from './vtuberList'
import type { VTuber } from '../api/types'

const vt = (patch: Partial<VTuber>): VTuber => ({
  id: 1, name: 'V', sign_override: null, sign_source_account_id: null,
  accounts: [], faction: null, notes: null, avatar: null, background_path: null,
  ...patch,
} as VTuber)

describe('左栏列表就地更新（R33 补）', () => {
  it('按 id 命中并覆盖新值', () => {
    const list = [vt({ id: 1, name: 'A' }), vt({ id: 2, name: 'B' })]
    const out = applyVtuberUpdate(list, vt({ id: 2, name: 'B2', sign_override: '新签名' }))
    expect(out[1].name).toBe('B2')
    expect(out[1].sign_override).toBe('新签名')
    expect(out[0].name).toBe('A')
  })

  it('顺序不变（一次更新不许重排左栏）', () => {
    const list = [vt({ id: 3 }), vt({ id: 1 }), vt({ id: 2 })]
    const out = applyVtuberUpdate(list, vt({ id: 1, name: 'X' }))
    expect(out.map((v) => v.id)).toEqual([3, 1, 2])
  })

  it('更新对象里没带的字段保持原值（快照类字段不被抹掉）', () => {
    const list = [vt({ id: 1, name: 'A', notes: '本地备注' })]
    const out = applyVtuberUpdate(list, { id: 1 } as VTuber)
    expect(out[0].notes).toBe('本地备注')
  })

  it('没命中就原样返回（不新增、不重建数组）', () => {
    const list = [vt({ id: 1 })]
    expect(applyVtuberUpdate(list, vt({ id: 99 }))).toBe(list)
  })

  it('脏输入不炸（null / 没有 id）', () => {
    const list = [vt({ id: 1 })]
    expect(applyVtuberUpdate(list, null)).toBe(list)
    expect(applyVtuberUpdate(list, undefined)).toBe(list)
    expect(applyVtuberUpdate(list, {} as VTuber)).toBe(list)
  })
})
