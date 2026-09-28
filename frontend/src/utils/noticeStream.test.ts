/**
 * 小窗自己订阅推送（M4，devlog/252）—— 判据分两层：
 *
 * ① **纯逻辑**（本文件）：两路来源怎么合、TTL 从哪起算；
 * ② **接线**（探针 `--status-widget` 的推送段）：小窗那一页**根本没有主窗口**，
 *    所以"它能显示推来的消息"本身就是"小窗独立"的证明（反向验证：不 `startMessageBus` ⇒ 红）。
 *
 * 为什么①不能省：合并规则里有三条"两边并存会难看"的错法（进度两份、消息两份、开播两条），
 * 它们只在**主窗口开着**时出现 —— 探针那边反而量不到（探针页里没有主窗口广播）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { Notice } from './notificationHub'
import { PILL_MS, PUSHED_PROGRESS_MS, buildStreamNotices, mergeWidgetNotices } from './noticeStream'

const n = (over: Partial<Notice> & { id: string }): Notice => ({
  kind: 'message', text: 'x', ...over,
})

describe('mergeWidgetNotices — 自己算的那份 vs 主窗口广播的那份', () => {
  it('主窗口不在（null / 空）⇒ 自己那份原样保留（这就是 M4 的收益）', () => {
    const own = [n({ id: 'live-1', kind: 'alert' }), n({ id: 'pushed-progress', kind: 'progress' })]
    expect(mergeWidgetNotices(own, null).map((x) => x.id)).toEqual(['live-1', 'pushed-progress'])
    expect(mergeWidgetNotices(own, []).map((x) => x.id)).toEqual(['live-1', 'pushed-progress'])
  })

  it('主窗口的轮询报到同类进度 ⇒ 自己那份让位（否则界面显示两条进度）', () => {
    const own = [n({ id: 'pushed-progress', kind: 'progress' })]
    const main = [n({ id: 'progress-post', kind: 'progress' })]
    expect(mergeWidgetNotices(own, main).map((x) => x.id)).toEqual(['progress-post'])
  })

  it('主窗口也收到了同一条瞬时消息 ⇒ 用主窗口那份（两边显示同一句话，不重复）', () => {
    const own = [n({ id: 'msg-1780000000000' })]
    const main = [n({ id: 'msg-1780000000001' })]
    expect(mergeWidgetNotices(own, main).map((x) => x.id)).toEqual(['msg-1780000000001'])
  })

  it('开播告警两边同一个 id ⇒ 只留一条（自己那份优先）', () => {
    const own = [n({ id: 'live-7', kind: 'alert', text: '自己算的' })]
    const main = [n({ id: 'live-7', kind: 'alert', text: '广播来的' })]
    const out = mergeWidgetNotices(own, main)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('自己算的')
  })

  it('互不相干的条目两边都留（登录失效那种只有广播有）', () => {
    const own = [n({ id: 'pushed-progress', kind: 'progress' })]
    const main = [n({ id: 'login-expired', kind: 'alert' }), n({ id: 'rate-limit', kind: 'alert' })]
    expect(mergeWidgetNotices(own, main).map((x) => x.id))
      .toEqual(['pushed-progress', 'login-expired', 'rate-limit'])
  })
})

describe('buildStreamNotices — 推送类条目与 TTL', () => {
  const edge = { account_id: 7, vtuber_id: 3, name: '七海', platform: 'bilibili',
                 platform_uid: '1', live_title: '歌回', live_url: '' }

  it('开播边沿 ⇒ alert，id 用 live-<account_id>（与主窗口同一个 id，合并才去得掉重）', () => {
    const out = buildStreamNotices(
      { liveEdge: { payload: edge, at: 1000 }, progress: null, message: null }, 2000)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('live-7')
    expect(out[0].kind).toBe('alert')
    expect(out[0].text).toContain('七海')
  })

  it('任务已受理 ⇒ progress', () => {
    const out = buildStreamNotices(
      { liveEdge: null, progress: { payload: { text: '正在抓取 - 七海 - 1/3' } as never, at: 0 },
        message: null }, 0)
    expect(out[0].kind).toBe('progress')
    expect(out[0].text).toBe('正在抓取 - 七海 - 1/3')
  })

  it('瞬时消息 ⇒ message', () => {
    const out = buildStreamNotices(
      { liveEdge: null, progress: null, message: { text: '抓取完成', at: 0 } }, 0)
    expect(out[0].kind).toBe('message')
    expect(out[0].expiresAt).toBe(PILL_MS)
  })

  it('⚠️ TTL 从**到达时刻**起算，不是从渲染时刻 —— 否则条目永远不过期', () => {
    const src = { liveEdge: null, progress: { payload: { text: 'p' } as never, at: 1000 },
                  message: null }
    expect(buildStreamNotices(src, 1000 + PUSHED_PROGRESS_MS - 1)).toHaveLength(1)
    expect(buildStreamNotices(src, 1000 + PUSHED_PROGRESS_MS + 1)).toHaveLength(0)
    // 若实现里用渲染时刻当起点（`at + PUSHED_PROGRESS_MS > now` 恒真），上面第二条会留下 1 条
    expect(buildStreamNotices(src, 10 ** 9)).toHaveLength(0)
  })

  it('三样都没有 ⇒ 空列表（空闲态）', () => {
    expect(buildStreamNotices({ liveEdge: null, progress: null, message: null }, 0)).toEqual([])
  })
})

describe('TTL 常量只有一处（两个宿主不许各写一份）', () => {
  it('TopBar 从 noticeStream 引，不再自己定义 PILL_MS / PUSHED_PROGRESS_MS', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const topbar = readFileSync(path.join(src, 'components', 'TopBar.tsx'), 'utf-8')
    const code = topbar.split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')
    expect(code, 'TopBar 必须从 utils/noticeStream 引这两条 TTL')
      .toContain("from '../utils/noticeStream'")
    expect(code, 'TopBar 里不许再写一份 PILL_MS 定义').not.toMatch(/const PILL_MS\s*=/)
    expect(code, 'TopBar 里不许再写一份 PUSHED_PROGRESS_MS 定义').not.toMatch(
      /const PUSHED_PROGRESS_MS\s*=/)
  })
})
