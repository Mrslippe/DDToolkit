/**
 * 账号快照的**认人**口径（2026-10-10 自审 F7，`devlog/461`）。
 *
 * ## 修的是什么
 *
 * 全站的账号身份是 `platform:platform_uid`（`useSelectedAccount.accountKeyOf` 明写了这条），
 * 而"抓取完成快照"这一路**只比 uid** —— B 站 mid 与微博 uid **都是纯数字串**，
 * 撞号就会把另一个平台那个人的昵称/签名/头像/直播状态并进这个账号。
 * 症状是自相矛盾的那种：左栏"直播中"、右栏"未开播"。
 *
 * ⚠️ 真机当前**没有**撞号的账号，所以这条是"口径隐患"而不是"线上故障" ——
 * 但正因如此，只有用例能拦住它（肉眼永远看不到）。
 */
import { describe, expect, it } from 'vitest'

import type { Account, AccountSnapshot } from '../api/types'
import { mergeAccountSnapshots, mergeVtuberSnapshots, snapshotKey } from './accountSnapshots'

const acc = (platform: string, uid: string): Account => ({
  id: 1, vtuber_id: 1, platform, platform_uid: uid,
  display_name: '旧昵称', sign: '旧签名', followers_count: 100,
  live_status: 0, live_title: null, avatar_path: null,
} as unknown as Account)

const snap = (platform: string, uid: string, over: Partial<AccountSnapshot> = {}):
AccountSnapshot => ({
  platform, platform_uid: uid, display_name: '新昵称', sign: null,
  followers_count: null, live_status: 1, live_title: '开播了', avatar_path: null,
  ...over,
})

describe('账号快照的认人（platform:platform_uid）', () => {
  it('★ 同一个 uid、**不同平台** ⇒ 不许合并（这就是那个撞号）', () => {
    const mine = acc('bilibili', '12345')
    const other = snap('weibo', '12345', { display_name: '微博上的另一个人', live_status: 1 })
    expect(mergeAccountSnapshots(mine, [other]),
           '只比 uid ⇒ 微博那位的昵称/直播态被并进了 B 站这个账号').toBeNull()
  })

  it('平台与 uid 都对上才合并（正对照：别把这条判据修成"永不合并"）', () => {
    const mine = acc('bilibili', '12345')
    const hit = mergeAccountSnapshots(mine, [snap('bilibili', '12345')])
    expect(hit).not.toBeNull()
    expect(hit!.display_name).toBe('新昵称')
    expect(hit!.live_status).toBe(1)
  })

  it('多平台混在一批里也只挑自己那条', () => {
    const mine = acc('bilibili', '777')
    const merged = mergeAccountSnapshots(mine, [
      snap('weibo', '777', { display_name: '微博的' }),
      snap('bilibili', '777', { display_name: '自己的' }),
      snap('douyin', '777', { display_name: '抖音的' }),
    ])
    expect(merged!.display_name).toBe('自己的')
  })

  it('uid 相同但平台不同时，账号原样不动（引用都不换）', () => {
    const v = { id: 1, name: 'V', accounts: [acc('bilibili', '999')] } as never
    const out = mergeVtuberSnapshots(v, [snap('weibo', '999')])
    expect(out).toBe(v)          // 未命中 ⇒ 原引用（调用方据此跳过重渲染）
  })

  it('`snapshotKey` 就是那个二元组（与 `accountKeyOf` 同口径）', () => {
    expect(snapshotKey('bilibili', '12345')).toBe('bilibili:12345')
    expect(snapshotKey('weibo', '12345')).not.toBe(snapshotKey('bilibili', '12345'))
  })
})
