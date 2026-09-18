import { describe, expect, it } from 'vitest'

import { EMPTY_DRAFT, customAnniversaryItems, draftError, draftToPayload } from './customEntries'
import { anniversaryHero, anniversaryItems } from './anniversary'
import type { VtuberEvent } from '../../api/types'
import type { VTuber } from '../../api/types'

const ev = (patch: Partial<VtuberEvent>): VtuberEvent => ({
  id: 1, vtuber_id: 1, title: '某纪念日', event_date: '2026-03-14',
  kind: 'anniversary', emoji: null, created_at: null, ...patch,
})

const vt = (patch: Partial<VTuber>): VTuber => ({
  id: 1, name: 'V', birthday: null, debut_date: null, sign_override: null,
  sign_source_account_id: null, accounts: [], faction: null, notes: null,
  avatar: null, background_path: null, ...patch,
} as VTuber)

/** R42（用户 2026-09-19）：「纪念日卡片开放给用户自行添加纪念日，可以自定义名称、日期、emoji」 */

describe('自定义条目：表单校验', () => {
  it('名称空 ⇒ 报错', () => {
    expect(draftError({ ...EMPTY_DRAFT, event_date: '2026-03-14' })).toBe('名称不能为空')
  })

  it('日期格式不对 ⇒ 报错', () => {
    expect(draftError({ title: 'x', event_date: '2026/3/14', emoji: '' })).toBe('日期要选（YYYY-MM-DD）')
    expect(draftError({ title: 'x', event_date: '', emoji: '' })).toBe('日期要选（YYYY-MM-DD）')
  })

  it('**不存在的日期**也要拦住（2 月 30 日这种）', () => {
    expect(draftError({ title: 'x', event_date: '2026-02-30', emoji: '' })).toBe('这个日期不存在')
    expect(draftError({ title: 'x', event_date: '2026-02-28', emoji: '' })).toBeNull()
  })

  it('合法草稿 ⇒ 无错，且 emoji 空串转成 null（别把空串写进库）', () => {
    const d = { title: '  生日  ', event_date: '2026-03-14', emoji: '  ' }
    expect(draftError(d)).toBeNull()
    expect(draftToPayload(d)).toEqual({ title: '生日', event_date: '2026-03-14', emoji: null })
  })

  it('emoji 保留原文（去掉首尾空格）', () => {
    expect(draftToPayload({ title: 'x', event_date: '2026-01-01', emoji: ' 🎂 ' }).emoji).toBe('🎂')
  })
})

describe('自定义条目：并进纪念日那一套', () => {
  const today = new Date(2026, 2, 1)      // 2026-03-01

  it('解析日期 + 算天数 + 带 emoji', () => {
    const out = customAnniversaryItems([ev({ id: 7, title: '生日', event_date: '2000-03-14', emoji: '🎂' })], today)
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('custom-7')
    expect(out[0].label).toBe('生日')
    expect(out[0].days).toBe(13)
    expect(out[0].emoji).toBe('🎂')
    expect(out[0].fact).toBe('3/14 · 第 26 周年')
  })

  it('没填年份 ⇒ 只算月日循环，不带"第 N 周年"', () => {
    const out = customAnniversaryItems([ev({ event_date: '03-14' })], today)
    expect(out[0].nth).toBe(0)
    expect(out[0].fact).toBe('3/14')
  })

  it('日期解析不出的条目**跳过**（不显示一行假的）', () => {
    const out = customAnniversaryItems([ev({ event_date: '不知道' })], today)
    expect(out).toEqual([])
  })

  it('**自定义纪念日参与 hero 倒数**（用户加了生日却不倒数 = 看着像没生效）', () => {
    const v = vt({ birthday: '2000-09-01' })          // 内置：还有 184 天
    const custom = customAnniversaryItems([ev({ event_date: '2000-03-05' })], today)  // 还有 4 天
    const all = [...anniversaryItems(v, today), ...custom]
    const hero = anniversaryHero(all)
    expect(hero?.caption).toBe('距离某纪念日')         // 最近的被自定义那条抢到了
    expect(hero?.value).toBe('4')
  })
})
