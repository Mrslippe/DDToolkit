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
  vi.restoreAllMocks()      // 假布局（`stubLayout`）必须还回去，否则串到后面的用例
  vi.useRealTimers()
})

const NOW = 1_700_000_000_000

/**
 * **假布局**（`devlog/350`）：jsdom 不做排版，所有 `getBoundingClientRect()` 都是 0
 * ⇒ FLIP 的位移 `dy` 恒为 0 ⇒ "补位"那条路径一步都走不到。
 *
 * 口径照真实结构写：`.si-list` 内边距 6px、行高固定 40；**已让位的行不占流内位置**
 * （`.is-out`：`position:absolute`，位置由冻结的 `style.top` 给），
 * **还在流内的行**（活着 / 排队 / **滑出中**）按在流内的次序排。
 * ⚠️ "滑出中"（`.is-sliding`）**占位**是 2026-10-06 那条新口径的核心（用户：
 * 「让上一条已读滑出 60%–80% 之后，下面的条目再顶上去」）—— 所以这条假布局的
 * `:not(.is-out)` 判据一个字都不用改：它描述的正是"谁还占着流内位置"。
 *
 * ⚠️ 钉的是 **`offsetTop` / `offsetHeight`**（布局值）而不是 `getBoundingClientRect()`：
 * 组件读的就是这两个，而它们的意义正是"transform 无关" —— 用 rect 会被**正在跑的过渡**
 * 骗到（2026-10-05 的真根因，见 `geomOf` 的注释）。
 * `flushed` 记下**强制样式计算那一下**（读 `offsetHeight` 时）各条目身上挂着的内联位移 ——
 * 同步 FLIP 的**起点**就是靠这一下落实的（少了它，补位退化成"啪一下跳上去"）。
 *
 * `trace`（可选，2026-10-06 加）：同一时刻**逐行**记 `id|sliding=…|tf=…` ——
 * 用来判"补位到底补到了谁"（滑出中的那条也必须被补，见那条用例）。
 */
const ROW_H = 40
const LIST_PAD = 6
function stubLayout(flushed: string[] = [], trace?: string[]) {
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('is-out')) {
      return Number.parseFloat(this.style.top || '0') || 0      // 让位的那条：位置由它自己给
    }
    if (this.classList.contains('si-item')) {
      const live = [...(this.closest('.si-list')?.querySelectorAll('.si-item:not(.is-out)') ?? [])]
      return LIST_PAD + Math.max(0, live.indexOf(this)) * ROW_H
    }
    return 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    flushed.push(this.style.transform)
    if (trace && this.classList.contains('si-item')) {
      trace.push(`${this.getAttribute('data-notice-id')}`
        + `|sliding=${this.classList.contains('is-sliding')}`
        + `|out=${this.classList.contains('is-out')}|tf=${this.style.transform}`)
    }
    return this.classList.contains('si-item') ? ROW_H : 0
  })
}

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

  it('三组标题**常驻**（空组显示（0））—— 用户 2026-10-05：标题突然消失太突兀、也打断节奏', () => {
    // 原来是"空组不渲染"（L1 的清爽口径）。用户实测后改成常驻：
    // 「栏目头标题……所有条目都已读了就会直接消失，但是直接消失太突兀了也会让连续已读的节奏卡顿，
    //  我觉得直接就别消失了，常驻标题头」——空组样式不做区分（用户选的口径）。
    render([message()])
    const panel = openPanel()
    const groups = [...panel!.querySelectorAll('.si-sec')].map((s) => s.getAttribute('data-group'))
    expect(groups).toEqual(['recent', 'todo', 'doing'])
    const titles = [...panel!.querySelectorAll('.si-sec-title')].map((t) => t.textContent)
    expect(titles).toEqual(['最近（1）', '需要处理（0）', '正在进行（0）'])
  })

  it('条目**逐条走掉**的那一段里，组标题一直在（不许跟着跳/消失）', () => {
    // 常驻的另一半意义：连续已读时布局稳定。这条钉的是"读到最后一条"那一刻标题还在
    const onAction = render([message({ id: 'only-1' }), progress()])
    const panel = openPanel()!
    act(() => panel.querySelector<HTMLElement>('.si-item.can-ack')!.click())
    act(() => root.render(<StatusIsland notices={[progress()]} onAction={onAction} now={NOW} />))
    const titles = () => [...document.querySelectorAll('.si-sec-title')].map((t) => t.textContent)
    expect(titles(), '退场那条还在屏幕上，计数不许掉到 0').toEqual(['最近（1）', '需要处理（0）', '正在进行（1）'])
    act(() => { vi.advanceTimersByTime(400) })
    expect(titles(), '它真走了之后，标题仍要在（只是变成（0））')
      .toEqual(['最近（0）', '需要处理（0）', '正在进行（1）'])
  })
})

/**
 * 「服务端那条没有 TTL 的状态」在面板里必须看得见，且**计数 = 画出来的条数**
 * （2026-10-06，`devlog/357`；用户现场：点了「全量拉取第三方数据」，
 * 面板里没有那条「正在同步…」，计数却写着 2）。
 *
 * 两个毛病各自都要判：① `expiresAt: null` 被判成"已过期" ⇒ 条目被滤掉；
 * ② `通知（N）` 与 `.si-count` 数的是**原始数组**（含已过期的）⇒ 与屏幕上的条数不一致。
 */
describe('服务端状态条目的可见性与计数（`expiresAt: null`）', () => {
  /** 与 `GET /vtuber/notices` 回来的形状逐字一致（实测原始响应见 `devlog/357`） */
  const serverProgress = (over: Partial<Notice> = {}): Notice => ({
    id: 'progress-external', kind: 'progress', form: 'state', source: '第三方同步',
    text: '正在同步第三方数据（全量）', sticky: false,
    expiresAt: null, createdAt: NOW - 60_000, ...over,
  } as Notice)
  /** 本机那条常驻的「有 N 项功能当前受限」（`TopBar` 里造，sticky = 没有 TTL） */
  const capLimits = (over: Partial<Notice> = {}): Notice => ({
    id: 'cap-limits', kind: 'alert', form: 'state', source: '能力矩阵', sticky: true,
    text: '有 1 项功能当前受限', createdAt: NOW - 120_000, ...over,
  } as Notice)

  const panelCount = () => {
    const t = document.querySelector('.si-panel-title')?.textContent || ''
    return Number((t.match(/（(\d+)）/) ?? [])[1] ?? NaN)
  }
  const drawnRows = () => document.querySelectorAll('.si-sec .si-item').length
  /**
   * 让退场队列跑完（220ms 滑出 + 70ms 起排）：**"幽灵行"与"活着的行"必须分得开**。
   *
   * ⚠️ 这条是这一批的关键（2026-10-06）：`expiresAt: null` 被判成"已过期"时，
   * 条目**并不是完全不画** —— 它会以"正在退场"的身份在列表里闪一下（`exiting` 那一路），
   * 200~300ms 后被泵清掉。所以只断言"打开面板时看得见"会**假绿**，
   * 必须等队列跑完再看它还在不在（用户截图里那一条就是已经闪没了的样子）。
   */
  const settle = () => act(() => { vi.advanceTimersByTime(1000) })

  it('「正在同步第三方数据」要**留在**「正在进行」里（用户截图里正是它没了）', () => {
    render([capLimits(), serverProgress()])
    const panel = openPanel()!
    settle()
    const rows = [...panel.querySelectorAll('.si-sec[data-group="doing"] .si-item')]
      .filter((el) => !el.classList.contains('is-out'))
    expect(rows.map((el) => el.querySelector('.si-item-text')?.textContent))
      .toContain('正在同步第三方数据（全量）')
  })

  it('面板标题与胶囊徽章的计数 = **画出来的**条数（两条就写 2，且真的画 2 行）', () => {
    render([capLimits(), serverProgress()])
    openPanel()
    settle()
    expect(drawnRows()).toBe(2)
    expect(panelCount()).toBe(2)
    expect(host.querySelector('.si-count')?.textContent).toBe('2')
  })

  it('列表里还剩一条**已经过期**的（轮询还没换掉）⇒ 计数不许把它算进去', () => {
    // 服务端那份到点后要等下一轮轮询才消失，这中间"数了但没画"就是用户看到的 2 vs 1
    render([
      capLimits(),
      serverProgress(),
      message({ id: 'msg-gone', expiresAt: NOW - 1 }),      // 已过期
    ])
    openPanel()
    settle()
    expect(drawnRows()).toBe(2)
    expect(panelCount(), '过期的条目不在屏幕上，就不该在计数里').toBe(2)
    expect(host.querySelector('.si-count')?.textContent).toBe('2')
  })
})

/**
 * 源码级：**「定时体检」那条 effect 在没有条目到点时不调度任何更新**（2026-10-06，`devlog/357`）。
 *
 * 为什么必须钉在源码这一层：这条错的形态在 jsdom 里**复现不出来** ——
 * 旧写法 `setRows(prev => prev)` 的 updater 返回同一个引用，React 直接 bail-out、
 * **不产生新的 commit**，于是"每提交一次就再调度一次"这个环在 jsdom 里第二步就断了。
 * 而真机上它不断：`now` 是 `Math.max(nowProp, Date.now())`，只要两次渲染之间过了 1ms
 * 依赖就变、effect 就再跑、**再调一次 `setRows`** —— 而"在 commit 阶段调度更新"这件事
 * 本身会被 React 计进 `nestedUpdateCount`，攒够 50 次就 `Maximum update depth exceeded`
 * （`ui_probe --notice-lab` 实测：600+ 次渲染、整棵树被 `ErrorBoundary` 重建，
 * 顶栏连它的 dev 口一起消失 ⇒ 后面读什么都是空）。
 *
 * 所以这里钉的是**结构**：先自己算"有没有到点的"，没有就 `return`，一次都不调。
 * 反向判据在探针那边（`--notice-lab` 抓页面报错），两边一起才算够。
 */
describe('体检那条 effect 不许每拍都调度更新（源码级结构判据）', () => {
  const src = readFileSync(
    join(__dirname, '..', 'components', 'StatusIsland.tsx'), 'utf8')
  const block = src.slice(src.indexOf('const stale = rows.some'),
                          src.indexOf('}, [now, rows])'))

  it('先判 `stale`，没有就 `return`，**然后**才 setRows', () => {
    expect(block.length, '没找到那段体检代码（判据自己失效了）').toBeGreaterThan(80)
    // ⚠️ 三个标记都要在里面（2026-10-06 加了 `sliding`）：漏了它，正在滑的那条会被
    //    再标一次 `queued` ⇒ 同一条被放行两次（滑一半重新开始滑）
    expect(block).toMatch(
      /const stale = rows\.some\(\(r\) => !r\.queued && !r\.sliding && !r\.leaving && !isLive\(r, now\)\)/)
    const guard = block.indexOf('if (!stale) return')
    const call = block.indexOf('setRows(')
    expect(guard, '少了"没东西到点就早退"那道闸').toBeGreaterThan(-1)
    expect(call, '这段里没有 setRows（判据自己失效了）').toBeGreaterThan(-1)
    expect(guard, '早退必须在 setRows **之前**').toBeLessThan(call)
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

  it('过期的条目：先 `is-sliding` **在流内**滑出，65% 后才让位，动画放完才从 DOM 摘掉（且**留在原组**里）', () => {
    // ⚠️ 口径 2026-10-06 改过（用户：「让上一条已读滑出 60%–80% 之后，下面的条目再顶上去」）：
    //    它**不再**在退场的第一拍就浮起来 —— 先 `is-sliding`（在流内、位置还占着），
    //    滑到 `EXIT_YIELD_MS`（65%×220 ≈ 143ms）才 `is-out`（浮起来、让出位置）。
    stubLayout()
    render([message({ createdAt: NOW, expiresAt: NOW + 1000 }), report()])
    const panel = openPanel()
    expect(panel!.querySelectorAll('.si-item')).toHaveLength(2)
    // ⚠️ 只推进到"秒表刚跳过 TTL"那一刻（1s）—— 推多了会把 220ms 的**移除定时器**也一起
    //    放掉，于是中间态永远看不到（第一版推 1100ms 就是这么假红的）。
    act(() => { vi.advanceTimersByTime(1020) })
    const row = panel!.querySelector<HTMLElement>('.si-item[data-notice-id="msg-1"]')!
    expect(row.classList.contains('is-sliding'), '这一拍它已经在滑出').toBe(true)
    expect(row.classList.contains('is-out'), '但**还没让位**（才滑了 20/220ms）').toBe(false)
    // ⚠️ 判据不能跨组比 `offsetTop`（`message` 在 recent、`report` 在 todo，
    //    各是各自 `.si-list` 里的第一行、量出来都是 6）—— 数"还在流里的行数"才对得上：
    //    让位前**两条都占位**（滑出中那条仍然占着），让位后只剩一条。
    const inFlow = () => panel!.querySelectorAll('.si-sec .si-item:not(.is-out)').length
    expect(inFlow(), '让位前：滑出中那条**仍占着**流内位置').toBe(2)
    // 滑到 65%（≈143ms）⇒ 让位：两个类**同时在场**（动画仍挂在 `is-sliding` 上，不许被重挂）
    // ⚠️ 推 **160ms** 而不是 143：上面那次 `advanceTimersByTime(1020)` 里，秒表那一拍的状态
    //    更新是**在这一批走完**（时钟已经停在 1020）才被 React 冲掉的 ⇒ 让位表实际从 1020 起算、
    //    到期时刻是 **1163**。推 140 会差 3ms 落在"还没到"上（实测踩到：`.is-out` 死活不出现）。
    //    上限是移除表（放行后 220ms ⇒ 1240），160 两边都留了余量。
    act(() => { vi.advanceTimersByTime(160) })
    expect(row.classList.contains('is-sliding'), '让位那一拍 `.is-sliding` 不许被摘掉').toBe(true)
    expect(row.classList.contains('is-out')).toBe(true)
    // 冻结的几何：`top` 是**内联**给的（`position`/`left`/`right` 在 CSS 的 `.si-item.is-out` 里，
    // jsdom 不加载真 CSS ⇒ 这里只能判内联那一半，另一半由下面的 CSS 结构判据钉）
    expect(row.style.top).not.toBe('')
    expect(inFlow(), '让位后：流内只剩另一条').toBe(1)
    // 而且**它还在原来那个组里**（不再跳到别处；整组只剩它时也不会被兜底容器接走）
    expect(row.closest('.si-sec')?.getAttribute('data-group')).toBe('recent')
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
      // ⚠️ 判据取 `.is-sliding`（**两个阶段都有它**）：这让位那条仍挂着它，
      //    所以这一条对"退场处于哪一相"不敏感 —— 它要钉的是"在退场、且没被自激打爆"。
      const outs = document.querySelectorAll('.si-panel .si-item.is-sliding')
      expect(outs.length, '到期那条应当在滑出').toBe(1)
      // 再推几拍（每拍 `now` 都不同）—— 自激会在这个窗口里把 React 打爆（抛错即本用例失败）
      for (let i = 0; i < 5; i += 1) act(() => { vi.advanceTimersByTime(1000) })
      expect(document.querySelectorAll('.si-panel .si-item.is-sliding').length).toBeLessThanOrEqual(1)
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

  it('「全部已读」多条 ⇒ **从上到下逐条**滑出（70ms 一条），不是一下全走', () => {
    // 用户 2026-10-05：「全部已读的效果应该是从上到下一条一条逐个滑出，而不是现在这样
    // 一下全部滑出然后瞬间顶上去」。所以"不再活着"与"开始滑出"是两件事：
    // 先全体进**队列**（人还留在原位照常显示），再由泵每 `ACK_STAGGER_MS` 放一条出去。
    // ⚠️ 屏幕上的次序是**新的在最上面**（`compareInGroup`）：所以 m1 最新、排在第一位。
    const onAction = render([
      message({ id: 'm1', text: '第一条', createdAt: NOW }),
      message({ id: 'm2', text: '第二条', createdAt: NOW - 1000 }),
      message({ id: 'm3', text: '第三条', createdAt: NOW - 2000 }),
    ])
    const panel = openPanel()!
    // ⚠️ "已经走掉"的判据取 **`.is-sliding`**（2026-10-06 起放行 = 开始滑、**还没**让位）：
    //    两个阶段（滑出中 / 已让位）都挂着这个类，所以"放行了几条"它说了算；
    //    只看 `.is-out` 会读到"一条都没走"（让位要等 65%×220 ≈ 143ms）。
    const outs = () => [...panel.querySelectorAll<HTMLElement>('.si-item.is-sliding')]
      .map((n) => n.getAttribute('data-notice-id'))
    const ids = () => [...panel.querySelectorAll<HTMLElement>('.si-item')]
      .map((n) => n.getAttribute('data-notice-id'))
    expect(ids(), '前提：最上面是最新那条').toEqual(['m1', 'm2', 'm3'])

    act(() => { panel.querySelector<HTMLElement>('[data-ack-all]')!.click() })
    expect(onAction).toHaveBeenCalledWith('ack-all', expect.anything())
    // 面板侧：点完这一拍还什么都看不出来（真正的移除在 TopBar 那一半，这里补一次重渲染模拟）
    act(() => root.render(<StatusIsland notices={[]} onAction={onAction} now={NOW} />))
    // ① 条数不变、只有**最上面那条**在滑（其余在排队：还在原位、连 `is-sliding` 都没有）
    expect(ids(), '排队的那几条不许当场消失').toEqual(['m1', 'm2', 'm3'])
    expect(outs(), '第一条（最上面）先走').toEqual(['m1'])
    // ② 每 70ms 放一条：第二条（+70）、第三条（+140）
    act(() => { vi.advanceTimersByTime(70) })
    expect(outs()).toEqual(['m1', 'm2'])
    act(() => { vi.advanceTimersByTime(70) })
    expect(outs()).toEqual(['m1', 'm2', 'm3'])
    // ③ 220ms 后陆续真删（各条从**它自己开始滑**那一刻算）；清空后面板自己收起
    act(() => { vi.advanceTimersByTime(900) })
    // ⚠️ 查**活文档**里的：面板这时已经卸载，`panel` 那个引用是脱离文档的旧节点
    //    （从它身上数子节点会数到卸载前的样子）
    expect(document.querySelectorAll('.si-panel .si-item')).toHaveLength(0)
    expect(document.querySelector('.si-panel')).toBeNull()
  })

  it('队列期间**面板不许消失**（否则那串逐条滑出根本看不到）', () => {
    // 「全部已读」把最后几条清掉时，`sections` 会变成空 ⇒ 原来那两条"没内容就收起/不挂载"
    // 的判据会让面板**当拍卸载**（pin 着也照收）—— 逐条动画一帧都看不到。
    const onAction = render([message({ id: 'm1' }), message({ id: 'm2', createdAt: NOW - 1 })])
    const panel = openPanel()!
    act(() => { panel.querySelector<HTMLElement>('[data-ack-all]')!.click() })
    // 模拟 TopBar 那一半：通知从 `notices` 里撤掉（组件侧只剩排队/退场副本）
    act(() => root.render(<StatusIsland notices={[]} onAction={onAction} now={NOW} />))
    expect(document.querySelector('.si-panel'), '面板不该当拍就没').toBeTruthy()
    act(() => { vi.advanceTimersByTime(150) })
    expect(document.querySelector('.si-panel'), '动画放完前面板还得在').toBeTruthy()
    // 队列清空 ⇒ 才允许收起（这里没有别的通知了）
    act(() => { vi.advanceTimersByTime(1200) })
    expect(document.querySelector('.si-panel')).toBeNull()
  })

  it('补位的反向位移**不留跨帧状态**（同步 FLIP —— 用户报的"空白不被顶上来"）', () => {
    // 用户 2026-10-05："点击已读之后虽然向左滑出是正常的，但留下的空白不会被自动顶上去"。
    // 实测（探针 `--notice-lab`）根因**不是没重排**，而是补位用的反向位移**卡在了 DOM 上**：
    // 它靠"下一帧"（rAF）撤，而点已读会在几毫秒内再来一次提交（本地状态一拍、`ack` 回来的
    // 那一拍）⇒ 那个 rAF 被取消 ⇒ 位移与 `transition:none` 留在元素上，那一行停在旧位置。
    // 更糟的是"量位置"会撞上这份位移，于是得靠 `data-flip-y` 记账去减 —— 记账一旦对不上
    // 就正负翻转、越补越偏（探针实测同一条 +80ms 是 `+139.5px`、+680ms 变成 `-139.5px`）。
    // 现在补位是**同步**做完的：挂位移 → 强制一次样式计算 → 当场撤掉，不留任何跨帧状态。
    // ⚠️ 必须给**假布局**：jsdom 里 rect 全是 0 ⇒ `dy` 恒为 0 ⇒ 这条路径一步都走不到。
    const flushed: string[] = []
    stubLayout(flushed)
    const a = message({ id: 'a', text: '第一条' })
    // ⚠️ `createdAt` **必须错开**（原来这里 a 与 b 同为 `NOW`）：两条的排序键相等时，
    //    `drawnGroups` 的 `[...live, ...mine]` 会把"已退场那条"排到活着的后面 ⇒
    //    撤下 a 的那一拍**两行会换位**（都走 FLIP 的缓动），量到的 +40px 就成了"换位"，
    //    而不是这条用例要钉的"a 走了 ⇒ b 顶上来"。（这版是老用例留下来的坑：
    //    老口径下 a 当拍就浮起来、跳过 FLIP，所以那个换位看不见 —— 见最终报告的遗留点。）
    const b = message({ id: 'b', text: '第二条', createdAt: NOW - 1000 })
    act(() => root.render(<StatusIsland notices={[a, b]} onAction={vi.fn()} now={NOW} />))
    const panel = openPanel()!
    const rowB = () => panel.querySelector<HTMLElement>('.si-item[data-notice-id="b"]')!

    // 点 a = 已读 ⇒ 父组件把它撤下（这里直接重渲染模拟），b 稍后要从第 2 行补到第 1 行。
    // ⚠️ **补位发生在让位那一刻**（2026-10-06 起 = 放行后 `EXIT_YIELD_MS` ≈ 143ms），
    //    不再像老口径那样"撤下的当拍就顶上来" —— 所以这里必须先走完那 143ms。
    act(() => root.render(<StatusIsland notices={[b]} onAction={vi.fn()} now={NOW} />))
    expect(flushed, '还没让位 ⇒ 这时**不该**有补位（用户 2026-10-06：先滑 65% 再顶）')
      .not.toContain(`translateY(${ROW_H}px)`)
    act(() => { vi.advanceTimersByTime(150) })      // 越过 143ms 的让位时刻
    // 补位**真的发生过**：强制样式计算那一下，元素身上挂着 +40px 的反向位移（= 过渡的起点）
    expect(flushed.some((t) => t.includes(`translateY(${ROW_H}px)`)),
           `强制刷新的那一下应当挂着 +${ROW_H}px 的反向位移（补位的起点），实得 ${flushed}`).toBe(true)
    // 而且**当拍就撤干净**（不留跨帧状态 ⇒ 下一拍再提交也不会卡住）
    expect(rowB().style.transform, '反向位移不许留在 DOM 上').toBe('')
    expect(rowB().style.transition).toBe('')

    // 同一帧里再来一次提交（真实场景 = `ack` 响应到达）：位置照旧、没有残留
    act(() => root.render(<StatusIsland notices={[b]} onAction={vi.fn()} now={NOW + 1} />))
    expect(rowB().style.transform).toBe('')
    expect(rowB().style.transition).toBe('')
  })
})

/**
 * **让位时机**（用户 2026-10-06 的口径反转）：
 * 「让上一条已读滑出 **60%–80%** 之后，下面的条目再顶上去」。
 *
 * 老口径（2026-10-05）是"退场那条**当场**浮起来 ⇒ 流内位置立刻空出、下面的条目**同时**上移"。
 * 新口径把"腾出位置"推到滑出动画走了 `EXIT_YIELD_AT`（65% ≈ 143ms）那一刻。
 * 判据直接钉**那个时间窗**：+80ms（< 60%×220 = 132ms）时下面那条**一动没动**；
 * +160ms（> 143ms）时它已经顶上来了。
 */
describe('让位时机（2026-10-06：先滑 60%–80%，下面的条目再顶上来）', () => {
  it('+80ms 下面那条**还没**上移；+160ms 才上移（且让位那条**两个类同时在场**）', () => {
    stubLayout()
    const b = message({ id: 'b', text: '第二条', createdAt: NOW - 1000 })
    const onAction = render([message({ id: 'a', text: '第一条' }), b])
    const panel = openPanel()!
    const row = (id: string) =>
      panel.querySelector<HTMLElement>(`.si-item[data-notice-id="${id}"]`)!
    // 前提：a 在上、b 在下，各占一行
    expect([row('a').offsetTop, row('b').offsetTop]).toEqual([LIST_PAD, LIST_PAD + ROW_H])

    // 点 a = 已读 ⇒ 父组件把它撤下（这里直接重渲染模拟）
    act(() => root.render(<StatusIsland notices={[b]} onAction={onAction} now={NOW} />))
    expect(row('a').classList.contains('is-sliding'), '放行 = 开始滑（人还在流内）').toBe(true)
    expect(row('a').classList.contains('is-out'), '放行**不**让位').toBe(false)
    expect(row('b').offsetTop, '刚放行时下面那条当然还在原位').toBe(LIST_PAD + ROW_H)

    act(() => { vi.advanceTimersByTime(80) })     // 80ms < 0.6×220 = 132ms
    expect(row('a').classList.contains('is-out'), '+80ms 还不该让位').toBe(false)
    expect(row('b').offsetTop, '+80ms：下面那条**还在原位**（这条就是新口径本身）')
      .toBe(LIST_PAD + ROW_H)

    act(() => { vi.advanceTimersByTime(80) })     // 累计 160ms > 143ms（0.65×220）
    expect(row('b').offsetTop, '+160ms：让位已发生 ⇒ 下面那条顶上来').toBe(LIST_PAD)
    // 让位那一刻**两个类同时在场**：`.is-sliding` 管动画、`.is-out` 管定位。
    // 少了 `.is-sliding` 就等于"把动画重新挂了一次"⇒ 从头播，视觉上那条会往回跳一下。
    expect(row('a').classList.contains('is-sliding'), '让位不许摘掉动画那个类').toBe(true)
    expect(row('a').classList.contains('is-out')).toBe(true)
    // 冻结的几何由**内联**给（`top`/`height` 是每行自己的数据）；`position`/`left`/`right`
    // 在真 CSS 里（jsdom 不加载它）—— 那一半由下面那条读真 CSS 的判据钉。
    expect(row('a').style.top).not.toBe('')
  })

  it('**滑出中的那条也要被补位**（它上面那条让位时，它不许当场跳一行）', () => {
    // ⚠️ 这条钉的是一个**刻意不做**的跳过：`.is-out` 要被 FLIP 跳过（它已脱离文档流），
    //    但 `.is-sliding` **必须补** —— 上面那条让位时它在**布局**上会被顶上去一整行，
    //    不给它缓动它就当场跳一行（逐条退场时第三条最明显：它刚开滑、还几乎不透明）。
    //    老写法跳它的理由是"动画占着 `transform`、补位写进去也会被动画覆盖"——
    //    那个前提现在不成立：退场动画走**独立变换属性 `translate`**（见 CSS），
    //    `transform` 空着给 FLIP，两者在 CSS 里是**合成**关系而不是互相覆盖。
    const trace: string[] = []
    stubLayout([], trace)
    const onAction = render([
      message({ id: 'm1', text: '第一条' }),
      message({ id: 'm2', text: '第二条', createdAt: NOW - 1000 }),
      message({ id: 'm3', text: '第三条', createdAt: NOW - 2000 }),
    ])
    const panel = openPanel()!
    act(() => { panel.querySelector<HTMLElement>('[data-ack-all]')!.click() })
    act(() => root.render(<StatusIsland notices={[]} onAction={onAction} now={NOW} />))
    act(() => { vi.advanceTimersByTime(70) })     // m2 放行
    act(() => { vi.advanceTimersByTime(70) })     // m3 放行（t = 140）
    trace.length = 0
    act(() => { vi.advanceTimersByTime(6) })      // t = 146：m1 让位 ⇒ 这一拍必须补 m2/m3
    const slid = trace.filter(
      (t) => t.includes('sliding=true') && t.includes(`translateY(${ROW_H}px)`))
    expect(slid.length, `滑出中的条目没被补位（下一拍会当场跳一行）：${trace.join(' / ')}`)
      .toBeGreaterThan(0)
  })
})

/**
 * 源码级：**让位那一刻动画不许被重新挂上**（读**真** `status-island.css`）。
 *
 * 为什么必须钉在源码这一层：jsdom 不加载 CSS、更不跑动画，"动画有没有从头重播"在
 * 组件用例里**根本测不到**（能测到的只有"两个类同时在场"，那是它的**必要条件**）。
 * 而这条错的形态是**会真发生的**：`.is-out` 在让位那一刻才加上，只要它（或它那条规则）
 * 也声明了 `animation`，"同名动画被重新计算"就可能从 0% 重来 —— 视觉上那条滑到一半
 * **往回跳一下**再滑出去（用户对这类跳动极敏感，2026-10-05 那批全是这种反馈）。
 *
 * 判据取"动画挂在哪个选择器上"：**唯一那条主退场动画必须在 `.is-sliding` 上**
 * （放行起一直在的那个类），而 `.is-out` 的每条规则里**都不许**出现 `animation`。
 */
describe('退场动画不重启（读真 `status-island.css` 的结构判据）', () => {
  const css = readFileSync(
    join(__dirname, '..', 'styles', 'status-island.css'), 'utf8')
    // ⚠️ **先去注释**：注释里什么字都有（含逗号），留着它们会把"选择器"读成一整段散文，
    //    于是 `rulesFor()` 永远匹配不上真规则 —— 判据退化成"什么都没查"（第一版就是这样：
    //    `.is-out` 那条 `position:absolute` 死活找不着，其实规则一直在）
    .replace(/\/\*[\s\S]*?\*\//g, '')
  /** 真 CSS 的规则块（`selector { body }`；`@media` 里的嵌套规则按同一条抓，
   *  因为 `[^{}]+` 跨不过 `{`） */
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
  const rulesFor = (sel: string) =>
    rules.filter((r) => r.selector.split(',').map((s) => s.trim()).includes(sel))
  /** `@keyframes <name> { … }` 的块体（按大括号配对取，不受缩进/换行影响） */
  const keyframesBody = (name: string) => {
    const start = css.indexOf(`@keyframes ${name} {`)
    expect(start, `CSS 里找不到 \`@keyframes ${name}\`（判据自己失效了）`).toBeGreaterThan(-1)
    let depth = 0
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') {
        depth -= 1
        if (depth === 0) return css.slice(start, i + 1)
      }
    }
    throw new Error(`@keyframes ${name} 的大括号没配对`)
  }

  it('动画只在 `.is-sliding` 上；`.is-out` 的规则里**不许**有 animation', () => {
    const anim = rules.filter((r) => /animation:\s*si-item-out\s/.test(r.body))
    expect(anim, '主退场动画（`si-item-out`）应当恰好有一条声明').toHaveLength(1)
    expect(anim[0].selector).toContain('.si-item.is-sliding')
    const out = rulesFor('.si-item.is-out')
    expect(out.length, 'CSS 里没有 `.si-item.is-out` 规则（判据自己失效了）').toBeGreaterThan(0)
    for (const r of out) {
      expect(r.body, `让位那条规则带了 animation ⇒ 动画会从头重播（${r.selector}）`)
        .not.toContain('animation')
    }
    expect(out.some((r) => /position:\s*absolute/.test(r.body)),
           '`.is-out` 必须负责"脱离文档流"（这一句就是"让位"本身）').toBe(true)
  })

  it('退场动画动 **`translate`**，不许动 `transform`（`transform` 是留给 FLIP 的）', () => {
    // 理由：动画在层叠里**压过内联样式** ⇒ 动画占着 `transform` 时，FLIP 给"正在滑出的那条"
    // 写的补位位移会被吃掉（它就会当场跳一行，见上一条用例）。
    // 两个属性是**合成**关系：`translate` 排在 `transform` 之前，且都是纯平移 ⇒ 相加。
    const kf = keyframesBody('si-item-out')
    expect(kf).toContain('translate: -24px')
    expect(kf, '关键帧动了 transform ⇒ 滑出中的条目补不了位').not.toContain('transform')
    expect(keyframesBody('si-item-out-fade'), 'reduce 那一档只淡出，不许有位移')
      .not.toContain('translate')
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
    // 前两份 `ackIds` 都清了，第三份没有 —— 症状是"刚推来的开播公告点一下纹丝不动"
    // （探针 `--notice-lab` 实测：点了 `live-9001`，一个 `.is-out` 都没有）。
    // 这里钉的是**结构**：`ackIds` 必须往 `ackedIds` 里记一笔，而渲染用的是过滤后的那份；
    // 寿命规则（什么时候忘）在 `noticeBoard.pruneAcked`，那里有 3 条纯函数用例。
    expect(src).toContain('setAckedIds')
    expect(src).toMatch(/merged\.filter\(\(n\) => !ackedIds\.includes\(n\.id\)\)/)
    expect(src).toContain('pruneAcked(prev, merged.map((n) => n.id))')
  })
})

/**
 * 源码级：**补位（"顶上来"）量的是布局，不是视觉**（`devlog/350`）。
 *
 * 为什么必须钉在源码这一层：这条错的形态在 jsdom 里**复现不出来** —— 它要的是
 * "过渡正在跑"这个真实浏览器的中间态。而它的代价很具体（用户 2026-10-05 报的那句
 * "滑出正常，但留下的空白不会被自动顶上去"）：
 * `getBoundingClientRect()` 给的是**视觉**位置，包含正在跑的过渡的中间值
 * ⇒ 每拍（秒表 / 轮询回来的重渲染）拍一次快照，量到的都是"它还在下面"，
 * 下一拍再补一次 ⇒ **过渡反复重启，那一条永远到不了位**（探针实测：布局 `offsetTop=6`
 * 而 rect 报 76，差值恰好是退场那条的高度，+680ms 依旧）。
 */
describe('补位的量法（源码级结构判据）', () => {
  const src = readFileSync(
    join(__dirname, '..', 'components', 'StatusIsland.tsx'), 'utf8')

  it('`geomOf` 读 `offsetTop`/`offsetHeight`，且**不许**回头去读 rect', () => {
    expect(src).toMatch(/const geomOf = \(el: HTMLElement\): Geom => \(\{ relTop: el\.offsetTop/)
    // 反向：`geomOf` 所在的这一段里不许出现 `getBoundingClientRect`
    const seg = src.slice(src.indexOf('const geomOf'), src.indexOf('const snapshotGeom'))
    expect(seg).not.toContain('getBoundingClientRect')
  })

  it('补位是**同步**做完的（挂位移 → 强制一次样式计算 → 当场撤掉），不留跨帧状态', () => {
    // 为什么不用 rAF：位移跨帧存在时，①"几毫秒内连着两次提交"会把 rAF 取消、位移永久卡住；
    // ②任何一次量位置都可能撞上它。同步做法的这三步必须都在，且顺序不能换。
    expect(src).toMatch(/el\.style\.transition = 'none'\s*\n\s*el\.style\.transform = `translateY\(\$\{dy\}px\)`\s*\n\s*void el\.offsetHeight\s*\n\s*el\.style\.transition = ''\s*\n\s*el\.style\.transform = ''/)
    // 补位这一段里**不许有跨帧的帧回调**（本文件别处 `place()` 用 rAF 是另一回事，只查这一段）
    const flipBlock = src.slice(src.indexOf('// ── **同步 FLIP**'),
                                src.indexOf('geomRef.current = snapshotGeom()'))
    expect(flipBlock.length, '没找到那段补位代码（判据自己失效了）').toBeGreaterThan(100)
    // 查的是**调用**（注释里提到那套老写法是刻意的说明，不算数）
    expect(flipBlock).not.toMatch(/requestAnimationFrame\(/)
    expect(flipBlock).not.toMatch(/cancelAnimationFrame\(/)
  })
})
