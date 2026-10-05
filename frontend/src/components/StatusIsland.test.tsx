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
  it('三形态各进各组，顺序固定（正在进行 → 需要处理 → 最近）', () => {
    render([message(), progress(), report()])
    const panel = openPanel()
    expect(panel).toBeTruthy()
    const groups = [...panel!.querySelectorAll('.si-sec')].map((s) => s.getAttribute('data-group'))
    expect(groups).toEqual(['doing', 'todo', 'recent'])
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
  it('「全部已读」只长在「需要处理」那组，动作是 `ack-all`', () => {
    const onAction = render([message(), report()])
    const panel = openPanel()
    const btns = [...panel!.querySelectorAll('[data-ack-all]')]
    expect(btns).toHaveLength(1)
    expect(btns[0].closest('.si-sec')?.getAttribute('data-group')).toBe('todo')
    act(() => { (btns[0] as HTMLElement).click() })
    expect(onAction).toHaveBeenCalledWith('ack-all', expect.anything())
    // 「最近」组没有这个按钮
    expect(panel!.querySelector('.si-sec[data-group="recent"] [data-ack-all]')).toBeNull()
  })

  it('过期的条目：先挂 `is-out` 滑出，动画放完才从 DOM 摘掉', () => {
    render([message({ createdAt: NOW, expiresAt: NOW + 1000 }), report()])
    const panel = openPanel()
    expect(panel!.querySelectorAll('.si-item')).toHaveLength(2)
    // ⚠️ 只推进到"秒表刚跳过 TTL"那一刻（1s）—— 推多了会把 220ms 的**移除定时器**也一起
    //    放掉，于是中间态永远看不到（第一版推 1100ms 就是这么假红的）。
    act(() => { vi.advanceTimersByTime(1050) })
    // 这一拍它已经不该算"活着"（不在 `.si-sec` 里），但仍在 DOM 里播退场动画
    expect(panel!.querySelectorAll('.si-sec .si-item')).toHaveLength(1)
    const leaving = panel!.querySelector('.si-list-leaving .si-item.is-out')
    expect(leaving).toBeTruthy()
    // 动画放完 ⇒ 真正移除
    act(() => { vi.advanceTimersByTime(400) })
    expect(panel!.querySelector('.si-list-leaving')).toBeNull()
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
    expect(cap.getAttribute('data-headline-group')).toBe('doing')
    expect(cap.getAttribute('data-section-counts')).toBe('doing:1,todo:1,recent:1')
  })
})
