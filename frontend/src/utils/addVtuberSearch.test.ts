import { describe, expect, it } from 'vitest'
import {
  biliToCandidates,
  followerLabel,
  inputLooksLikeUid,
  mergeCandidates,
  originLabel,
  poolToCandidates,
} from './addVtuberSearch'
import type { BiliSearchItem, PoolItem } from '../api/types'

/**
 * R11（devlog/083）：添加 V 的两个来源合并判定。
 * 每条判错的代价都是"界面看不出错"：同 uid 出两行、已订阅的没置灰、uid 被当名字搜。
 */
const pool: PoolItem[] = [
  { name: '永雏塔菲', platform: 'bilibili', platform_uid: '1265680561', origin: 'pool' },
  { name: '索引新V', platform: 'bilibili', platform_uid: '777777', origin: 'index', group: '某企划' },
]

const bili = (over: Partial<BiliSearchItem> = {}): BiliSearchItem => ({
  platform: 'bilibili', platform_uid: '1265680561', name: '永雏塔菲（搜索）', sign: '',
  followers: 2753531, avatar: '', verified: '', is_live: false, room_id: null,
  videos: 0, level: 6, exact: false, in_library: false, ...over,
})

describe('输入分流：UID vs 名称', () => {
  it('纯数字且 5~12 位才走 UID 直查（与后端同口径）', () => {
    expect(inputLooksLikeUid('1265680561')).toBe(true)
    expect(inputLooksLikeUid(' 896830 ')).toBe(true)     // 早期 6 位 uid + 首尾空格
    expect(inputLooksLikeUid('1234')).toBe(false)        // 太短：更像名字里的数字
    expect(inputLooksLikeUid('塔菲')).toBe(false)
    expect(inputLooksLikeUid('1265680561a')).toBe(false)
    expect(inputLooksLikeUid('')).toBe(false)
  })
})

describe('本地两类来源', () => {
  it('池与索引各自带上来源与收录路径；同 uid 只留第一条（池优先）', () => {
    const rows = poolToCandidates([
      ...pool,
      { name: '重复的索引条目', platform: 'bilibili', platform_uid: '1265680561', origin: 'index' },
    ])
    expect(rows.map((r) => r.name)).toEqual(['永雏塔菲', '索引新V'])
    expect(rows[0].origin).toBe('pool')
    expect(rows[1].origin).toBe('index')
    expect(rows[1].group).toBe('某企划')
    // 本地两类都走池内收录路径（名称以服务端池为准）
    expect(rows.every((r) => r.adoptSource === 'pool')).toBe(true)
    expect(rows.every((r) => r.inLibrary === false)).toBe(true)   // 本地接口已剔除已入库
  })
})

describe('合并两个来源', () => {
  it('本地优先：同 uid 的在线结果被丢弃，其余在线结果补齐在后面', () => {
    const local = poolToCandidates(pool)
    const online = biliToCandidates([
      bili(),                                                   // 与池内同 uid → 丢弃
      bili({ platform_uid: '999', name: '只在线有', in_library: true }),
    ])
    const merged = mergeCandidates(local, online)
    expect(merged.map((r) => r.name)).toEqual(['永雏塔菲', '索引新V', '只在线有'])
    expect(merged[0].adoptSource).toBe('pool')                  // 本地那条保留
    expect(merged[2].adoptSource).toBe('bilibili')
    expect(merged[2].inLibrary).toBe(true)                      // 已订阅：置灰依据
    expect(merged[2].verified).toBeUndefined()
  })
})

describe('展示口径', () => {
  it('粉丝数：万粉折算、0 不显示（0 看起来像小号）', () => {
    expect(followerLabel(2753531)).toBe('275.4 万粉')
    expect(followerLabel(12345)).toBe('1.2 万粉')
    expect(followerLabel(999)).toBe('999 粉')
    expect(followerLabel(0)).toBeNull()
    expect(followerLabel(undefined)).toBeNull()
  })

  it('来源徽标三种', () => {
    expect(originLabel('pool')).toBe('候选池')
    expect(originLabel('index')).toBe('索引')
    expect(originLabel('bilibili')).toBe('B 站')
  })
})
