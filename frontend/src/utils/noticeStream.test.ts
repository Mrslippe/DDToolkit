/**
 * 通知的**取数与合并**（M4 devlog/252 → **M5-2b devlog/259 起两扇窗共用**）—— 判据分两层：
 *
 * ① **纯逻辑**（本文件）：服务端列表与本地覆盖怎么合、TTL 从哪起算、谁是真源；
 * ② **接线**（探针 `--status-widget` 的推送段 + `--messages`）：小窗那一页**根本没有主窗口**，
 *    所以"它能显示推来的消息 / 能显示服务端条目"本身就是"小窗独立"的证明。
 *
 * 为什么①不能省：合并规则里有三条"两边并存会难看"的错法（进度两份、消息两份、开播两条），
 * 它们只在**两路都活着**时出现 —— 探针那边很难只让一路活着。
 *
 * ⚠️ M5-2b 的语义变化：`fromMain`（主窗口广播）换成**服务端列表**。规则本身没变
 * （同类让位 + 按 id 去重），但"谁更权威"从此是后端 —— 所以本文件里 `mergeNotices`
 * 的第二参数一律叫 `server`。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { Notice } from './notificationHub'
import { PILL_MS, PUSHED_PROGRESS_MS, buildStreamNotices, mergeNotices } from './noticeStream'

const n = (over: Partial<Notice> & { id: string }): Notice => ({
  kind: 'message', text: 'x', ...over,
})

describe('mergeNotices — 本地覆盖 vs 服务端列表', () => {
  it('服务端还没取到（null / 空）⇒ 本地那份原样保留（推送先到的那一瞬就是它）', () => {
    const own = [n({ id: 'live-1', kind: 'alert' }), n({ id: 'pushed-progress', kind: 'progress' })]
    expect(mergeNotices(own, null).map((x) => x.id)).toEqual(['live-1', 'pushed-progress'])
    expect(mergeNotices(own, []).map((x) => x.id)).toEqual(['live-1', 'pushed-progress'])
  })

  it('服务端报到同类进度 ⇒ 本地那份让位（否则界面显示两条进度）', () => {
    const own = [n({ id: 'pushed-progress', kind: 'progress' })]
    const server = [n({ id: 'progress-post', kind: 'progress' })]
    expect(mergeNotices(own, server).map((x) => x.id)).toEqual(['progress-post'])
  })

  it('服务端也有同一条瞬时消息 ⇒ 只留服务端那份（同一句话不显示两遍）', () => {
    const own = [n({ id: 'msg-1780000000000' })]
    const server = [n({ id: 'msg-1780000000001' })]
    expect(mergeNotices(own, server).map((x) => x.id)).toEqual(['msg-1780000000001'])
  })

  it('开播告警两边同一个 id ⇒ 只留一条（本地那份优先：它带的是推送那一刻的文案）', () => {
    const own = [n({ id: 'live-7', kind: 'alert', text: '自己算的' })]
    const server = [n({ id: 'live-7', kind: 'alert', text: '服务端那份' })]
    const out = mergeNotices(own, server)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('自己算的')
  })

  it('互不相干的条目两边都留（登录失效 / 风控冷却只有服务端有）', () => {
    const own = [n({ id: 'pushed-progress', kind: 'progress' })]
    const server = [n({ id: 'login-expired', kind: 'alert' }), n({ id: 'rate-limit', kind: 'alert' })]
    expect(mergeNotices(own, server).map((x) => x.id))
      .toEqual(['pushed-progress', 'login-expired', 'rate-limit'])
  })

  it('dev 注入的条目（extraLocal）走的是同一条本地通道 ⇒ 服务端有消息时也让位', () => {
    const seeded = [n({ id: 'dev-seed', kind: 'message', text: '自检' })]
    const server = [n({ id: 'msg-9', kind: 'message', text: '真事' })]
    expect(mergeNotices(seeded, server).map((x) => x.id)).toEqual(['msg-9'])
    expect(mergeNotices(seeded, null).map((x) => x.id)).toEqual(['dev-seed'])
  })
})

describe('buildStreamNotices — 推送类条目与 TTL', () => {
  const edge = { account_id: 7, vtuber_id: 3, name: '七海', platform: 'bilibili',
                 platform_uid: '1', live_title: '歌回', live_url: '' }

  it('开播边沿 ⇒ alert，id 用 live-<account_id>（与服务端同一个 id，合并才去得掉重）', () => {
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

describe('结构判据：真源与 TTL 各只有一处（M5-2b）', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const read = (rel: string) => readFileSync(path.join(src, rel), 'utf-8')
  const code = (rel: string) => read(rel).split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n')

  it('两个宿主都从 `utils/noticeStream` 引 hook，且都不自己定义 TTL', () => {
    for (const rel of ['components/TopBar.tsx', 'components/StatusWidgetWindow.tsx']) {
      expect(code(rel), `${rel} 必须用 useNotices`).toContain('useNotices(')
      expect(code(rel), `${rel} 必须从 utils/noticeStream 引`).toContain("from '../utils/noticeStream'")
      expect(code(rel), `${rel} 里不许再写一份 PILL_MS 定义`).not.toMatch(/const PILL_MS\s*=/)
      expect(code(rel), `${rel} 里不许再写一份 PUSHED_PROGRESS_MS 定义`).not.toMatch(
        /const PUSHED_PROGRESS_MS\s*=/)
    }
  })

  it('两个宿主都拉服务端列表 `GET /vtuber/notices`（单一真源接线）', () => {
    expect(code('components/TopBar.tsx')).toContain('api.getNotices()')
    expect(code('components/StatusWidgetWindow.tsx')).toContain('api.getNotices()')
  })

  it('`widget:notices` 广播与 `kickPoll` 都已退役（不许有活代码引用）', () => {
    for (const rel of ['components/TopBar.tsx', 'components/StatusWidgetWindow.tsx',
                       'utils/widgetWindow.ts', 'utils/appEvents.ts']) {
      expect(code(rel), `${rel} 里还有 ${'widget:notices'} 的活代码`).not.toContain('widget:notices')
      expect(code(rel), `${rel} 里还有 kickPoll 的活代码`).not.toContain('kickPoll')
    }
    // 结构性：全仓不许再有 `broadcastNotices` / `EVENTS.kickPoll` 这两个标识符
    for (const rel of ['components/TopBar.tsx', 'utils/widgetWindow.ts', 'utils/appEvents.ts']) {
      expect(code(rel)).not.toContain('broadcastNotices')
      expect(code(rel)).not.toContain('EVENTS.kickPoll')
    }
  })
})
