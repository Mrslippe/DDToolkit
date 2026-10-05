/**
 * 通知的**取数与合并**（M4 devlog/252 → **M5-2b devlog/259 起后端供数**）—— 判据分两层：
 *
 * ① **纯逻辑**（本文件）：服务端列表与本地覆盖怎么合、TTL 从哪起算、谁是真源；
 * ② **接线**（探针 `--messages`）：推来的消息真的进了订阅与状态岛。
 *    （②当年还有"小窗那一页根本没有主窗口"那一条，小窗 2026-10-01 整窗退役后随之删除。）
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

import { describe, expect, it, vi } from 'vitest'

import type { Notice } from './notificationHub'
import {
  HANDOVER_GRACE_MS,
  PILL_MS,
  PUSHED_PROGRESS_MS,
  buildStreamNotices,
  mergeNotices,
  resetHandover,
} from './noticeStream'

const n = (over: Partial<Notice> & { id: string }): Notice => ({
  kind: 'message', text: 'x', ...over,
})

describe('mergeNotices — 本地覆盖 vs 服务端列表', () => {
  it('服务端还没取到（null / 空）⇒ 本地那份原样保留（推送先到的那一瞬就是它）', () => {
    const own = [n({ id: 'live-1', kind: 'alert' }), n({ id: 'pushed-progress', kind: 'progress' })]
    expect(mergeNotices(own, null).map((x) => x.id)).toEqual(['live-1', 'pushed-progress'])
    expect(mergeNotices(own, []).map((x) => x.id)).toEqual(['live-1', 'pushed-progress'])
  })

  it('⚠️ 服务端只有**别的任务**的进度（外部同步）⇒ 本地那份**留着**（按任务让位，不按 kind）', () => {
    // 2026-09-30 探针实测抓到的真 bug：外部同步那条 progress 一直在跑，把"任务已受理"顶掉了
    // ⇒ 点按钮的人又得等 3–10s 轮询，M2 的收益整个没了。
    const own = [n({ id: 'pushed-progress', kind: 'progress', text: '账号信息抓取中 - 七海' })]
    const server = [n({ id: 'progress-external', kind: 'progress', text: '正在同步第三方数据' })]
    expect(mergeNotices(own, server).map((x) => x.id))
      .toEqual(['pushed-progress', 'progress-external'])
  })

  it('服务端报到**同一个任务**的进度 ⇒ 本地那份**先让位 3 秒的宽限**，之后才撤', () => {
    // ⚠️ 为什么不是立刻撤（L1，devlog/341）：让位是"本地撤 + 服务端上"两件事，而服务端那条的
    // 到达节奏与本地无关 ⇒ 立刻撤会留一个"两条都不在"的空窗（探针连读三次都撞上）。
    // 宽限期内两条并存（文案同源，读起来是同一句话），过了窗口才真正撤。
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(1_700_000_000_000))
      const own = [n({ id: 'pushed-progress', kind: 'progress', ...({ task: 'post' } as object) })]
      const server = [n({ id: 'progress-post', kind: 'progress' })]
      resetHandover()
      // 第一拍：服务端刚报到 ⇒ 两条并存
      expect(mergeNotices(own, server).map((x) => x.id))
        .toEqual(['pushed-progress', 'progress-post'])
      // 过了宽限窗口 ⇒ 本地那条撤掉，只剩服务端这份（权威、带 i/N）
      vi.setSystemTime(new Date(1_700_000_000_000 + HANDOVER_GRACE_MS + 1))
      expect(mergeNotices(own, server).map((x) => x.id)).toEqual(['progress-post'])
      // 服务端那份走了（任务结束）⇒ 本地这条也不再回来（它有自己的 8s TTL）
      expect(mergeNotices(own, null).map((x) => x.id)).toEqual(['pushed-progress'])
    } finally {
      resetHandover()
      vi.useRealTimers()
    }
  })

  it('⚠️ 服务端报到的是**另一个任务**的进度 ⇒ 本地那份仍然留着（L1 再收紧一格）', () => {
    // 探针 `--messages` 实测抓到：探针发 `task='account'` 的受理进度，而此刻服务端正在跑
    // 别的任务 ⇒ 原来"服务端有任务进度就让位"会把它顶掉，面板里找不到那条
    // （报"推了受理进度，面板里却没有"）。判据必须是**同一条任务**。
    const own = [n({ id: 'pushed-progress', kind: 'progress', ...({ task: 'account' } as object) })]
    const server = [n({ id: 'progress-post', kind: 'progress' })]
    expect(mergeNotices(own, server).map((x) => x.id))
      .toEqual(['pushed-progress', 'progress-post'])
  })

  it('服务端也有同一条瞬时消息 ⇒ 只留服务端那份（同一句话不显示两遍）', () => {
    const own = [n({ id: 'msg-1780000000000' })]
    const server = [n({ id: 'msg-1780000000001' })]
    expect(mergeNotices(own, server).map((x) => x.id)).toEqual(['msg-1780000000001'])
  })

  it('⚠️ 客户端自己的事实（`local-` 前缀）**不让位**（L3）', () => {
    // 服务端收到的那条 message 是**另一个**动作的回执，与"磁盘快满/发现新版本"毫无关系。
    // 按 kind 让位会把客户端的事实一起顶掉 —— 它们原先走 `pillMessage`（不进这份列表）
    // 才没暴露这个缺口。
    const own = [n({ id: 'local-low-space', text: '磁盘可用空间不足 5GB' }),
                 n({ id: 'local-update', text: '发现新版本 v1.0.3' })]
    const server = [n({ id: 'msg-1780000000009', text: '帖子抓取完成' })]
    expect(mergeNotices(own, server).map((x) => x.id))
      .toEqual(['local-low-space', 'local-update', 'msg-1780000000009'])
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

  it('任务已受理 ⇒ progress，并带上配对用的 `task`（合并时靠它认任务）', () => {
    const out = buildStreamNotices(
      { liveEdge: null, progress: { payload: { text: '正在抓取 - 七海 - 1/3', task: 'post' } as never, at: 0 },
        message: null }, 0)
    expect(out[0].kind).toBe('progress')
    expect(out[0].text).toBe('正在抓取 - 七海 - 1/3')
    expect((out[0] as Notice & { task?: string }).task).toBe('post')
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

  it('宿主从 `utils/noticeStream` 引 hook，且不自己定义 TTL', () => {
    for (const rel of ['components/TopBar.tsx']) {
      expect(code(rel), `${rel} 必须用 useNotices`).toContain('useNotices(')
      expect(code(rel), `${rel} 必须从 utils/noticeStream 引`).toContain("from '../utils/noticeStream'")
      expect(code(rel), `${rel} 里不许再写一份 PILL_MS 定义`).not.toMatch(/const PILL_MS\s*=/)
      expect(code(rel), `${rel} 里不许再写一份 PUSHED_PROGRESS_MS 定义`).not.toMatch(
        /const PUSHED_PROGRESS_MS\s*=/)
    }
  })

  it('宿主拉服务端列表 `GET /vtuber/notices`（单一真源接线）', () => {
    expect(code('components/TopBar.tsx')).toContain('api.getNotices()')
  })

  it('`widget:notices` 广播与 `kickPoll` 都已退役（不许有活代码引用）', () => {
    for (const rel of ['components/TopBar.tsx', 'utils/appEvents.ts']) {
      expect(code(rel), `${rel} 里还有 ${'widget:notices'} 的活代码`).not.toContain('widget:notices')
      expect(code(rel), `${rel} 里还有 kickPoll 的活代码`).not.toContain('kickPoll')
    }
    // 结构性：全仓不许再有 `broadcastNotices` / `EVENTS.kickPoll` 这两个标识符
    for (const rel of ['components/TopBar.tsx', 'utils/appEvents.ts']) {
      expect(code(rel)).not.toContain('broadcastNotices')
      expect(code(rel)).not.toContain('EVENTS.kickPoll')
    }
  })
})
