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

import {
  aheadOf, curveLine, frameStats, idleSeconds, openWindow, stalledSeconds,
  summarize, verdict, watchPlayback,
} from './playbackProbe'

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

  it('`aheadOf`：当前位置落在缓冲区间里才给数，否则 null；**负毛刺按"量不到"算**', () => {
    const el = makeEl()
    el.currentTime = 10
    el.buffered = ranges(5, 18)
    expect(aheadOf(el)).toBeCloseTo(8, 3)
    el.currentTime = 2                      // 在区间外
    expect(aheadOf(el)).toBeNull()
    el.currentTime = 19                     // 已经越过 end（读数毛刺）
    expect(aheadOf(el)).toBeNull()
  })

  it('`summarize`：窗口内帧率/丢帧算**增量**，并切出"前 3 秒 vs 后段"', () => {
    const el = makeEl()
    el.setFrames(300, 4)
    const w = openWindow(el, 'seek', 198.5)
    // 前 3 秒很惨（每秒 5 帧），之后正常（每秒 30 帧）
    for (let t = 1; t <= 3; t += 1) w.samples.push({ t, fps: 5, presented: 5, ahead: 0.4, advanced: true })
    for (let t = 4; t <= 10; t += 1) w.samples.push({ t, fps: 30, presented: 30, ahead: 6, advanced: true })
    w.pres.supported = true
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
    expect(line).toContain('解码=18.0fps')   // 180 帧 / 10 秒
    expect(line).toContain('呈现=22.5fps')   // (5×3 + 30×7) / 10 = 22.5（增量，不是累计）
    expect(line).toContain('前3秒=5.0')       // ← "开头差"这个事实必须留在行里
    expect(line).toContain('后段=30.0')       // ← 与"之后正常"对比
    expect(line).toContain('丢帧=3/180')     // 增量，不是 7/480
    expect(line).toContain('末缓冲=6.0s')
    expect(line, '缓冲只剩 0.2s 且反复饿 ⇒ 判定要直接写"数据受限"').toContain('判定=数据受限')
  })

  it('**呈现**侧：解码正常但没画出来 ⇒ 判定"呈现受限"（这是之前量不到的那一半）', () => {
    const el = makeEl()
    const w = openWindow(el, 'seek', 100)
    // 解码 30fps、呈现只有 8fps：帧解出来了，但没上屏
    for (let t = 1; t <= 6; t += 1) {
      w.samples.push({ t, fps: 30, presented: 8, ahead: 6, advanced: true })
    }
    w.pres.supported = true
    w.pres.maxGapMs = 700                        // 有一次 0.7 秒的大洞
    w.pres.gaps.push(700)
    w.minAhead = 6
    const line = summarize(w, el, w.startedAt + 6_000)
    expect(line).toContain('呈现=8.0fps')
    expect(line).toContain('最长停顿=0.70s')
    expect(line).toContain('停顿次数=1')
    expect(line).toContain('判定=呈现受限')
  })

  it('`verdict` 三态：数据受限 / 呈现受限 / 正常', () => {
    const w = openWindow(makeEl(), 'seek', 10)
    for (let t = 1; t <= 4; t += 1) w.samples.push({ t, fps: 30, presented: 30, ahead: 5, advanced: true })
    expect(verdict(w, 30)).toBe('正常(呈现量不到)')     // jsdom 没有 rVFC ⇒ 如实说量不到

    w.pres.supported = true
    expect(verdict(w, 30)).toBe('正常')

    const stalled = openWindow(makeEl(), 'seek', 10)
    stalled.pres.supported = true
    stalled.samples.push({ t: 1, fps: 0, presented: 0, ahead: 0.1, advanced: false })
    stalled.samples.push({ t: 2, fps: 0, presented: 0, ahead: 0.1, advanced: false })
    expect(verdict(stalled, 0)).toBe('数据受限')
  })

  it('真的挂上 `requestVideoFrameCallback`：回调间隔就是**卡顿本身**', async () => {
    type FrameCb = (now: number, meta: { presentedFrames?: number }) => void
    const holder: { cb: FrameCb | null } = { cb: null }
    const el = makeEl() as FakeMedia & HTMLVideoElement
    ;(el as unknown as { requestVideoFrameCallback: (f: FrameCb) => number })
      .requestVideoFrameCallback = (f) => { holder.cb = f; return 1 }
    const h = watchPlayback(el, 'seek', 10)
    // 两帧正常（33ms 间隔）→ **卡 1.2 秒** → 再两帧；`now` 是浏览器给的呈现时刻（可注入）
    let presented = 30
    for (const now of [1000, 1033, 1066, 2266, 2299]) {
      holder.cb?.(now, { presentedFrames: presented })
      presented += 30
    }
    await vi.advanceTimersByTimeAsync(1000)
    h.finish()
    const line = clientLog.mock.calls[0][0] as unknown as string
    expect(line).toContain('最长停顿=1.20s')
    expect(line).toContain('停顿次数=1')
  })

  it('**卡帧与空转分开**：`currentTime` 不动 = 数据没到；动了却没帧 = 解码/呈现', () => {
    const w = openWindow(makeEl(), 'seek', 10)
    w.samples.push({ t: 1, fps: 0, presented: 0, ahead: 0.1, advanced: false })  // 卡帧（数据没到）
    w.samples.push({ t: 2, fps: 0, presented: 0, ahead: 0.1, advanced: false })
    w.samples.push({ t: 3, fps: 0, presented: 0, ahead: 8.0, advanced: true })   // 空转（缓冲够、没出帧）
    w.samples.push({ t: 4, fps: 30, presented: 30, ahead: 8.0, advanced: true })
    expect(stalledSeconds(w)).toBe(2)
    expect(idleSeconds(w)).toBe(1)
  })

  it('`curveLine`：只在**确实有低谷**时给每一步曲线，并把"没前进"标出来', () => {
    const w = openWindow(makeEl(), 'seek', 10)
    for (let t = 1; t <= 6; t += 1) {
      w.samples.push({ t, fps: t <= 3 ? 4 : 30, presented: t <= 3 ? 4 : 30,
                       ahead: t <= 3 ? 0.3 : 6, advanced: t !== 2 })
    }
    const line = curveLine(w)
    expect(line).toContain('曲线(seek)')
    expect(line).toContain('1s:4fps/0.3')
    expect(line).toContain('2s:4fps/0.3*')     // `*` = 那一秒 currentTime 没前进
    expect(line).toContain('4s:30fps/6.0')

    const calm = openWindow(makeEl(), 'start')
    for (let t = 1; t <= 6; t += 1) {
      calm.samples.push({ t, fps: 30, presented: 30, ahead: 8, advanced: true })
    }
    expect(curveLine(calm), '一切正常就不该多刷一行').toBeNull()
  })

  it('到点上报一行（走 `api.clientLog`），并带上 note* 记下的数字', async () => {
    const el = makeEl()
    el.currentTime = 5                    // 落在缓冲区间外 ⇒ 每秒采样量不到 ahead，不会覆盖 note 的值
    const h = watchPlayback(el, 'seek', 100)
    h.noteWaiting()
    h.noteWaiting()
    h.noteAhead(1.5)
    h.noteAhead(0.3)                      // 取最小
    h.noteAhead(-1)                       // 负毛刺不算
    h.noteReady()
    el.setFrames(60, 0)
    await vi.advanceTimersByTimeAsync(31_000)
    // 第一行是汇总；**可能**跟一行每秒曲线（这个用例里 fake 时钟走了 30 秒而帧数没涨 ⇒ 判定"卡帧"）
    const line = clientLog.mock.calls[0][0] as unknown as string
    expect(line).toContain('seek→100.0s')
    expect(line).toContain('饿住=2次')
    expect(line).toContain('最低缓冲=0.3s')
    for (const call of clientLog.mock.calls.slice(1)) {
      expect(String(call[0])).toContain('[video] 曲线')
    }
  })

  it('`finish()` **先报再停**（关抽屉那几次也要留下证据），`cancel()` 才丢弃', async () => {
    const el = makeEl()
    const a = watchPlayback(el, 'seek', 10)
    a.noteWaiting()                      // 有内容才报（挂载即卸载那种空窗口不写垃圾行）
    a.finish()
    expect(clientLog, 'finish 要立刻上报').toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(clientLog, '上报过就不该再来一次').toHaveBeenCalledTimes(1)

    clientLog.mockClear()
    const b = watchPlayback(el, 'seek', 20)
    b.noteWaiting()
    b.cancel()
    await vi.advanceTimersByTimeAsync(31_000)
    expect(clientLog, 'cancel 是"丢弃"（被新窗口顶掉）').not.toHaveBeenCalled()
  })

  it('空窗口（挂载就被卸载）不写垃圾行', async () => {
    const el = makeEl()
    watchPlayback(el, 'start').finish()
    expect(clientLog).not.toHaveBeenCalled()
  })
})
