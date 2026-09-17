import { describe, expect, it } from 'vitest'
import {
  GESTURE_GAP_MS, LOCK_MS, MAX_CREDIT,
  initialWheelState, releaseAction, wheelAction,
} from './deckWheel'
import type { WheelState } from './deckWheel'

/**
 * 牌堆滚轮决策（R40）。这些用例**本来想在探针里做**，但虚拟时间下事件之间的
 * 时间差不可复现（150ms 手势分界测不出来）⇒ 按本仓分工搬到纯函数这一层，
 * 用确定性时间戳把两条通道的每个分支都钉住。
 */

/** 把一串 (deltaY, 间隔ms) 喂进去，返回索引轨迹与末态 */
function run(events: [number, number][], start = 0) {
  let s: WheelState = initialWheelState()
  let idx = start
  let t = 1000
  const trace: number[] = []
  for (const [dy, gap] of events) {
    t += gap
    const r = wheelAction(s, dy, t)
    s = r.state
    if (r.action.kind === 'step') idx += r.action.dir
    trace.push(idx)
  }
  return { idx, trace, state: s }
}

describe('滚轮：噪声', () => {
  it('小于噪声门槛的抖动不算手势', () => {
    const { idx, state } = run([[1, 16], [2, 16], [3, 16], [-1, 16]])
    expect(idx).toBe(0)
    expect(state.acc).toBe(0)          // 噪声连累积都不进
  })
})

describe('滚轮：离散格（鼠标）', () => {
  it('一格 = 一张', () => {
    expect(run([[100, 1000]]).idx).toBe(1)
    expect(run([[-100, 1000]], 5).idx).toBe(4)
  })

  it('**快拨要跟手**：连拨 4 格前进 4 张（锁只挡同一次爆发里的重复触发）', () => {
    // 每格间隔 200ms > 软锁 150ms ⇒ 每格都该落地
    expect(run([[100, 200], [100, 200], [100, 200], [100, 200]]).idx).toBe(4)
  })

  it('锁内不重复触发，但记欠账（**不吞输入**）', () => {
    // 40ms 内两格：第一格切，第二格记账
    const r1 = run([[100, 1000]])
    const t1 = 2000
    const a = wheelAction(r1.state, 100, t1 + 40)
    expect(a.action.kind).toBe('credit')
    expect(a.state.credit).toBe(1)
    // 解锁后消化：还要再切一张
    const rel = releaseAction(a.state)
    expect(rel.action).toEqual({ kind: 'release', dir: 1 })
    expect(rel.state.credit).toBe(0)
  })

  it('欠账封顶：一次甩 10 格不会飞到底', () => {
    let s = initialWheelState()
    let t = 1000
    let steps = 0
    for (let i = 0; i < 10; i += 1) {
      t += 10
      const r = wheelAction(s, 100, t)
      s = r.state
      if (r.action.kind === 'step') steps += 1
    }
    expect(steps).toBe(1)                        // 只有第一格落地
    expect(s.credit).toBe(MAX_CREDIT)            // 其余封顶成 2 格欠账
  })

  it('锁内反向输入记成反向欠账（快速来回最终回到原位）', () => {
    let s = initialWheelState()
    let t = 1000
    let r = wheelAction(s, 100, t)               // 向下切一张（进入软锁）
    s = r.state
    expect(r.action).toEqual({ kind: 'step', dir: 1 })
    t += 30                                      // 还在锁内
    r = wheelAction(s, -100, t)
    s = r.state
    expect(r.action.kind).toBe('credit')
    expect(s.credit).toBe(-1)                    // 反向被记下来，而不是被吞掉
    // 解锁时反向切回 ⇒ 净位移 0（"快速来回不会越走越远"）
    expect(releaseAction(s).action).toEqual({ kind: 'release', dir: -1 })
  })
})

describe('滚轮：连续流（触控板）', () => {
  it('累积到阈值切一张', () => {
    // 8px × 8 = 64 ≥ 60 ⇒ 第 8 次落地
    const evs: [number, number][] = Array.from({ length: 8 }, () => [8, 16] as [number, number])
    expect(run(evs).idx).toBe(1)
  })

  it('**惯性尾巴只算一次**：一次手势内不再切（这是"不飞到底"的根据）', () => {
    // 30 次 × 8px（同一手势，间隔 16ms < 150ms）⇒ 恰好一张
    const evs: [number, number][] = Array.from({ length: 30 }, () => [8, 16] as [number, number])
    const { idx, state } = run(evs)
    expect(idx).toBe(1)
    expect(state.smoothUsed).toBe(true)
  })

  it('反向同理', () => {
    const evs: [number, number][] = Array.from({ length: 30 }, () => [-8, 16] as [number, number])
    expect(run(evs, 3).idx).toBe(2)
  })

  it('静默够久算新手势 ⇒ 还能再切一张', () => {
    const first: [number, number][] = Array.from({ length: 10 }, () => [8, 16] as [number, number])
    const { state, idx } = run(first)
    // 隔 300ms（> 150ms 分界）再来一轮
    let s = state
    let i = idx
    let t = 1000 + 10 * 16 + 300
    for (let n = 0; n < 10; n += 1) {
      t += 16
      const r = wheelAction(s, 8, t)
      s = r.state
      if (r.action.kind === 'step') i += r.action.dir
    }
    expect(i).toBe(2)
  })

  it('慢速长划（每次间隔 > 分界）会变成多次手势 —— 每轮各切一张', () => {
    // 每次 60px 且间隔 400ms：每次都算独立手势 ⇒ 每次都落地
    const evs: [number, number][] = [[60, 400], [60, 400], [60, 400]]
    expect(run(evs).idx).toBe(3)
  })

  it('分界常量与锁不是同一个数（锁 150 只为防重复触发，不等于动画全长）', () => {
    expect(LOCK_MS).toBe(150)
    expect(GESTURE_GAP_MS).toBe(150)
  })
})
