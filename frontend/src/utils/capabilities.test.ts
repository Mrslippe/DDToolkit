import { describe, expect, it } from 'vitest'
import type { Capabilities, CapabilityFeature } from '../api/types'
import {
  FETCH_POSTS,
  WEIBO_CONTENT,
  availableSummary,
  featureOf,
  isDegraded,
  isLoginRequired,
  limitOf,
  limitText,
  limitsSummary,
  loginActionLabel,
} from './capabilities'

/**
 * 能力矩阵的界面判定（devlog/086）。
 * 每条判错的代价都是"界面说错话"：限制没标出来（用户点了才发现不行）、
 * 或者把 `degraded` 说成不可用（白白劝退）。
 */
const feature = (over: Partial<CapabilityFeature>): CapabilityFeature => ({
  id: 'x', label: 'X', platform: null, anon_state: 'full', anon_note: '未登录说明',
  login_note: '', evidence: '实测 2026-09-15', state: 'full', note: '当前说明', ...over,
})

const anonCaps = (): Capabilities => ({
  bilibili_logged_in: false,
  weibo_logged_in: false,
  wbi: { cached: true, anonymous: true },
  features: [
    feature({ id: 'browse_local', label: '浏览与搜索已归档内容', state: 'full' }),
    feature({ id: 'account_info', label: '账号信息', state: 'degraded', note: '会被间歇性风控' }),
    feature({ id: FETCH_POSTS, label: '抓取投稿与动态内容', platform: 'bilibili',
              anon_state: 'requires_login', state: 'requires_login', note: '需要登录 B 站' }),
    feature({ id: WEIBO_CONTENT, label: '微博内容', platform: 'weibo',
              anon_state: 'requires_login', state: 'requires_login', note: '需要微博登录' }),
  ],
  limited: [
    { id: 'account_info', label: '账号信息', state: 'degraded', note: '会被间歇性风控' },
    { id: FETCH_POSTS, label: '抓取投稿与动态内容', state: 'requires_login', note: '需要登录 B 站' },
    { id: WEIBO_CONTENT, label: '微博内容', state: 'requires_login', note: '需要微博登录' },
  ],
  measured_at: '2026-09-15',
})

describe('限制查询', () => {
  it('按 id 取限制与能力；没有限制时返回 null', () => {
    const caps = anonCaps()
    expect(limitOf(caps, FETCH_POSTS)?.state).toBe('requires_login')
    expect(limitOf(caps, 'browse_local')).toBeNull()
    expect(featureOf(caps, 'browse_local')?.label).toBe('浏览与搜索已归档内容')
    expect(featureOf(null, 'x')).toBeNull()
    expect(limitOf(null, 'x')).toBeNull()
  })

  it('requires_login 与 degraded 分开判定（后者不该被说成不可用）', () => {
    const caps = anonCaps()
    expect(isLoginRequired(caps, FETCH_POSTS)).toBe(true)
    expect(isDegraded(caps, FETCH_POSTS)).toBe(false)
    expect(isLoginRequired(caps, 'account_info')).toBe(false)
    expect(isDegraded(caps, 'account_info')).toBe(true)
    expect(isLoginRequired(caps, 'browse_local')).toBe(false)
  })
})

describe('文案', () => {
  it('顶栏一句话：未登录时带前缀，全可用时为空串（不渲染入口）', () => {
    expect(limitsSummary(anonCaps())).toBe('未登录 · 3 项受限')
    const allGood = { ...anonCaps(), limited: [], bilibili_logged_in: true, weibo_logged_in: true }
    expect(limitsSummary(allGood)).toBe('')
    expect(limitsSummary(null)).toBe('')
  })

  it('登录按钮文案随平台登录态变化', () => {
    expect(loginActionLabel(anonCaps())).toBe('登录 B 站 / 微博')
    expect(loginActionLabel({ ...anonCaps(), bilibili_logged_in: true })).toBe('登录微博')
    expect(loginActionLabel({ ...anonCaps(), weibo_logged_in: true })).toBe('登录 B 站')
    expect(loginActionLabel(null)).toBe('登录')
  })

  it('限制行文案来自后端 note（不在前端另编一套）', () => {
    expect(limitText(anonCaps(), FETCH_POSTS)).toBe('需要登录 B 站')
    expect(limitText(anonCaps(), 'browse_local')).toBe('')
  })

  it('"现在还能做什么"只列 full 的功能 —— 不许只列不能做的', () => {
    expect(availableSummary(anonCaps())).toEqual(['浏览与搜索已归档内容'])
    expect(availableSummary(null)).toEqual([])
  })
})
