// @vitest-environment jsdom
/**
 * 预约窗的行为判据（2026-10-13 补；此前这个弹窗**一条 vitest 都没有**，
 * 只有探针在量它的几何与身份）。
 *
 * 为什么现在补：这一批把它的日期字段从原生 `<input type="date">` 换成了自己画的
 * 日期选择器 —— 换控件最容易悄悄坏掉的正是"日期到底发出去哪一天"（预约写的是
 * `vtuber_events.event_date`，只到日）。所以这里钉四条：
 * ① 初值 = 被点的那一格那天（`dayKey`）；
 * ② 从日历上另选一天 → 提交的 `event_date` 跟着变（且**只到日**，不带时刻）；
 * ③ 标题空着不许提交（服务端要 title）；`vtuberId` 取不到也不许提交；
 * ④ 失败**看得见**（不吞成"保存失败"这句废话）。
 *
 * ⚠️ 身份钩子 `data-rv-date` 现在挂在**字段那一行**上（原先是那个 input）——
 * 探针按它判"开的是预约窗"，所以这里也顺带钉住它还在。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/api', () => ({ api: { createVtuberEvent: vi.fn() } }))

import { api } from '../../api/api'
import ReservationDialog from './ReservationDialog'

const createMock = vi.mocked(api.createVtuberEvent)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => false,
}))
const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnv.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onSaved = vi.fn()

function render(vtuberId: number | null, dayKey: string) {
  act(() => {
    root.render(
      <ReservationDialog open vtuberId={vtuberId} dayKey={dayKey}
                         onClose={onClose} onSaved={onSaved} />,
    )
  })
}

const field = () => document.getElementById('lc-rv-date') as HTMLButtonElement
const dateValue = () => field().getAttribute('data-dtp-value')
const titleInput = () => document.getElementById('lc-rv-title') as HTMLInputElement
const saveBtn = () => document.querySelector<HTMLButtonElement>('[data-rv-save]')!
const errorText = () => document.querySelector('[data-rv-error]')?.textContent ?? ''

function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

beforeEach(() => {
  createMock.mockReset().mockResolvedValue({ id: 1 } as never)
  onClose.mockReset(); onSaved.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('预约窗（自己画的日期选择器）', () => {
  it('① 初值 = 被点的那一格那天；身份钩子还在（探针按它认这个窗）', () => {
    render(7, '2026-10-20')
    expect(dateValue()).toBe('2026-10-20')
    expect(field().textContent).toContain('2026/10/20')
    expect(document.querySelector('[data-rv-date]')).not.toBeNull()
  })

  it('② 从日历另选一天 → 提交的 event_date 跟着变，且**只到日**', async () => {
    render(7, '2026-10-20')
    await click(field())
    // 弹层里只有日历、没有时刻列（预约只到日：摆一个填了也会被忽略的列比不摆更糟）
    expect(document.querySelector('.dtp-pop')).not.toBeNull()
    expect(document.querySelector('.dtp-col')).toBeNull()

    await click(document.querySelector<HTMLButtonElement>('[data-dtp-day="2026-10-22"]')!)
    expect(dateValue()).toBe('2026-10-22')

    type(titleInput(), '周五歌回')
    await click(saveBtn())
    expect(createMock).toHaveBeenCalledWith(7, {
      title: '周五歌回', event_date: '2026-10-22', kind: 'event', emoji: '📅',
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('③ 标题空着 / 取不到 V / 还没选完 → 保存不可点', async () => {
    render(7, '2026-10-20')
    expect(saveBtn().disabled).toBe(true)
    type(titleInput(), '   ')
    expect(saveBtn().disabled).toBe(true)
    type(titleInput(), '歌回')
    expect(saveBtn().disabled).toBe(false)

    act(() => root.unmount())
    root = createRoot(host)
    render(null, '2026-10-20')
    type(titleInput(), '歌回')
    expect(saveBtn().disabled).toBe(true)
  })

  it('④ 失败原因原文显示在窗里（不许吞成"保存失败"）', async () => {
    createMock.mockRejectedValue(new Error('event_date 不是合法日期'))
    render(7, '2026-10-20')
    type(titleInput(), '歌回')
    await click(saveBtn())
    expect(errorText()).toContain('event_date 不是合法日期')
    expect(onSaved).not.toHaveBeenCalled()
  })
})
