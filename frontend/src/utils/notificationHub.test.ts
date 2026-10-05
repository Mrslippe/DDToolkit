import { describe, expect, it } from 'vitest'
import type { Notice } from './notificationHub'
import {
  KIND_GLYPH,
  KIND_PRIORITY,
  LIVE_NOTICE_MS,
  composeTaskText,
  isLive,
  liveNotice,
  liveNotices,
  loginNotice,
  messageNotice,
  pickPrimary,
  progressNotice,
  rateLimitNotice,
  reportNotice,
} from './notificationHub'

/**
 * 顶栏通知中心的判定（R12a，devlog/089）。
 * 三个"界面说错话"的错法各有对应用例：自动节拍占顶栏 / 瞬时消息压过进度 / 过期条目不清。
 */
const n = (over: Partial<Notice>): Notice => ({
  id: 'x', kind: 'message', text: 't', ...over,
})

describe('优先级与挑选', () => {
  it('告警 > 进度 > 报告 > 瞬时消息', () => {
    const list = [
      n({ id: 'm', kind: 'message' }),
      n({ id: 'r', kind: 'report' }),
      n({ id: 'p', kind: 'progress' }),
      n({ id: 'a', kind: 'alert' }),
    ]
    expect(pickPrimary(list, 0)?.id).toBe('a')
    expect(pickPrimary(list.filter((x) => x.kind !== 'alert'), 0)?.id).toBe('p')
    expect(pickPrimary(list.filter((x) => x.kind === 'report' || x.kind === 'message'), 0)?.id)
      .toBe('r')
  })

  it('**瞬时消息压不过正在跑的任务**（用户在抓取途中要看得到进度）', () => {
    const list = [n({ id: 'p', kind: 'progress' }), n({ id: 'm', kind: 'message' })]
    expect(KIND_PRIORITY.progress).toBeGreaterThan(KIND_PRIORITY.message)
    expect(pickPrimary(list, 0)?.id).toBe('p')
  })

  it('同级取最新（来源按时间追加）', () => {
    const list = [n({ id: 'old', kind: 'progress' }), n({ id: 'new', kind: 'progress' })]
    expect(pickPrimary(list, 0)?.id).toBe('new')
  })

  it('空列表 → null（空闲态：只有一个绿点，无容器）', () => {
    expect(pickPrimary([], 0)).toBeNull()
  })
})

describe('过期', () => {
  it('瞬时消息到点自动消失；常驻条目不受时间影响', () => {
    const msg = n({ id: 'm', kind: 'message', expiresAt: 1000 })
    const sticky = n({ id: 's', kind: 'alert', sticky: true })
    expect(isLive(msg, 999)).toBe(true)
    expect(isLive(msg, 1001)).toBe(false)
    expect(isLive(sticky, 10 ** 12)).toBe(true)
    expect(liveNotices([msg, sticky], 1001).map((x) => x.id)).toEqual(['s'])
  })

  it('风控冷却告警带 expiresAt = 冷却结束时刻（到点自己消失，不需要额外清理）', () => {
    const rl = rateLimitNotice({ active: true, reason: 'code=-352', seconds_left: 600 }, 1_000_000)
    expect(rl?.expiresAt).toBe(1_000_000 + 600_000)
    expect(isLive(rl!, 1_599_000)).toBe(true)
    expect(isLive(rl!, 1_600_001)).toBe(false)
    expect(rateLimitNotice({ active: false, reason: '', seconds_left: 0 }, 0)).toBeNull()
    expect(rateLimitNotice(null, 0)).toBeNull()
  })
})

/**
 * 「没有过期时刻」在**服务端那份**里是 `null`，不是 `undefined`（2026-10-06，devlog/357）。
 *
 * 用户报的现场：点了「全量拉取第三方数据」，面板里**没有**那条「正在同步…」，
 * 而计数写着 `通知（2）`（画出来的只有 1 条）。
 * 真因就在这一格：后端 `NoticeOut.expiresAt: int | None` 把 None 序列化成 **JSON `null`**，
 * 而 `isLive` 原来只认 `undefined`（`null === undefined` 为假、`null > now` 也是假）
 * ⇒ 服务端每一条**没有 TTL 的状态条目**（三个进度条目都是）被判成"已过期"：
 * 面板把它滤掉，而 `.si-count` / `通知（N）` 数的还是原始数组长度。
 *
 * ⚠️ 判据必须**照着真实 JSON 的键写**（`expiresAt: null`），不能用 `undefined`
 * —— 后者是"没这个键"，那是另一回事（老后端）。
 */
describe('服务端那份的空过期时刻（JSON `null`，不是 `undefined`）', () => {
  const serverState = (over: Partial<Notice> = {}): Notice => ({
    id: 'progress-external', kind: 'progress', form: 'state', source: '第三方同步',
    text: '正在同步第三方数据（全量）', sticky: false,
    // 与 `GET /vtuber/notices` 回来的一模一样（实测原始响应见 devlog/357）
    expiresAt: null, createdAt: 1_000, ...over,
  })

  it('`expiresAt: null` = 没有过期时刻 ⇒ **一直算活着**', () => {
    expect(isLive(serverState(), 10 ** 12)).toBe(true)
    expect(liveNotices([serverState()], 10 ** 12)).toHaveLength(1)
  })

  it('真给了数字就照数字判（null 那一档不许把 TTL 一起放行）', () => {
    expect(isLive(serverState({ expiresAt: 2_000 }), 1_999)).toBe(true)
    expect(isLive(serverState({ expiresAt: 2_000 }), 2_001)).toBe(false)
  })

  it('`NaN` / `Infinity` 这类脏值也不许判成"已过期"（宁可多显示，不许静默吞掉）', () => {
    expect(isLive(serverState({ expiresAt: Number.NaN }), 10 ** 12)).toBe(true)
    expect(isLive(serverState({ expiresAt: Number.POSITIVE_INFINITY }), 10 ** 12)).toBe(true)
  })
})

describe('进度条目：自动节拍不占顶栏（2026-09-10 用户口径）', () => {
  it('auto=true（动态流/自动账号流）直接不产生条目', () => {
    expect(progressNotice({ id: 'p', running: true, auto: true, text: '动态轮询中 - V - 1/7' }))
      .toBeNull()
  })

  it('手动/收录/外部批次照常出现', () => {
    const p = progressNotice({ id: 'p', running: true, auto: false, text: '全量抓取中 - V - 2/7' })
    expect(p?.kind).toBe('progress')
    expect(progressNotice({ id: 'p', running: false, auto: false, text: 'x' })).toBeNull()
  })
})

describe('登录与报告', () => {
  it('登录失效 → 常驻告警 + 「去登录」动作', () => {
    const l = loginNotice(true)
    expect(l?.kind).toBe('alert')
    expect(l?.sticky).toBe(true)
    expect(l?.action?.kind).toBe('login')
    expect(loginNotice(false)).toBeNull()
  })

  it('完成报告常驻、带「查看详情」动作', () => {
    const r = reportNotice({ id: 'rep-3', text: '全量帖子抓取完成', detail: '2 处中断' })
    expect(r.kind).toBe('report')
    expect(r.sticky).toBe(true)
    expect(r.action?.kind).toBe('open-report')
  })

  it('瞬时消息带 ttl 过期时刻', () => {
    const m = messageNotice('已收录「塔菲」', 5_000, 4_000)
    expect(m.expiresAt).toBe(9_000)
    expect(m.kind).toBe('message')
  })
})

describe('开播告警（M1，devlog/243）', () => {
  it('是 alert（会影响用户下一步动作），且**带 TTL 而不是常驻**', () => {
    const a = liveNotice({ id: 'live-3', name: '七海Nana7mi', title: '今晚开播', now: 1_000 })
    expect(a.kind).toBe('alert')
    expect(a.text).toBe('七海Nana7mi 开播了')
    expect(a.detail).toBe('今晚开播')
    expect(a.source).toBe('开播')
    // ⚠️ 常驻就等于"开播过的那次一直压住任务进度"（alert 4 > progress 3）——这条是牙口
    expect(a.sticky).toBeUndefined()
    expect(a.expiresAt).toBe(1_000 + LIVE_NOTICE_MS)
    expect(isLive(a, 1_000 + LIVE_NOTICE_MS)).toBe(false)
    expect(isLive(a, 1_000 + LIVE_NOTICE_MS - 1)).toBe(true)
  })

  it('没有标题时不带 detail（别在面板里留一行空说明）', () => {
    const a = liveNotice({ id: 'live-3', name: 'V', now: 0 })
    expect(a.detail).toBeUndefined()
  })

  it('它与进度并存时**压过**进度（alert > progress），到期后让位', () => {
    const now = 10_000
    const live = liveNotice({ id: 'live-3', name: 'V', now, ttlMs: 100 })
    const prog = progressNotice({ id: 'p', running: true, auto: false, text: '抓取中' })!
    expect(pickPrimary([live, prog], now)?.id).toBe('live-3')
    expect(pickPrimary([live, prog], now + 101)?.id).toBe('p')
  })
})

describe('任务文案（P8-C 格式）', () => {
  it('任务名 - V名 - i/N；空段跳过', () => {
    expect(composeTaskText('全量抓取中', '明前奶绿', 1, 11)).toBe('全量抓取中 - 明前奶绿 - 1/11')
    expect(composeTaskText('账号信息抓取中', null, 3, 7)).toBe('账号信息抓取中 - 3/7')
    expect(composeTaskText('帖子抓取中', 'V')).toBe('帖子抓取中 - V')
    expect(composeTaskText('账号信息抓取中', null, 0, 0)).toBe('账号信息抓取中')
  })
})

/**
 * 类型字形（D1 内容契约，2026-09-27）。
 *
 * 这组用例守的是**一处真缺陷**：胶囊原先只有"点色"一个通道表达 kind，
 * 而渲染侧的判定是 `progress→busy / alert→warn / **其余→ok**`
 * ⇒ `report` 与 `message` **落在同一个颜色上**，且胶囊**根本不渲染图标**
 * ⇒ "全量抓取完成"与"已复制诊断信息"在胶囊上长得一模一样（用户 2026-09-27 报的）。
 */
describe('KIND_GLYPH：类型必须有**自己的**通道', () => {
  it('**report 与 message 的字形不同**（这条就是那个缺陷的判据）', () => {
    expect(KIND_GLYPH.report).not.toBe(KIND_GLYPH.message)
    expect(KIND_GLYPH.report).toBe('✓')
    expect(KIND_GLYPH.message).toBe('✦')
  })

  it('四个 kind 两两不同 —— 重复一个就等于没修', () => {
    const vals = Object.values(KIND_GLYPH)
    expect(vals).toHaveLength(4)
    expect(new Set(vals).size).toBe(4)
  })

  it('字形是**单个字符**（多字符会变成"缩写"，宽度也不再可控）', () => {
    for (const [kind, g] of Object.entries(KIND_GLYPH)) {
      // `[...g]`：按**码点**数，避免把代理对算成两个
      expect([...g], `${kind} 的字形 ${JSON.stringify(g)} 应当是 1 个字符`).toHaveLength(1)
    }
  })

  it('**每个 kind 都有字形**（漏一个就会在胶囊上渲染出 `undefined`）', () => {
    for (const kind of Object.keys(KIND_PRIORITY)) {
      expect(KIND_GLYPH[kind as keyof typeof KIND_GLYPH], `${kind} 缺字形`).toBeTruthy()
    }
  })
})
