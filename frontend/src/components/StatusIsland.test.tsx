// @vitest-environment jsdom
/**
 * 顶栏状态岛的**呈现**判据（L1，`devlog/341`）。
 *
 * 为什么要组件级（而纯逻辑已经有 `noticeBoard.test.ts` 的 24 条）：
 * 纯逻辑证明"怎么分组"，证明不了"**面板真的按分组渲染出来**" ——
 * 而我这批的第一版正是在这一层错的：面板的条目从一份本地 `rows` 状态里取，
 * 而那份状态只在**面板打开**时才同步 ⇒ 面板关着时来的新条目**不在面板里**
 * （探针 `ui_probe --messages` 报"推了受理进度，面板里却找不到"）。
 * 纯逻辑全绿、探针红 —— 这一类缺口只能在这层钉。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import StatusIsland from './StatusIsland'
import type { Notice } from '../utils/notificationHub'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // 面板走 portal 挂到 body，宿主容器不需要额外准备
  vi.useFakeTimers()
  // ⚠️ **把系统时间也钉在 `NOW`**（2026-10-05 修）：组件的"秒表"是
  // `Math.max(nowProp, Date.now())`。不钉的话 `Date.now()` 是**真实**时间（≈1.79e12），
  // 而测试里的通知锚在 `NOW`（1.7e12）⇒ 每个条目一上来就被体检判成**已过期**，
  // 于是"退场中间态"永远看不到（那条用例就是因此红的）。
  vi.setSystemTime(NOW)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const NOW = 1_700_000_000_000

const progress = (over: Partial<Notice> = {}): Notice => ({
  id: 'pushed-progress', kind: 'progress', form: 'state', source: '任务进度',
  text: '账号信息抓取中 - 七海 - 1/2', createdAt: NOW - 30_000, ...over,
} as Notice)

const message = (over: Partial<Notice> = {}): Notice => ({
  id: 'msg-1', kind: 'message', form: 'notice', source: '操作结果',
  text: '同步完成', createdAt: NOW, expiresAt: NOW + 6000, ...over,
} as Notice)

const report = (over: Partial<Notice> = {}): Notice => ({
  id: 'report-1', kind: 'report', form: 'action', source: '完成报告', sticky: true,
  text: '全量帖子抓取完成 · 存储 42', detail: '视频可能缺 2 条', createdAt: NOW - 120_000,
  action: { label: '查看详情', kind: 'open-report' }, ...over,
} as Notice)

function render(notices: Notice[], onAction = vi.fn()) {
  act(() => root.render(<StatusIsland notices={notices} onAction={onAction} now={NOW} />))
  return onAction
}

/** 点开面板（点胶囊 = 钉住） */
function openPanel() {
  const cap = host.querySelector<HTMLElement>('.si-island')
  expect(cap).toBeTruthy()
  act(() => { cap!.click() })
  return document.querySelector<HTMLElement>('.si-panel')
}

describe('面板的三组分区', () => {
  it('三形态各进各组，顺序固定（最近 → 需要处理 → 正在进行）', () => {
    render([message(), progress(), report()])
    const panel = openPanel()
    expect(panel).toBeTruthy()
    const groups = [...panel!.querySelectorAll('.si-sec')].map((s) => s.getAttribute('data-group'))
    // ⚠️ 用户 2026-10-05 把「最近」提到最顶（"这些通知是最实时的信息"）——
    //    这条顺序与 `noticeBoard.GROUP_ORDER` 必须一致（改一处不改另一处会红）
    expect(groups).toEqual(['recent', 'todo', 'doing'])
    // 每一组里那条正是对应形态
    const items = (g: string) =>
      [...panel!.querySelectorAll(`.si-sec[data-group="${g}"] .si-item`)]
        .map((n) => n.getAttribute('data-form'))
    expect(items('doing')).toEqual(['state'])
    expect(items('todo')).toEqual(['action'])
    expect(items('recent')).toEqual(['notice'])
  })

  it('**面板关着时来的条目也在面板里**（第一版就错在这：条目取自只在打开时同步的本地状态）', () => {
    // 先只有一条消息，不打开面板
    render([message()])
    expect(host.querySelector('.si-island')?.classList.contains('on')).toBe(true)
    // 面板关着的时候进度来了（真实场景：用户没点开，后台任务开始了）
    render([message(), progress()])
    const panel = openPanel()
    const texts = [...panel!.querySelectorAll('.si-item-text')].map((n) => n.textContent)
    expect(texts).toContain('账号信息抓取中 - 七海 - 1/2')
  })

  it('空组不渲染（只有消息时不该出现「正在进行（0）」）', () => {
    render([message()])
    const panel = openPanel()
    const groups = [...panel!.querySelectorAll('.si-sec')].map((s) => s.getAttribute('data-group'))
    expect(groups).toEqual(['recent'])
  })
})

describe('相对时间', () => {
  it('状态类读作「进行中 N」，告知类读作「N 前」（就挂在 meta 行上）', () => {
    render([progress(), message()])
    const panel = openPanel()
    const metas = [...panel!.querySelectorAll('.si-item-meta')].map((n) => n.textContent || '')
    expect(metas.some((t) => t.includes('进行中 30 秒'))).toBe(true)
    expect(metas.some((t) => t.includes('刚刚'))).toBe(true)
  })

  it('**缺 `createdAt` 就不显示时间**（老后端），而不是糊一个"刚刚"', () => {
    render([progress({ createdAt: undefined })])
    const panel = openPanel()
    const meta = panel!.querySelector('.si-item-meta')?.textContent || ''
    expect(meta).not.toContain('刚刚')
    expect(meta).not.toContain('秒前')
    // ⚠️ 不能断言 `not.toContain('进行中')` —— 那是 `kind` 的中文名（`KIND_LABEL.progress`），
    //    它本来就该在；要判的是**相对时间那一段**没出现。第一版就写错了这条。
    expect(meta).toContain('进行中')          // kind 名：这是"进行中"的进度条目
    expect(meta).toContain('任务进度')         // 来源标注仍在
    expect(meta.split(' · ')).toHaveLength(2)  // 只有 kind + 来源，没有第三段（时间）
  })
})

describe('条目图标按**来源**分（用户 2026-10-05：四条 alert 顶着同一个 ⚠）', () => {
  /** 图标在 DOM 里是 lucide 的 `<svg class="lucide-xxx">` —— 用它的类名当"哪个图标"的证据 */
  const iconClassOf = (panel: HTMLElement, idx: number) => {
    const svg = panel.querySelectorAll('.si-item')[idx]?.querySelector('svg')
    return [...(svg?.classList ?? [])].find((c) => c.startsWith('lucide-')) ?? null
  }

  it('开播 / 登录失效 / 能力受限 / 风控冷却**四个图标互不相同**', () => {
    render([
      // 这四条的真实形态：`kind` 全是 alert（所以点色一样），靠**来源**区分
      { ...message(), id: 'live-1', kind: 'alert', form: 'notice', source: '开播',
        text: '调测用V 开播了' } as never,
      { ...progress(), id: 'login-expired', kind: 'alert', form: 'state', source: '登录态',
        text: 'B 站登录已失效', sticky: true } as never,
      { ...progress(), id: 'cap-limits', kind: 'alert', form: 'state', source: '能力矩阵',
        text: '有 3 项功能当前受限', sticky: true } as never,
      { ...progress(), id: 'rate-limit', kind: 'alert', form: 'state', source: '风控冷却',
        text: '上游限流：冷却中', value: '47s' } as never,
    ])
    const panel = openPanel()!
    const icons = [0, 1, 2, 3].map((i) => iconClassOf(panel, i))
    expect(icons.every(Boolean), `有条目没渲染出图标：${icons}`).toBe(true)
    // 四个必须两两不同 —— 相同就等于"没区分"（这条就是用户报的那个毛病）
    expect(new Set(icons).size, `四个来源的图标重复了：${icons}`).toBe(4)
    // 且开播**不许**再用警示三角（用户点名的那一条：开播不是警告）
    const live = icons[0]
    expect(live).not.toContain('triangle-alert')
  })

  it('认不出来的来源退回 `kind` 那套（不会出现空白图标）', () => {
    render([{ ...progress(), kind: 'alert', form: 'state', source: '将来某新来源',
              text: '未知来源的告警' } as never])
    const panel = openPanel()!
    expect(iconClassOf(panel, 0)).toContain('triangle-alert')   // 退回 alert 的图标
  })
})

describe('倒计时（只给会自动消失的条目）', () => {
  it('告知类有细条，且 `data-left` 与 `scaleX` 一致', () => {
    render([message({ createdAt: NOW, expiresAt: NOW + 6000 })])
    const panel = openPanel()
    const bar = panel!.querySelector<HTMLElement>('.si-item-bar')
    expect(bar).toBeTruthy()
    expect(panel!.querySelector('.si-item')?.getAttribute('data-left')).toBe('1.000')
    expect(bar!.querySelector('i')?.style.transform).toBe('scaleX(1.000)')
  })

  it('状态类与处置类**没有**细条（否则会误导成"任务会自己消失"）', () => {
    render([progress(), report()])
    const panel = openPanel()
    expect(panel!.querySelectorAll('.si-item-bar').length).toBe(0)
  })

  it('胶囊上的环只在有 TTL 的条目上出现', () => {
    render([message()])
    expect(host.querySelector('.si-ring')).toBeTruthy()
    act(() => root.render(<StatusIsland notices={[]} onAction={vi.fn()} now={NOW} />))
    render([progress()])
    expect(host.querySelector('.si-ring')).toBeNull()
  })
})

describe('一键已读与自动已读的退场', () => {
  it('「全部已读」在**面板右上角**（头部），清的范围见 `ackAllIds`', () => {
    const onAction = render([message(), report()])
    const panel = openPanel()
    const btns = [...panel!.querySelectorAll('[data-ack-all]')]
    expect(btns).toHaveLength(1)
    // 位置：面板头部（原来长在「需要处理」组标题右侧、并且只在有 todo 时才出现）
    expect(btns[0].closest('.si-panel-head')).toBeTruthy()
    act(() => { (btns[0] as HTMLElement).click() })
    expect(onAction).toHaveBeenCalledWith('ack-all', expect.anything())
    // 组标题里**不再**有它（挪走了，不许两处都在）
    expect(panel!.querySelector('.si-sec-title [data-ack-all]')).toBeNull()
  })

  it('「全部已读」只在**真有可清的**才渲染（只有状态类时不给死按钮）', () => {
    render([progress()])
    const panel = openPanel()
    expect(panel!.querySelector('[data-ack-all]')).toBeNull()
  })

  it('点条目正文 = 已读（动作 `dismiss`），状态类**不可点**', () => {
    const onAction = render([message(), progress()])
    const panel = openPanel()!
    const rows = [...panel.querySelectorAll<HTMLElement>('.si-item')]
    // 告知类那条可点（`can-ack`）
    const m = rows.find((r) => r.getAttribute('data-form') === 'notice')!
    expect(m.classList.contains('can-ack')).toBe(true)
    act(() => { m.click() })
    expect(onAction).toHaveBeenCalledWith('dismiss', expect.objectContaining({ id: 'msg-1' }))
    // 状态类那条不可点（它消失应当是事实变了，不是"用户看过了"）
    const p = rows.find((r) => r.getAttribute('data-form') === 'state')!
    expect(p.classList.contains('can-ack')).toBe(false)
    act(() => { p.click() })
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('点**动作按钮**只执行动作、不把通知标已读（stopPropagation）', () => {
    const onAction = render([report()])
    const panel = openPanel()!
    const btn = panel.querySelector<HTMLElement>('.si-item-action')!
    act(() => { btn.click() })
    expect(onAction).toHaveBeenCalledWith('open-report', expect.anything())
    // 只有动作那一次调用 —— 没有跟着一条 `dismiss`
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['open-report'])
  })

  it('过期的条目：先挂 `is-out` 滑出，动画放完才从 DOM 摘掉（且**留在原组**里）', () => {
    render([message({ createdAt: NOW, expiresAt: NOW + 1000 }), report()])
    const panel = openPanel()
    expect(panel!.querySelectorAll('.si-item')).toHaveLength(2)
    // ⚠️ 只推进到"秒表刚跳过 TTL"那一刻（1s）—— 推多了会把 220ms 的**移除定时器**也一起
    //    放掉，于是中间态永远看不到（第一版推 1100ms 就是这么假红的）。
    act(() => { vi.advanceTimersByTime(1020) })
    // 这一拍它已经不该算"活着"（`.si-sec .si-item:not(.is-out)` 里只剩另一条），
    // 但仍在 DOM 里播退场动画，**而且还在它原来那个组里**（不再跳到列表最下面）
    const alive = panel!.querySelectorAll('.si-sec .si-item:not(.is-out)').length
    expect(alive).toBe(1)
    const out = panel!.querySelector<HTMLElement>('.si-item.is-out')
    expect(out).toBeTruthy()
    // **它就是刚过期的那条**（不是别的行）
    expect(out!.getAttribute('data-notice-id')).toBe('msg-1')
    // 且**钉在原来的位置**（`top` 由 FLIP 的快照给）：这条是"从它的位置滑出去"的判据 ——
    // 挂到别的容器里、或位置被重排，都会让它看起来"跳走了"。
    // ⚠️ 不断言它属于哪个 `.si-sec`：那条路径由"这一组是否还在渲染"决定（整组只剩它时会被
    //    兜底容器接住），那是实现细节，不是用户能感知的事实。
    expect(out!.style.position).toBe('absolute')
    expect(out!.style.top).not.toBe('')
    // ⚠️ 时间窗很窄：**必须在 1000ms（秒表判过期）之后、1220ms（移除定时器）之前**采样。
    //    1050 也够，但 1020 留的余量大（本机 CI 上跑得过密时 1050 偶尔会踩到移除那一拍）。
    // 动画放完 ⇒ 真正移除
    act(() => { vi.advanceTimersByTime(400) })
    expect(panel!.querySelector('.si-item.is-out')).toBeNull()
  })

  it('退场期间**每一拍的 `now` 都在走**也不会自激重渲染（用户报的白屏：`Maximum update depth exceeded`）', () => {
    // 这条钉的是用户 2026-10-05 的报错："点「批量全部」→ 面板白屏 + Maximum update depth exceeded"。
    // 成因：退场条目"浮起来"的坐标放在**共享 state**（`floatPos`）里，由一条依赖 `[now]` 的
    // effect 每拍重算一次 ⇒ `setFloatPos(新对象)` → 重渲染（`now` 又变了）→ 再算 → 互相点火；
    // 修法是几何**在状态转换那一拍冻结、跟着行走**（`Row.exitTop`），链子从根上断开。
    //
    // ⚠️ 为什么不用上面那条用例的写法：`vi.setSystemTime(NOW)` 把 `Date.now()` **钉死了**，
    //    于是每拍算出来的 `now` 都一样、那条 effect 根本不会重复跑 —— 真实运行时
    //    `Date.now()` 每毫秒都在走，所以这里**故意让每次 `Date.now()` 都往前跳 1 秒**。
    //    这正是"单测全绿、实机白屏"的那道缝。
    let clock = NOW
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000))
    try {
      render([message({ expiresAt: NOW + 1 }), report()])
      expect(openPanel()).toBeTruthy()
      // 秒表走一格 ⇒ `now` 越过 TTL（判它退场）**且**这一拍的 `now` 与上一拍不同（点火条件）
      act(() => { vi.advanceTimersByTime(1020) })
      const outs = document.querySelectorAll('.si-panel .si-item.is-out')
      expect(outs.length, '到期那条应当在滑出').toBe(1)
      // 再推几拍（每拍 `now` 都不同）—— 自激会在这个窗口里把 React 打爆（抛错即本用例失败）
      for (let i = 0; i < 5; i += 1) act(() => { vi.advanceTimersByTime(1000) })
      expect(document.querySelectorAll('.si-panel .si-item.is-out').length).toBeLessThanOrEqual(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('条目**快速连着来**时不重复、不丢（每一条恰好一个 `.si-item`）', () => {
    // 用户报的"通知快速进入的时候条目一直重复堆叠"：退场那条浮起来时若坐标被反复重算，
    // 兄弟条目会被反向 transform 越补越偏（看起来像叠在一起）。判据取**条数 + id 唯一**。
    const base = (n: number) => ({
      id: `burst-${n}`, kind: 'message', form: 'notice', source: '操作结果',
      text: `第 ${n} 条`, createdAt: NOW, expiresAt: NOW + 600_000,
    } as Notice)
    let list: Notice[] = [base(1)]
    render(list)
    const panel = openPanel()!
    for (let n = 2; n <= 6; n += 1) {
      list = [...list, base(n)]
      act(() => root.render(<StatusIsland notices={list} onAction={vi.fn()} now={NOW} />))
    }
    const ids = [...panel.querySelectorAll('.si-item')].map((n) => n.getAttribute('data-notice-id'))
    expect(ids).toEqual(['burst-1', 'burst-2', 'burst-3', 'burst-4', 'burst-5', 'burst-6'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('胶囊文案', () => {
  it('多个任务同时跑 ⇒ 合并成一句（不是只显示最新那条）', () => {
    render([
      progress({ id: 'progress-post', text: '帖子抓取中 - 明前奶绿 - 3/11' }),
      progress({ id: 'progress-account', text: '账号信息抓取中 - 星瞳 - 1/2' }),
    ])
    const text = host.querySelector('.si-text')?.textContent || ''
    expect(text).toContain('帖子')
    expect(text).toContain('账号信息')
    expect(text).toContain('抓取中')
  })

  it('`data-headline-group` / `data-section-counts` 暴露"这句话来自哪一组"', () => {
    render([message(), progress(), report()])
    const cap = host.querySelector('.si-island')!
    // 顺序变了（最近在最顶）⇒ 胶囊那句话现在来自 `recent`
    expect(cap.getAttribute('data-headline-group')).toBe('recent')
    expect(cap.getAttribute('data-section-counts')).toBe('recent:1,todo:1,doing:1')
  })
})

/**
 * 源码级：**已读要同时清服务端那份与本地那份**（2026-10-05 用户实测的 bug，`devlog/347`）。
 *
 * 为什么用源码级：这条 bug 是"少清了一半" —— 本地条目（客户端事实 / dev 注入 / 调测页造的）
 * 不在 `serverNotices` 里，只过滤它会**点了等于没点**，而它们常驻（`sticky`）⇒ 永远删不掉。
 * 要渲染级复现得把整个 `TopBar`（路由 + api + capabilities + 轮询链）搭起来，
 * 收益不抵成本；这里钉的是"两条路都走了 `ackIds`"这个**结构**事实。
 */
describe('已读路径（源码级结构判据）', () => {
  const src = readFileSync(
    join(__dirname, '..', 'components', 'TopBar.tsx'), 'utf8')

  it('存在一个同时清本地与服务端的 `ackIds`，且两条入口都走它', () => {
    expect(src).toContain('const ackIds = (ids: string[])')
    // 本地那份必须被过滤（否则 sticky 的本地条目永远删不掉）
    expect(src).toMatch(/setLocalNotices\(\(prev\) => \{\s*const kept = prev\.filter\(\(n\) => !ids\.includes\(n\.id\)\)/)
    // 单条（dismiss / 点条目）与整组（ack-all）都不许再各写一遍过滤逻辑
    expect(src).toContain('ackIds([notice.id])')
    expect(src).toMatch(/const ids = ackAllIds\(notices, now\)[\s\S]{0,80}ackIds\(ids\)/)
    // 「服务端那份」仍要真的发请求（本地 id 不许发给后端：会污染服务端已读集合）
    expect(src).toContain('api.ackNotices(serverIds)')
    expect(src).toContain('.some((n) => n.id === id)')
  })

  it('已读还要盖住**推送流**那一份（第三份，2026-10-05 探针抓到）', () => {
    // 面板里的条目有三个来源：本地那份、服务端那份、**推送流那份**
    // （`useNotices` 里的 `liveEdge` / `message`：`live-<account_id>` / `msg-<ms>`）。
    // 前两份 `ackIds` 都清了，第三份没有 —— 症状是"刚推来的开播告警点一下纹丝不动"
    // （探针 `--notice-lab` 实测：点了 `live-9001`，一个 `.is-out` 都没有）。
    // 这里钉的是**结构**：`ackIds` 必须往 `ackedIds` 里记一笔，而渲染用的是过滤后的那份；
    // 寿命规则（什么时候忘）在 `noticeBoard.pruneAcked`，那里有 3 条纯函数用例。
    expect(src).toContain('setAckedIds')
    expect(src).toMatch(/merged\.filter\(\(n\) => !ackedIds\.includes\(n\.id\)\)/)
    expect(src).toContain('pruneAcked(prev, merged.map((n) => n.id))')
  })
})
