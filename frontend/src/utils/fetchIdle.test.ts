import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  affectsFanTrend,
  affectsLiveCalendar,
  dispatchFetchIdle,
  FETCH_IDLE_EVENT,
  onFetchIdle,
  type FetchIdleKind,
} from './fetchIdle'

/**
 * R2 第二步（devlog/080）：`fetch-idle` 带 kind 之后，"谁该刷新"变成一张判定表。
 * 这里把判定表与**兼容性**都钉住 —— 判断错的代价是"某张卡永远不刷新"，
 * 而那种 bug 在界面上极难察觉（趋势图少一个点不会报错）。
 */
describe('fetch-idle 的 kind 判定', () => {
  const offs: Array<() => void> = []
  /** vitest 跑在 node 环境（没有 DOM）→ 注入一个干净的宿主，判定表照样测得到 */
  let host: EventTarget
  beforeEach(() => {
    host = new EventTarget()
  })
  afterEach(() => {
    offs.splice(0).forEach((off) => off())
  })

  it('派发时去重，空数组不发', () => {
    const seen: FetchIdleKind[][] = []
    offs.push(onFetchIdle((k) => seen.push(k), host))
    dispatchFetchIdle([], host)
    dispatchFetchIdle(['account', 'account', 'posts'], host)
    expect(seen).toEqual([['account', 'posts']])
  })

  it('带 detail 的事件按 kinds 回调', () => {
    const seen: FetchIdleKind[][] = []
    offs.push(onFetchIdle((k) => seen.push(k), host))
    dispatchFetchIdle(['external'], host)
    expect(seen).toEqual([['external']])
  })

  it('老派发方（无 detail 的裸 Event）按「全都算」处理，不漏刷', () => {
    const seen: FetchIdleKind[][] = []
    offs.push(onFetchIdle((k) => seen.push(k), host))
    host.dispatchEvent(new Event(FETCH_IDLE_EVENT))
    expect(seen).toEqual([['account', 'posts', 'external']])
  })

  it('老消费者（直接 addEventListener）照旧能收到事件，不受 detail 影响', () => {
    const fn = vi.fn()
    host.addEventListener(FETCH_IDLE_EVENT, fn)
    dispatchFetchIdle(['posts'], host)
    expect(fn).toHaveBeenCalledTimes(1)
    host.removeEventListener(FETCH_IDLE_EVENT, fn)
  })

  it('趋势图只吃 account / external；日历三类都吃（动态流会落场次）', () => {
    expect(affectsFanTrend(['account'])).toBe(true)
    expect(affectsFanTrend(['external'])).toBe(true)
    // 关键：动态流（posts）不写快照，不该让趋势图重取 + 重建 ECharts
    expect(affectsFanTrend(['posts'])).toBe(false)
    expect(affectsFanTrend(['posts', 'account'])).toBe(true)

    // 日历：feed 页里的直播卡片会被落成 live_sessions（实测日志「直播场次入库 feed」），
    // 所以 posts 类刷新对它是**有意义**的
    expect(affectsLiveCalendar(['posts'])).toBe(true)
    expect(affectsLiveCalendar(['account'])).toBe(true)
    expect(affectsLiveCalendar(['external'])).toBe(true)
    expect(affectsLiveCalendar([])).toBe(false)
  })
})
