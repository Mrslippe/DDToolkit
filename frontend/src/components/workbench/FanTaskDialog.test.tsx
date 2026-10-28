// @vitest-environment jsdom
/**
 * 任务浮窗（2026-10-28，C 批）。
 *
 * 钉用户口径里最容易做错的三条：
 * ① **运行中「完成」「分析」都是灰的**（只有「取消」可用）；
 * ② 结束后反过来：「取消」灰、「完成」「分析」亮；
 * ③ 关窗**不停任务**（store 还在 running），「完成」才收尾。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const collect = vi.fn()
const status = vi.fn()
const cancel = vi.fn()

vi.mock('../../api/api', () => ({
  api: {
    fanCollect: (...a: unknown[]) => collect(...a),
    fanCollectStatus: (...a: unknown[]) => status(...a),
    fanCollectCancel: (...a: unknown[]) => cancel(...a),
  },
}))

import FanTaskDialog from './FanTaskDialog'
import {
  POLL_MS, fanTask, openTaskWindow, resetFanTask, startCollect,
} from '../../hooks/useFanTask'

function prog(over: Record<string, unknown> = {}) {
  return {
    vtuber: '弥月Mizuki', since: '2026-09-01', until: '2026-09-30', state: 'running',
    total: 30, done: 12, failed: 0, skipped: 0, current: '', message: '', elapsed: 5,
    ...over,
  }
}

const ARGS = {
  vtuber: '弥月Mizuki', since: '2026-09-01', until: '2026-09-30',
  liveIds: [], total: 30,
}

let host: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<MemoryRouter><FanTaskDialog /></MemoryRouter>)
  })
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector(sel) as T | null
}

const disabled = (sel: string) => q<HTMLButtonElement>(sel)?.disabled

beforeEach(() => {
  resetFanTask()
  collect.mockReset().mockResolvedValue({ ok: true })
  status.mockReset().mockResolvedValue({ items: [prog()], count: 1 })
  cancel.mockReset().mockResolvedValue({ ok: true })
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  resetFanTask()
  vi.useRealTimers()
})

describe('任务浮窗：按钮禁用矩阵', () => {
  it('运行中：只有「取消」可用，「完成」「分析」都灰', async () => {
    await startCollect(ARGS)
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    await mount()
    await act(async () => { openTaskWindow() })
    expect(q('[data-testid="fan-task-dialog"]')).toBeTruthy()
    expect(disabled('[data-testid="task-cancel"]')).toBe(false)
    expect(disabled('[data-testid="task-done"]')).toBe(true)
    expect(disabled('[data-testid="task-analyze"]')).toBe(true)
    // 细粒度进度在
    expect(q('[data-testid="task-summary"]')!.textContent).toContain('12/30')
  })

  it('结束后反过来：「取消」灰，「完成」「分析」亮', async () => {
    status.mockResolvedValue({
      items: [prog({
        state: 'done', done: 30,
        sessions_detail: [
          { live_id: 'L1', start_at: '2026-09-01 20:00', state: 'ok', records: 3200,
            reason: '', title: '杂谈回' },
          { live_id: 'L2', start_at: '2026-09-02 20:00', state: 'failed', records: 0,
            reason: '上游 412 风控' },
        ],
      })],
      count: 1,
    })
    await startCollect(ARGS)
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    await mount()
    await act(async () => { openTaskWindow() })
    expect(disabled('[data-testid="task-cancel"]')).toBe(true)
    expect(disabled('[data-testid="task-done"]')).toBe(false)
    expect(disabled('[data-testid="task-analyze"]')).toBe(false)
    // 逐场列表：有标题就用标题，没有就退回时间；失败原因要显示出来
    const sess = q('[data-testid="task-sessions"]')!
    expect(sess.textContent).toContain('杂谈回')
    expect(sess.textContent).toContain('09-02 20:00')
    expect(sess.textContent).toContain('412')
  })

  it('关窗不停任务；「完成」才收尾并清掉状态', async () => {
    await startCollect(ARGS)
    await mount()
    await act(async () => { openTaskWindow() })
    await act(async () => { q<HTMLButtonElement>('[data-testid="task-done"]')!.click() })
    // 运行中点「完成」无效（按钮是灰的）
    expect(fanTask().state).toBe('running')

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    status.mockResolvedValue({ items: [prog({ state: 'done', done: 30 })], count: 1 })
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    await act(async () => { q<HTMLButtonElement>('[data-testid="task-done"]')!.click() })
    expect(fanTask().state).toBe('idle')
    expect(fanTask().openWindow).toBe(false)
    // Radix 关窗有动画：只要 store 收尾了就算对（DOM 可能还在）
  })

  it('失败：把原因写在正文里，不静默', async () => {
    status.mockResolvedValue({
      items: [prog({ state: 'failed', message: '上游 412 风控', failures: [
        { live_id: 'L3', start_at: '2026-09-03 20:00', reason: '风控' }] })],
      count: 1,
    })
    await startCollect(ARGS)
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    await mount()
    await act(async () => { openTaskWindow() })
    expect(q('[data-testid="task-summary"]')!.textContent).toContain('412')
    expect(q('[data-testid="task-failures"]')!.textContent).toContain('风控')
  })
})
