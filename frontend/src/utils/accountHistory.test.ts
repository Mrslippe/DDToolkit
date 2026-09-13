import { describe, expect, it } from 'vitest'
import { formerForAccount, liveStatusLabel, snapshotSourceLabel, snapshotVisibleFields } from './accountHistory'
import type { AccountStatSnapshot, VTuberFormerValues } from '../api/types'

/**
 * R9（devlog/080）：账号信息历史弹窗的纯逻辑。
 *
 * 这几条判定的共同点是**判断错了界面也不会报错**（少显示一行、把"未记录"显示成"离线"），
 * 所以必须靠断言钉住。
 */
const former = (accountId: number | null, value: string, platform: string | null = 'weibo') => ({
  value, platform, account_id: accountId, changed_at: '2026-09-13T10:00:00+00:00',
})

const snap = (over: Partial<AccountStatSnapshot> = {}): AccountStatSnapshot => ({
  id: 1, account_id: 7, followers_count: 12345, live_status: 0,
  live_title: '旧标题', captured_at: '2026-09-13T10:00:00+00:00', source: 'self', ...over,
})

describe('formerForAccount：V 级曾用值按账号过滤', () => {
  const data: VTuberFormerValues = {
    names: [former(7, '旧昵称A'), former(9, '旧昵称B'), former(null, '已移除账号的旧昵称')],
    signs: [former(7, '旧签名A')],
  }

  it('只留该账号的行，并统计"其它账号"条数', () => {
    const r = formerForAccount(data, 7)
    expect(r.names.map((f) => f.value)).toEqual(['旧昵称A'])
    expect(r.signs.map((f) => f.value)).toEqual(['旧签名A'])
    expect(r.otherCount).toBe(2)          // 9 号账号 + 已移除账号
  })

  it('account_id 为空（未指定账号）时不过滤', () => {
    const r = formerForAccount(data, null)
    expect(r.names).toHaveLength(3)
    expect(r.otherCount).toBe(0)
  })

  it('没数据/加载失败时给空结构而不是崩', () => {
    expect(formerForAccount(null, 7)).toEqual({ names: [], signs: [], otherCount: 0 })
  })
})

describe('快照字段的展示口径', () => {
  it('来源标注：self=自采、zeroroku 原样、未知不装懂', () => {
    expect(snapshotSourceLabel('self')).toBe('自采')
    expect(snapshotSourceLabel('zeroroku')).toBe('zeroroku')
    expect(snapshotSourceLabel('')).toBe('未知来源')
  })

  it('live_status：null 是"未记录"，不能显示成"离线"', () => {
    expect(liveStatusLabel(null)).toBeNull()
    expect(liveStatusLabel(0)).toBe('离线')
    expect(liveStatusLabel(1)).toBe('直播中')
  })

  it('开播标题只在"直播中"时展示（离线快照带的是残留标题）', () => {
    expect(snapshotVisibleFields(snap({ live_status: 1, live_title: '歌回' })).title).toBe('歌回')
    expect(snapshotVisibleFields(snap({ live_status: 0, live_title: '残留' })).title).toBeNull()
    expect(snapshotVisibleFields(snap({ live_status: 1, live_title: null })).title).toBeNull()
  })

  it('粉丝数按千分位展示；缺值不显示 0', () => {
    expect(snapshotVisibleFields(snap({ followers_count: 12345 })).followers).toBe('12,345')
    expect(snapshotVisibleFields(snap({ followers_count: null })).followers).toBeNull()
  })
})
