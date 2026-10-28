import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const collect = vi.fn()
const status = vi.fn()
const cancel = vi.fn()
const analyze = vi.fn()
const analyzeStatus = vi.fn()

vi.mock('../api/api', () => ({
  api: {
    fanCollect: (...a: unknown[]) => collect(...a),
    fanCollectStatus: (...a: unknown[]) => status(...a),
    fanCollectCancel: (...a: unknown[]) => cancel(...a),
    fanAnalyzeStart: (...a: unknown[]) => analyze(...a),
    fanAnalyzeStatus: (...a: unknown[]) => analyzeStatus(...a),
  },
}))

import {
  POLL_MS, cancelCollect, dismissTask, fanTask, fanTaskRunning, resetFanTask, startAnalyze,
  startCollect,
} from './useFanTask'

/** 一拍进度（后端 `FanCollectProgress` 的最小形状） */
function prog(over: Record<string, unknown> = {}) {
  return {
    vtuber: '弥月Mizuki', since: '2026-09-01', until: '2026-09-30', state: 'running',
    total: 30, done: 0, failed: 0, skipped: 0, current: '', message: '', elapsed: 1,
    ...over,
  }
}

const ARGS = {
  vtuber: '弥月Mizuki', since: '2026-09-01', until: '2026-09-30',
  liveIds: [{ live_id: 'L1', start_at: '2026-09-01 20:00' }], total: 30,
}

beforeEach(() => {
  resetFanTask()
  collect.mockReset().mockResolvedValue({ ok: true })
  status.mockReset().mockResolvedValue({ items: [prog({ done: 12 })], count: 1 })
  cancel.mockReset().mockResolvedValue({ ok: true })
  vi.useFakeTimers()
})

afterEach(() => {
  resetFanTask()
  vi.useRealTimers()
})

describe('useFanTask：任务状态在应用级', () => {
  it('发起采集：立刻 running，并把预估总场次摆出来（不编数字）', async () => {
    await startCollect(ARGS)
    const s = fanTask()
    expect(s.kind).toBe('collect')
    expect(s.state).toBe('running')
    expect(fanTaskRunning()).toBe(true)
    expect(s.progress?.total).toBe(30)
    expect(collect).toHaveBeenCalledWith('弥月Mizuki', '2026-09-01', '2026-09-30', ARGS.liveIds)
  })

  it('轮询一拍就更新进度（running ⇒ progress 换新）', async () => {
    await startCollect(ARGS)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(status).toHaveBeenCalledWith('弥月Mizuki')
    expect(fanTask().progress?.done).toBe(12)
    expect(fanTask().state).toBe('running')
  })

  it('结束后停在 done 上（带结果与结束时刻），轮询停掉', async () => {
    status.mockResolvedValue({ items: [prog({ state: 'done', done: 30 })], count: 1 })
    await startCollect(ARGS)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    const s = fanTask()
    expect(s.state).toBe('done')
    expect(s.result?.done).toBe(30)
    expect(s.finishedAt).toBeGreaterThan(0)
    expect(fanTaskRunning()).toBe(false)
    // 轮询已停：再走 3 拍也不会再请求
    const calls = status.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(status.mock.calls.length).toBe(calls)
  })

  it('失败把原因写进 error（不静默）', async () => {
    status.mockResolvedValue({
      items: [prog({ state: 'failed', message: '上游 412 风控' })], count: 1,
    })
    await startCollect(ARGS)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fanTask().state).toBe('failed')
    expect(fanTask().error).toContain('412')
  })

  it('后端没有任务条目 ⇒ 结束轮询，不许卡在"进行中"', async () => {
    status.mockResolvedValue({ items: [], count: 0 })
    await startCollect(ARGS)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fanTask().state).toBe('done')
    expect(fanTask().progress).toBeNull()
    expect(fanTaskRunning()).toBe(false)
  })

  it('发起请求就失败 ⇒ failed（否则顶栏会以为任务还在跑）', async () => {
    collect.mockRejectedValue(new Error('已有采集任务在运行'))
    await expect(startCollect(ARGS)).rejects.toThrow('已有采集任务')
    expect(fanTask().state).toBe('failed')
    expect(fanTask().error).toContain('已有采集任务')
  })

  it('同一时刻只许一个任务', async () => {
    await startCollect(ARGS)
    await expect(startCollect(ARGS)).rejects.toThrow('已有任务正在运行')
  })

  it('取消：只对运行中的采集有效，且打到当前主播', async () => {
    await startCollect(ARGS)
    await cancelCollect()
    expect(cancel).toHaveBeenCalledWith('弥月Mizuki')
  })

  it('dismissTask 只清已结束的任务（运行中不许把它清掉）', async () => {
    await startCollect(ARGS)
    dismissTask()
    expect(fanTask().state).toBe('running')
    status.mockResolvedValue({ items: [prog({ state: 'done', done: 30 })], count: 1 })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    dismissTask()
    expect(fanTask().state).toBe('idle')
    expect(fanTask().kind).toBeNull()
  })
})

describe('useFanTask：分析任务（2026-10-28）', () => {
  const A = { vtuber: '弥月Mizuki', window: 75, since: '2026-09-01', until: '2026-09-30' }

  function aprog(over: Record<string, unknown> = {}) {
    return {
      vtuber: '弥月Mizuki', window: 75, since: '2026-09-01', until: '2026-09-30',
      state: 'running', phase: 'load', done: 3, total: 75, current: '2026-09-12 22:00',
      error: '', started_at: 1, finished_at: null, ...over,
    }
  }

  beforeEach(() => {
    analyze.mockReset().mockResolvedValue({ ok: true, vtuber: '弥月Mizuki', window: 75, state: 'running' })
    analyzeStatus.mockReset().mockResolvedValue({ items: [aprog()], count: 1 })
  })

  it('kind = analyze，逐场进度映射成浮窗认识的形状', async () => {
    await startAnalyze(A)
    expect(analyze).toHaveBeenCalled()
    expect(fanTask().kind).toBe('analyze')
    expect(fanTask().state).toBe('running')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    const p = fanTask().progress!
    expect(p.done).toBe(3)
    expect(p.total).toBe(75)
    expect(p.phase).toBe('load')
    expect(p.current).toContain('09-12')
  })

  it('结束 ⇒ done，失败 ⇒ failed 且带原因；跨类型互斥', async () => {
    await startAnalyze(A)
    await expect(startCollect(ARGS)).rejects.toThrow('已有任务正在运行')
    analyzeStatus.mockResolvedValue({ items: [aprog({ state: 'done', done: 75 })], count: 1 })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fanTask().state).toBe('done')
    expect(fanTask().result?.done).toBe(75)
  })
})
