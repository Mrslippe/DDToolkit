import { describe, expect, it } from 'vitest'
import type { Account, VTuber } from '../api/types'
import { resolveAvatar } from './avatarSource'

const acc = (over: Partial<Account> = {}): Account => ({
  id: 1, platform: 'bilibili', platform_uid: '100', display_name: null, sign: null,
  avatar_url: null, avatar_path: null, ...over,
} as Account)

const vt = (over: Partial<VTuber> = {}): VTuber => ({
  id: 7, name: '七海', faction: null, birthday: null, debut_date: null, setting: null,
  avatar: null, background_path: null, notes: null, sign_override: null,
  sign_source_account_id: null, created_at: null, updated_at: null, accounts: [], ...over,
} as VTuber)

describe('resolveAvatar — 自定义 → B 站缓存 → 任一缓存 → B 站 URL → 任一 URL', () => {
  it('档案设置选过的头像（vtubers.avatar）最高优先，且原样使用（不过 resolveAsset）', () => {
    const v = vt({ avatar: 'https://i0.hdslb.com/bfs/face/custom.jpg' })
    const accounts = [acc({ avatar_path: 'static/avatars/100.jpg', avatar_url: 'https://x/plat.jpg' })]
    expect(resolveAvatar(v, accounts)).toBe('https://i0.hdslb.com/bfs/face/custom.jpg')
  })

  it('自定义为空/全空白 ⇒ 回落平台头像（空串不能当成"有自定义"）', () => {
    expect(resolveAvatar(vt({ avatar: '   ' }), [acc({ avatar_url: 'https://x/p.jpg' })]))
      .toContain('https://x/p.jpg')
  })

  it('没有自定义时：B 站的本地缓存优先于远端 URL', () => {
    const accounts = [
      acc({ platform: 'weibo', platform_uid: 'w1', avatar_url: 'https://w/a.jpg' }),
      acc({ platform: 'bilibili', platform_uid: '100', avatar_path: 'static/avatars/100.jpg',
            avatar_url: 'https://b/a.jpg' }),
    ]
    expect(resolveAvatar(vt(), accounts)).toContain('static/avatars/100.jpg')
  })

  it('B 站没有缓存时：用任一账号的缓存（离线优先）', () => {
    const accounts = [
      acc({ platform: 'weibo', platform_uid: 'w1', avatar_path: 'static/avatars/w1.jpg' }),
      acc({ platform: 'bilibili', platform_uid: '100', avatar_url: 'https://b/a.jpg' }),
    ]
    expect(resolveAvatar(vt(), accounts)).toContain('static/avatars/w1.jpg')
  })

  it('都没有缓存 ⇒ 先 B 站 URL，再任一 URL', () => {
    expect(resolveAvatar(vt(), [
      acc({ platform: 'weibo', platform_uid: 'w1', avatar_url: 'https://w/a.jpg' }),
      acc({ platform: 'bilibili', platform_uid: '100', avatar_url: 'https://b/a.jpg' }),
    ])).toBe('https://b/a.jpg')
    expect(resolveAvatar(vt(), [
      acc({ platform: 'weibo', platform_uid: 'w1', avatar_url: 'https://w/a.jpg' }),
    ])).toBe('https://w/a.jpg')
  })

  it('什么都没有 ⇒ undefined（交给 Fallback 显示首字，而不是空 src）', () => {
    expect(resolveAvatar(vt(), [])).toBeUndefined()
    expect(resolveAvatar(null, [])).toBeUndefined()
    expect(resolveAvatar(vt(), [acc({ platform_uid: '' })])).toBeUndefined()
  })
})
