import { describe, expect, it } from 'vitest'
import {
  allGroupsEmpty,
  biliToCandidates,
  followerLabel,
  groupNote,
  groupsToCandidates,
  inputLooksLikeUid,
  mergeCandidates,
  originLabel,
  poolToCandidates,
} from './addVtuberSearch'
import type { BiliSearchItem, NameSearchGroup, PoolItem } from '../api/types'

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
  it('纯数字且 5~20 位才走 UID 直查（与后端同口径）', () => {
    expect(inputLooksLikeUid('1265680561')).toBe(true)
    expect(inputLooksLikeUid(' 896830 ')).toBe(true)     // 早期 6 位 uid + 首尾空格
    // ⚠️ 16 位是 B 站新 mid 的常态（devlog/378）：卡在 12 位会让这类 uid 退化成关键词搜索，
    //    而搜索接口搜不到 uid ⇒ 用户看到的是"搜不到这个人"。
    expect(inputLooksLikeUid('3537112928356578')).toBe(true)
    expect(inputLooksLikeUid('1234')).toBe(false)        // 太短：更像名字里的数字
    expect(inputLooksLikeUid('塔菲')).toBe(false)
    expect(inputLooksLikeUid('1265680561a')).toBe(false)
    expect(inputLooksLikeUid('1'.repeat(21))).toBe(false) // 上界仍在
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
    // 池内那条走池内路径（名称以服务端池为准）
    expect(rows[0].adoptSource).toBe('pool')
    expect(rows[0].adoptable).toBe(true)
    // 本地接口已剔除已入库
    expect(rows.every((r) => r.inLibrary === false)).toBe(true)
  })

  it('索引来源必须走**池外通道**：它不在 csv 池里，报 pool 必被后端 404', () => {
    // 2026-09-15 用户实测：`thirdparty_vtubers` 是"池快照之后的新 V"，
    // 实测抽样 200 条里有 3 条不在 vtubers.csv —— 这些行带 source='pool' 时，
    // 后端 find_in_pool miss ⇒ 404「候选池中不存在该 platform_uid」
    const rows = poolToCandidates([pool[1]])
    expect(rows[0].adoptSource).toBe('bilibili')     // → 后端实查 acc/info 复核后建库
    expect(rows[0].adoptable).toBe(true)
  })

  it('索引里的非 B 站条目不能收录（池外通道只支持 bilibili）→ 置灰 + 原因', () => {
    const rows = poolToCandidates([
      { name: '索引微博V', platform: 'weibo', platform_uid: '888', origin: 'index' },
    ])
    expect(rows[0].adoptable).toBe(false)
    expect(rows[0].adoptSource).toBe('pool')         // 不带 bilibili，避免撞后端 400
    expect(rows[0].blockedReason).toContain('不在候选池')
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

  it('来源徽标：在线检索那一档按平台给名（B1 起有四家）', () => {
    expect(originLabel('weibo')).toBe('微博')
    expect(originLabel('xiaohongshu')).toBe('小红书')
    expect(originLabel('douyin')).toBe('抖音')
  })
})

/**
 * 多平台检索（B1，需求 8，`devlog/463`）。
 *
 * 这三个纯函数决定界面上最容易**说出错话**的三处：
 * 什么时候该说「没找到」、每个平台那一行说什么、四家的结果怎么合并成行。
 */
describe('多平台检索结果 → 展示行与状态', () => {
  const grp = (over: Partial<NameSearchGroup> = {}): NameSearchGroup => ({
    platform: 'bilibili', label: 'B 站', items: [], error: null, hint: null,
    skipped: false, best_match_only: false, ...over,
  })

  it('★ 四家的条目按**后端给的顺序**合并（前端不重排）', () => {
    const rows = groupsToCandidates([
      grp({ platform: 'bilibili', label: 'B 站', items: [bili()] }),
      grp({ platform: 'weibo', label: '微博',
            items: [bili({ platform: 'weibo', platform_uid: '7198559139', name: '微博的她' })] }),
      grp({ platform: 'xiaohongshu', label: '小红书',
            items: [bili({ platform: 'xiaohongshu', platform_uid: 'xhs1', name: '小红书的她' })] }),
    ])
    expect(rows.map((r) => r.platform)).toEqual(['bilibili', 'weibo', 'xiaohongshu'])
    // 收录来源 = 它自己的平台名（池外通道从 B1 起四家都支持）
    expect(rows.map((r) => r.adoptSource))
      .toEqual(['bilibili', 'weibo', 'xiaohongshu'])
    expect(rows.every((r) => r.adoptable)).toBe(true)
  })

  it('同 uid 跨平台**不算重复**（key 里带平台，两家的 100 是两个人）', () => {
    const rows = groupsToCandidates([
      grp({ items: [bili({ platform_uid: '100' })] }),
      grp({ platform: 'weibo', label: '微博',
            items: [bili({ platform: 'weibo', platform_uid: '100', name: '微博的' })] }),
    ])
    expect(rows.map((r) => r.key)).toEqual(['bilibili:100', 'weibo:100'])
  })

  it('★ 只有"发了、没报错、没被跳过、真没结果"才算没找到', () => {
    expect(allGroupsEmpty([grp(), grp({ platform: 'weibo', label: '微博' })])).toBe(true)
    // 关着开关 ⇒ **不许**说"没找到"（那是把用户的设置说成"没这个人"）
    expect(allGroupsEmpty([grp({ skipped: true, hint: '已关闭' })])).toBe(false)
    // 报错（没登录/风控）同理
    expect(allGroupsEmpty([grp({ error: 'not_logged_in' })])).toBe(false)
    // 还没搜过 / 空数组 ⇒ 也不是"没找到"
    expect(allGroupsEmpty(null)).toBe(false)
    expect(allGroupsEmpty([])).toBe(false)
    // 有结果当然不是
    expect(allGroupsEmpty([grp({ items: [bili()] })])).toBe(false)
  })

  it('★ 每行状态：关着 / 失败 / 没结果 / 命中几条 / 只给一条，五态分得开', () => {
    expect(groupNote(grp({ skipped: true, hint: '「抖音」的抓取已关闭' })))
      .toEqual({ text: '「抖音」的抓取已关闭', tone: 'muted' })
    expect(groupNote(grp({ error: 'not_logged_in', hint: '去登录' })))
      .toEqual({ text: '去登录', tone: 'err' })
    // 后端没给 hint 时也不能空着（说自己那句，但仍然算"错"）
    expect(groupNote(grp({ platform: 'weibo', label: '微博', error: 'network_error' })))
      .toEqual({ text: '微博检索没取到结果', tone: 'err' })
    expect(groupNote(grp({ error: null, items: [] })))
      .toEqual({ text: 'B 站没有匹配', tone: 'muted' })
    expect(groupNote(grp({ items: [bili(), bili({ platform_uid: '2' })] })))
      .toEqual({ text: 'B 站命中 2 条', tone: 'ok' })
    // 微博只回最匹配的一条：说清是**接口形态**，别让人以为"全网就一个"
    expect(groupNote(grp({ platform: 'weibo', label: '微博', best_match_only: true,
                           items: [bili({ platform: 'weibo' })] })))
      .toEqual({ text: '微博命中 1 条（该接口只给最匹配的一个）', tone: 'ok' })
  })
})
