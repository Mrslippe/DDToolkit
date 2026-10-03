// @vitest-environment jsdom
/**
 * 播放诊断窗口（devlog/306）：把"跳转后画面低帧率"这种**只在真机上出现**的现象
 * 变成一行可交付的数字。
 *
 * 这里钉的是**数字怎么算的**（纯函数），以及"收尾时真的上报了一行"——
 * 报的内容对不对，靠 `summarize` 的用例保证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientLog = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, dropped: false }))
vi.mock('../api/api', () => ({
  api: { clientLog: (line: unknown) => clientLog(line) },
}))

import { aheadOf, frameStats, openWindow, summarize, watchPlayback } from './playbackProbe'

class FakeMedia {
  currentTime = 0
  buffered = ranges(0, 0)
  private q = { totalVideoFrames: 0, droppedVideoFrames: 0 }
  getVideoPlaybackQuality() { return this.q }
  setFrames(total: number, dropped: number) { this.q = { totalVideoFrames: total, droppedVideoFrames: dropped } }
}

/** 造一个 `TimeRanges` 替身（jsdom 里没法真造）。 */
function ranges(start: number, end: number): TimeRanges {
  return { length: 1, start: () => start, end: () => end } as unknown as TimeRanges
}

function makeEl(): FakeMedia & HTMLVideoElement {
  return new FakeMedia() as FakeMedia & HTMLVideoElement
}

beforeEach(() => {
  clientLog.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('playbackProbe', () => {
  it('`frameStats` 优先用 `getVideoPlaybackQuality`，没有就退回 webkit*', () => {
    const el = makeEl()
    el.setFrames(120, 3)
    expect(frameStats(el)).toEqual({ frames: 120, dropped: 3 })

    const legacy = { webkitDecodedFrameCount: 90, webkitDroppedFrameCount: 1 } as unknown as HTMLVideoElement
    expect(frameStats(legacy)).toEqual({ frames: 90, dropped: 1 })
  })

  it('`aheadOf`：当前位置落在缓冲区间里才给数，否则 null', () => {
    const el = makeEl()
    el.currentTime = 10
    el.buffered = ranges(5, 18)
    expect(aheadOf(el)).toBeCloseTo(8, 3)
    el.currentTime = 2                      // 在区间外
    expect(aheadOf(el)).toBeNull()
  })

  it('`summarize`：窗口内帧率/丢帧算**增量**（不是累计值），并带上饿住次数与最低缓冲', () => {
    const el = makeEl()
    el.setFrames(300, 4)
    const w = openWindow(el, 'seek', 198.5)
    el.setFrames(480, 7)                    // 窗口里又解了 180 帧、丢了 3 帧
    w.waiting = 6
    w.minAhead = 0.2
    w.readyMs = 4200
    el.currentTime = 199
    el.buffered = ranges(190, 205)

    const line = summarize(w, el, w.startedAt + 10_000)   // 10 秒窗口
    expect(line).toContain('[video] seek→198.5s')
    expect(line).toContain('窗口=10.0s')
    expect(line).toContain('起播=4.2s')
    expect(line).toContain('饿住=6次')
    expect(line).toContain('最低缓冲=0.2s')
    expect(line).toContain('帧率=18.0fps')   // 180 帧 / 10 秒
    expect(line).toContain('丢帧=3/180')     // 增量，不是 7/480
    expect(line).toContain('已缓冲=6.0s')
  })

  it('窗口内没出画 ⇒ 明说"未出画"（不编一个 0.0s 出来）', () => {
    const el = makeEl()
    const w = openWindow(el, 'start')
    expect(summarize(w, el, w.startedAt + 8_000)).toContain('起播=未出画')
  })

  it('到点上报一行（走 `api.clientLog`），并带上 note* 记下的数字', async () => {
    const el = makeEl()
    const h = watchPlayback(el, 'seek', 100)
    h.noteWaiting()
    h.noteWaiting()
    h.noteAhead(1.5)
    h.noteAhead(0.3)                      // 取最小
    h.noteReady()
    el.setFrames(60, 0)
    await vi.advanceTimersByTimeAsync(8100)
    expect(clientLog).toHaveBeenCalledTimes(1)
    const line = clientLog.mock.calls[0][0] as unknown as string
    expect(line).toContain('seek→100.0s')
    expect(line).toContain('饿住=2次')
    expect(line).toContain('最低缓冲=0.3s')
  })

  it('`cancel` 之后不再上报（组件卸载/被新窗口顶掉时不该留一行）', async () => {
    const el = makeEl()
    const h = watchPlayback(el, 'seek', 50)
    h.cancel()
    await vi.advanceTimersByTimeAsync(9000)
    expect(clientLog).not.toHaveBeenCalled()
  })
})
