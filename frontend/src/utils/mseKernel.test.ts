// @vitest-environment jsdom
/**
 * MSE 内核（`utils/mseKernel.ts`，devlog/312）的判据。
 *
 * 这里用一个**会像 Chromium 那样拒绝并发操作**的假 SourceBuffer：`appendBuffer`/`remove`
 * 在 `updating` 期间再发一次就抛 `InvalidStateError`。spike 第一版正是栽在这上面
 * （`This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation`，
 * 泵一停缓冲从 5.5s 抽干到 `None`）—— 所以"单飞"这条必须由用例守着，而不是靠注释。
 *
 * 假元素/假 MediaSource 只实现内核真正用到的那几个面（`buffered` / `currentTime` /
 * `addSourceBuffer` / `endOfStream`），**不模拟解码** —— 测的是"取哪一段、什么时候设时间"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  KEEP_BEHIND, MAX_BUFFER, MseKernel, WANT_AHEAD, kernelSupported, mimeSupported,
  nextSegmentAfter, segmentIndexAt, type SegmentRange, type StreamTable,
} from './mseKernel'

const SEG_DUR = 5
const SEG_COUNT = 8
const INIT_END = 947
const SEG0_START = 948
const SEG_BYTES = 1000

function table(kind: 'video' | 'audio', count = SEG_COUNT): StreamTable {
  const segments = Array.from({ length: count }, (_, i) => ({
    i, start: SEG0_START + i * SEG_BYTES, end: SEG0_START + (i + 1) * SEG_BYTES - 1,
    dur_s: SEG_DUR, sap: true,
  }))
  return {
    url: `https://cn-x.bilivideo.com/${kind === 'video' ? 'v' : 'a'}.m4s`,
    urls: [`https://cn-x.bilivideo.com/${kind === 'video' ? 'v' : 'a'}.m4s`],
    mime: `${kind}/mp4; codecs="x"`,
    kind, init: { start: 0, end: INIT_END }, segments,
    duration_s: count * SEG_DUR,
  }
}

/** 两条轨的段表（默认 8 段 = 40s；淘汰那条用更长的表，40s 根本涨不到 `MAX_BUFFER`）。 */
function makeStreams(count = SEG_COUNT) {
  return { video: table('video', count), audio: table('audio', count),
           duration_s: count * SEG_DUR }
}

const STREAMS = makeStreams()

/** 把"这一段的起止秒"编进字节里，假 SourceBuffer 就能还原出"缓冲区间"（不必解析 MP4）。 */
function encodeRange(start: number, end: number, bytes = 16): ArrayBuffer {
  const buf = new ArrayBuffer(bytes)
  const dv = new DataView(buf)
  dv.setFloat64(0, start)
  dv.setFloat64(8, end)
  return buf
}

function decodeRange(buf: ArrayBuffer): [number, number] {
  const dv = new DataView(buf)
  return [dv.getFloat64(0), dv.getFloat64(8)]
}

class FakeTimeRanges {
  constructor(private readonly list: [number, number][]) {}
  get length() { return this.list.length }
  start(i: number) { return this.list[i][0] }
  end(i: number) { return this.list[i][1] }
}

class FakeSourceBuffer {
  updating = false
  mode = ''
  readonly ranges: [number, number][] = []
  readonly log: string[] = []
  /** 第几次 append 抛配额（其余正常）—— 用来测"先淘汰再重试" */
  quotaAt = 0
  /** 冻住：append 照常"成功"但**缓冲不涨** —— 模拟"取回来了却落不到该去的地方" */
  freeze = false
  private appends = 0
  private readonly listeners: Record<string, (() => void)[]> = {}

  constructor(readonly mime: string, private readonly seg: number,
              private readonly ms: { readyState: string }) {}

  get buffered() { return new FakeTimeRanges(this.ranges) }

  addEventListener(type: string, fn: () => void) {
    const list = (this.listeners[type] ??= [])
    list.push(fn)
  }

  private emit(type: string) {
    for (const fn of this.listeners[type] ?? []) fn()
  }

  appendBuffer(buf: ArrayBuffer) {
    // ⚠️ 真 Chromium 在 `updating` 期间会抛这个；假实现必须同样严格，否则用例测不出并发
    if (this.updating) {
      throw new DOMException('still processing an appendBuffer', 'InvalidStateError')
    }
    // ⚠️ `endOfStream()` 之后 `readyState` 是 `ended`，**append 与 remove 都不许再调**
    //    （真机上这是"取完之后 seek 永久失效"的一半原因，见 devlog/314）
    if (this.ms.readyState !== 'open') {
      throw new DOMException('MediaSource is not open', 'InvalidStateError')
    }
    this.appends += 1
    if (this.quotaAt && this.appends === this.quotaAt) {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    this.updating = true
    this.log.push('append')
    const [s, e] = decodeRange(buf)
    queueMicrotask(() => {
      this.updating = false
      if (e > s && !this.freeze) this.addRange(s, e - this.seg)
      this.emit('updateend')
    })
  }

  /**
   * 加一段缓冲并**归一化区间**。
   *
   * ⚠️ 真 `TimeRanges` 永远是"最大的连续区间"（相邻/重叠会合并）—— 假实现不合并的话，
   * "目标之后还有多少秒可用"这类判据会算小（实测把 [0,5)+[5,10)+… 读成"只有 4 秒"），
   * 于是用例报的是**夹具的错**（`devlog/313` 踩过）。
   */
  private addRange(s: number, e: number) {
    this.ranges.push([s, e])
    this.ranges.sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const [a, b] of this.ranges) {
      const last = merged[merged.length - 1]
      if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b)
      else merged.push([a, b])
    }
    this.ranges.splice(0, this.ranges.length, ...merged)
  }

  remove(start: number, end: number) {
    if (this.updating) {
      throw new DOMException('still processing a remove', 'InvalidStateError')
    }
    this.updating = true
    this.log.push(`remove:${start.toFixed(1)}-${end.toFixed(1)}`)
    queueMicrotask(() => {
      this.updating = false
      const kept = this.ranges.map(([s, e]) => [Math.max(s, end), e] as [number, number])
        .filter(([s, e]) => e > s)
      this.ranges.splice(0, this.ranges.length, ...kept)
      this.emit('updateend')
    })
  }
}

class FakeMediaSource {
  static isTypeSupported = (mime: string) => mime.includes('codecs="x"')
  readyState = 'closed'
  duration = NaN
  ended = false
  readonly buffers: FakeSourceBuffer[] = []
  private readonly listeners: Record<string, (() => void)[]> = {}

  constructor(private readonly seg: number) {}

  addEventListener(type: string, fn: () => void) {
    const list = (this.listeners[type] ??= [])
    list.push(fn)
    if (type === 'sourceopen') queueMicrotask(() => { this.readyState = 'open'; fn() })
  }

  removeEventListener() { /* 用例不关心 */ }

  addSourceBuffer(mime: string) {
    // ⚠️ 同一个 mime 加两次在真实现里会抛 NotSupportedError；假实现也拒绝（能抓住重复建轨）
    if (this.buffers.some((b) => b.mime === mime)) {
      throw new DOMException('duplicate', 'NotSupportedError')
    }
    const sb = new FakeSourceBuffer(mime, this.seg, this)
    this.buffers.push(sb)
    return sb as unknown as SourceBuffer
  }

  endOfStream() {
    this.ended = true
    this.readyState = 'ended'          // 真实现就是这样：之后 append/remove 一律抛错
  }
}

interface FakeEl {
  currentTime: number
  duration: number
  src: string
  buffered: FakeTimeRanges
  removeAttribute: (n: string) => void
  load: () => void
}

/**
 * 假元素：`buffered` 取**两条轨的交集**（真 MSE 的元素级 `buffered` 就是这个语义）。
 * 交集的实现逼着内核去读轨自己的区间（`trackSpan`）—— 这正是取段顺序的依据。
 */
function fakeEl(buffers: FakeSourceBuffer[]): FakeEl {
  const el: FakeEl = {
    currentTime: 0,
    duration: SEG_COUNT * SEG_DUR,
    src: '',
    buffered: new FakeTimeRanges([]),
    removeAttribute(name: string) { if (name === 'src') el.src = '' },
    load: () => { /* 释放解码器：假元素什么都不做 */ },
  }
  Object.defineProperty(el, 'buffered', {
    get() {
      const spans = buffers.map((b) => b.ranges).filter((r) => r.length)
      if (!spans.length) return new FakeTimeRanges([])
      // 交集：起点取**最靠后**的那个、终点取**最靠前**的那个（真 MSE 的元素级 buffered 就是这个）
      const start = Math.max(...spans.map((r) => r[0][0]))
      const end = Math.min(...spans.map((r) => r[r.length - 1][1]))
      return new FakeTimeRanges(end > start ? [[start, end]] : [])
    },
  })
  return el
}

/** 取段替身：按段表把"时间区间"编进字节（顺带记下取过哪些字节范围）。 */
function fetcher(seg = 0, failFor: (url: string, r: SegmentRange) => boolean = () => false) {
  const calls: { url: string; range: SegmentRange }[] = []
  const fn = vi.fn(async (url: string, range: SegmentRange) => {
    calls.push({ url, range })
    if (failFor(url, range)) throw new Error('boom')
    // ⚠️ **长度必须正好是请求的那一段**：内核会校验（`devlog/314` 的 Range 校验），
    //    夹具返回固定 16 字节的话每条取数都会被判成"数据不对"⇒ 整批用例假红。
    const size = range.end - range.start + 1
    if (range.start === 0) return encodeRange(0, 0, size)    // init：**不产生缓冲区间**
    const i = Math.floor((range.start - SEG0_START) / SEG_BYTES)
    const t = i * SEG_DUR
    return encodeRange(t, t + SEG_DUR + seg, size)
  })
  return { fn, calls }
}

/** 建一个内核 + 冲刷微任务，让 `sourceopen`/`updateend` 全部跑完。 */
async function boot(opts: { seg?: number; streams?: ReturnType<typeof makeStreams>
                            failFor?: (u: string, r: SegmentRange) => boolean
                            useDefaultFetch?: boolean } = {}) {
  const seg = opts.seg ?? 0
  const streams = opts.streams ?? STREAMS
  const ms = new FakeMediaSource(seg)
  const f = fetcher(seg, opts.failFor)
  const el = fakeEl(ms.buffers)
  const onFatal = vi.fn()
  const onSeekApplied = vi.fn()
  const logs: string[] = []
  const kernel = new MseKernel(el as unknown as HTMLVideoElement, {
    createMediaSource: () => ms as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => { /* 忽略 */ },
    // `useDefaultFetch`：走**真实**的取数实现（`/video-proxy` + Range 校验），用来测它
    ...(opts.useDefaultFetch ? {} : { fetchRange: f.fn }),
    onFatal, onSeekApplied,
    log: (line) => { logs.push(line) },
  })
  const ok = kernel.load(streams)
  await flush(20)
  return { kernel, ms, el, f, onFatal, onSeekApplied, ok, logs }
}

/** 冲刷到"泵暂时没事干"为止：每轮给微任务 + 一个宏任务（`updateend` 走的是微任务队列）。 */
async function flush(n = 4) {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

beforeEach(() => {
  vi.stubGlobal('MediaSource', FakeMediaSource)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mseKernel · 纯函数', () => {
  it('时间 → 段序号（含边界与越界）', () => {
    const t = table('video')
    expect(segmentIndexAt(t, 0)).toBe(0)
    expect(segmentIndexAt(t, 4.99)).toBe(0)
    expect(segmentIndexAt(t, 5)).toBe(1)
    expect(segmentIndexAt(t, 39)).toBe(7)
    expect(segmentIndexAt(t, 1e6)).toBe(7)          // 越界夹到末段
    expect(segmentIndexAt({ ...t, segments: [] }, 3)).toBe(-1)
  })

  it('"这一段之后该取哪一段"：判据是"这一段的**结尾**越过 time 了没有"', () => {
    const t = table('video')
    // 空缓冲（time=0）⇒ 该取第 1 段
    expect(nextSegmentAfter(t, 0)).toBe(0)
    // ⚠️ 缓冲正好到 5.0（= 第 2 段的**开头**）⇒ 该取**第 2 段**，不是第 3 段。
    //    差这一格 = 泵隔一段取一段 ⇒ 缓冲里每隔 5 秒一个洞 ⇒ 真机"播放一会停下、再播一会停下"。
    expect(nextSegmentAfter(t, 5)).toBe(1)
    expect(nextSegmentAfter(t, 4.9)).toBe(0)
    expect(nextSegmentAfter(t, 1e6)).toBe(SEG_COUNT)   // 取完了 ⇒ 段数
  })

  it('`kernelSupported` 说出"为什么不行"（真机上这行字是唯一的解释）', () => {
    expect(kernelSupported(STREAMS)).toEqual({ ok: true, why: '' })
    expect(kernelSupported({ video: STREAMS.video, audio: null }).ok).toBe(false)
    expect(kernelSupported({ video: STREAMS.video, audio: null }).why).toContain('音轨')
    expect(kernelSupported(null).ok).toBe(false)
    expect(mimeSupported('video/mp4; codecs="nope"')).toBe(false)
    vi.stubGlobal('MediaSource', undefined)
    expect(mimeSupported('video/mp4; codecs="x"')).toBe(false)
    expect(kernelSupported(STREAMS).why).toContain('MediaSource')
  })
})

describe('mseKernel · 起播与泵', () => {
  it('两条轨各挂一份 init，且**同一条轨上永远只有一个操作**（并发就抛 InvalidStateError）', async () => {
    const { ms, f, ok } = await boot()
    expect(ok).toBe(true)
    expect(ms.buffers.length, '音视频各一条 SourceBuffer').toBe(2)
    expect(ms.buffers.map((b) => b.mime)).toEqual([STREAMS.video.mime, STREAMS.audio.mime])
    // 两轨都取了 init（字节数最小的那两次）
    const inits = f.calls.filter((c) => c.range.start === 0)
    expect(inits.length).toBe(2)
    // 假 SourceBuffer 在 updating 期间再被 append 会抛 —— 走到这里没抛就是"单飞"成立。
    // 另一面：两条轨**可以并行**（不同的 SourceBuffer），别串行成一条慢队列。
    expect(f.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('泵把前方缓冲填到目标（WANT_AHEAD），且**中间不许有洞**', async () => {
    const { kernel, el, ms } = await boot()
    const videoBuf = ms.buffers[0]
    // ⚠️ **连续性**才是这条用例的重点（`devlog/313`）：旧断言只看"最后一段够远"，
    //    而泵隔一段取一段时缓冲里全是洞（[0,5][10,15][20,25]…）它照样绿 ——
    //    真机上那就是"播放一会停下、再播一会停下"。
    expect(videoBuf.ranges.length, `缓冲被切成了 ${videoBuf.ranges.length} 段（有洞）：`
           + JSON.stringify(videoBuf.ranges)).toBe(1)
    expect(videoBuf.ranges[0][0]).toBe(0)
    const end = videoBuf.ranges[videoBuf.ranges.length - 1][1]
    expect(end).toBeGreaterThanOrEqual(WANT_AHEAD)
    expect(end).toBeLessThanOrEqual(WANT_AHEAD + SEG_DUR * 2)
    expect(kernel.bufferedAhead(), '前方缓冲要正').toBeGreaterThan(0)
    expect(el.buffered.length, '元素级 buffered = 两轨交集').toBeGreaterThan(0)
  })

  it('`setDur` 那种"总时长"来自段表（MSE 的 duration 默认是 Infinity）', async () => {
    const { kernel, ms } = await boot()
    expect(kernel.duration()).toBe(SEG_COUNT * SEG_DUR)
    expect(ms.duration).toBe(SEG_COUNT * SEG_DUR)
  })

  it('**全部段取完之后仍然能 seek** —— 不许 `endOfStream()`（真机"再跳转一直转圈"的根因）', async () => {
    // 机理（`devlog/314`）：跳到末尾附近 ⇒ 两条轨的段全取完 ⇒ 旧实现调 `endOfStream()`
    // ⇒ `readyState='ended'` ⇒ 之后 append 抛错、而且 `pump()` 开头就返回
    // ⇒ **任何后续 seek 永远落不了地**（连 10 秒收手也一起失效）。
    const { kernel, el, onSeekApplied } = await boot({ streams: makeStreams(SEG_COUNT) })
    kernel.seekTo(SEG_COUNT * SEG_DUR - 0.5)      // 跳到末尾：泵会把剩下的段全部取完
    await flush(60)
    expect(onSeekApplied).toHaveBeenLastCalledWith(SEG_COUNT * SEG_DUR - 0.5)

    kernel.seekTo(10)                             // 再跳回来 —— 这一下必须还能落地
    await flush(60)
    expect(onSeekApplied, '取完之后 seek 失效 = 一直转圈').toHaveBeenLastCalledWith(10)
    expect(el.currentTime).toBeCloseTo(10, 0)
  })
})

describe('mseKernel · seek（先取段，再设时间）', () => {
  it('目标段**没落地之前不动 `currentTime`**（MSE 下会设到未缓冲处 ⇒ 被浏览器夹回旧位置）', async () => {
    const { kernel, el, f, onSeekApplied } = await boot()
    const before = el.currentTime
    kernel.seekTo(30)                       // 第 6 段（30–35s），前面只缓冲了 0–20s
    expect(el.currentTime, '立刻设时间就是那个"拖了没反应"的 bug').toBe(before)
    await flush(4)
    // 目标段取到了 ⇒ 这时才设
    expect(f.calls.some((c) => c.range.start === SEG0_START + 6 * SEG_BYTES)).toBe(true)
    expect(el.currentTime).toBeCloseTo(30, 1)
    expect(onSeekApplied).toHaveBeenCalledWith(30)
  })

  it('已经缓冲过的地方 ⇒ 同步落地（不重取那一段）', async () => {    const { kernel, el, f, onSeekApplied } = await boot()
    const n = f.calls.length
    kernel.seekTo(6)
    // eslint-disable-next-line no-console
    console.log('DBG6 cur=', el.currentTime, 'ahead=', kernel.bufferedAhead(),
                'applied=', JSON.stringify(onSeekApplied.mock.calls))
    expect(el.currentTime).toBeCloseTo(6, 1)
    expect(onSeekApplied).toHaveBeenCalledWith(6)
    // 落点在第 2 段（5–10s），它**已经在缓冲里** ⇒ 不该再取一次。
    // （泵会继续往前预取，那是**对的**：目标往后挪了，"前方 20 秒"要重新算。）
    const refetched = f.calls.slice(n)
      .some((c) => c.range.start === SEG0_START + 1 * SEG_BYTES)
    expect(refetched, '已缓冲的那一段不该再取一次').toBe(false)
  })

  it('连续拖拽：旧目标的在飞请求被丢掉，最终只认最后一个（用户抬手在哪就在哪）', async () => {
    const { kernel, el } = await boot()
    kernel.seekTo(10)
    kernel.seekTo(35)
    kernel.seekTo(20)
    await flush(12)
    expect(el.currentTime).toBeCloseTo(20, 1)
  })

  it('**播放点往前走之后泵要接着补**（别让前方掉到 0 —— 那就是"走一段停一段"）', async () => {
    // 真机症状 1 的收口判据：跳转落地只是一半，**播着播着还能不能续上**是另一半。
    const { kernel, el } = await boot({ streams: makeStreams(40) })
    kernel.seekTo(60)
    await flush(30)
    expect(el.currentTime).toBeCloseTo(60, 0)
    expect(kernel.bufferedAhead()).toBeGreaterThan(0)

    el.currentTime = 72                        // 模拟已经播了 12 秒（远超手里那一段）
    await new Promise((r) => setTimeout(r, 450))   // 等那一拍 400ms 的泵
    await flush(30)
    expect(kernel.bufferedAhead(),
           '播放点前进后前方还是空的 ⇒ 真机上就是"播一会停下、再播一会停下"').toBeGreaterThan(5)
  })

  it('音轨比视频短（两条流时长能差零点几秒）⇒ 跳到视频尾部也要落地，**不能死循环 append**', async () => {
    // 视频 8 段（40s）、音轨 6 段（30s）：跳到 35s 时音轨永远"盖不到"这个位置
    const streams = { ...makeStreams(SEG_COUNT), audio: table('audio', 6),
                      duration_s: SEG_COUNT * SEG_DUR }
    const { kernel, el, f, onSeekApplied } = await boot({ streams })
    const before = f.calls.length
    kernel.seekTo(35)
    await flush(30)
    expect(onSeekApplied, '音轨到头了不该拖住这次 seek').toHaveBeenCalledWith(35)
    expect(el.currentTime).toBeCloseTo(35, 1)
    // 死循环的症状就是请求数爆掉（一遍遍 append 音轨最后一段）
    expect(f.calls.length - before, `取数次数爆了：${f.calls.length - before}`)
      .toBeLessThan(SEG_COUNT * 2)
  })

  it('**回跳**（第二次 seek）不许把"刚为目标取来的段"淘汰掉 —— 否则永远转圈', async () => {
    // 真机报的第二个症状：「点击跳转后再点击跳转到其他位置，播放就卡住了，一直在转圈缓冲」。
    // 机理：淘汰算的是 `currentTime - KEEP_BEHIND`，而 seek 期间 `currentTime` **还是旧位置**
    // ⇒ 回跳时"保留窗口"落在旧位置附近，**把刚为目标取的 [B,B+5) 一起删掉** ⇒ covers 永远为假
    // ⇒ 泵一遍遍重取、播放点永远落不了地。
    const { kernel, el, f, onSeekApplied } = await boot({ streams: makeStreams(40) })
    kernel.seekTo(150)                       // 先跳到很后面（缓冲跨过 MAX_BUFFER）
    await flush(40)
    expect(el.currentTime).toBeCloseTo(150, 0)

    f.calls.length = 0
    kernel.seekTo(20)                        // 再回跳
    await flush(60)
    expect(onSeekApplied, '回跳也必须落地').toHaveBeenLastCalledWith(20)
    expect(el.currentTime, '一直转圈的判据就是它没落地').toBeCloseTo(20, 0)
    expect(kernel.bufferedAhead(), '回跳之后前方要有数据').toBeGreaterThan(0)
    expect(f.calls.length, `反复取同几段 = 已经被删了又取：${f.calls.length}`).toBeLessThan(40)
  })

  it('seek 彻底落不了地（数据一直不来）⇒ **到点收手**，别让界面永远转圈', async () => {
    // 正常路径走不到这里（取数**失败**会熔断退渐进式；这里模拟的是"取数一直不回来"）。
    // 留这条是因为"永远转圈"是用户视角里最糟的失败形态 —— 到点把播放点挪过去
    // （浏览器会夹到最近的已缓冲位置）并记一行，至少还能操作。
    const ms = new FakeMediaSource(0)
    const el = fakeEl(ms.buffers)
    const onSeekApplied = vi.fn()
    const kernel = new MseKernel(el as unknown as HTMLVideoElement, {
      createMediaSource: () => ms as unknown as MediaSource,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => { /* 忽略 */ },
      // ⚠️ **永不 resolve 也不理会 abort**：这正是"界面一直转圈"的那种卡
      fetchRange: vi.fn(() => new Promise<ArrayBuffer>(() => { /* 挂着 */ })),
      onSeekApplied,
      seekGiveUpMs: 0,                            // 把 10 秒压成 0（用例不真等）
    })
    kernel.load(STREAMS)
    await flush(10)
    kernel.seekTo(30)
    await flush(20)
    expect(onSeekApplied, '到点还不收手 ⇒ 用户永远看着转圈').toHaveBeenCalledWith(30)
  })
})

describe('mseKernel · 配额与失败', () => {
  it('取数**不推进**（缓冲不涨）⇒ 报一次 + 刹车：不许刷爆日志/CDN', async () => {
    // 起因（`devlog/314`）：真机上报「出错时日志里 info 爆发式增长」= 取数在打转。
    // 判据不看"同一段取了几次"（索引会交替，数不出来），只看**缓冲有没有真的涨**。
    const { kernel, ms, f, logs } = await boot({ streams: makeStreams(40) })
    kernel.seekTo(120)                     // 让泵有事可做
    for (const b of ms.buffers) b.freeze = true     // 之后取回来的数据**不落区间**
    const before = f.calls.length
    await flush(120)
    await new Promise((r) => setTimeout(r, 300))

    const stalls = logs.filter((l) => l.includes('泵无进展'))
    expect(stalls.length, `"泵在原地打转"要**只报一次**，实得：${JSON.stringify(logs)}`).toBeLessThanOrEqual(2)
    expect(stalls[0]).toContain('可用=')          // 那一行必须带上判断依据
    // 刹车：没有它就会以"网络允许的最快速度"一直取（每条代理日志一行）
    expect(f.calls.length - before, `取数次数爆了（${f.calls.length - before}）`).toBeLessThan(30)
  })

  it('上游忽略 `Range`（回 200 整份文件）⇒ **不当成功**（否则第 1 段的字节会被当成第 N 段）', async () => {
    // 机理（`devlog/314`）：数据落在错误的时刻上 ⇒ `covers(目标)` 永远为假 ⇒ 一直转圈；
    // 而泵还在一次次重取整份文件 ⇒ 真机"日志 INFO 暴增 + 卡顿低帧率"。
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      seen.push(String(input))
      return { ok: true, status: 200, text: async () => '',
               arrayBuffer: async () => new ArrayBuffer(4096) }
    }))
    const { onFatal, logs } = await boot({ useDefaultFetch: true })
    expect(seen.length, '确实走的是真实取数').toBeGreaterThan(0)
    expect(seen[0], '请求要经本机代理并带 Range').toContain('/video-proxy?url=')
    expect(onFatal, '拿不到"正确的那一段"就不该继续假装能播').toHaveBeenCalled()
    expect(logs.join(' ')).toContain('Range')
  })

  it('段长不对（上游截短/多给）⇒ 换镜像重试，不 append 垃圾数据', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1
      return { ok: true, status: 206, text: async () => '',
               arrayBuffer: async () => new ArrayBuffer(n === 1 ? 4096 : 16) }
    }))
    const { onFatal, logs, ms } = await boot({ useDefaultFetch: true })
    expect(onFatal).toHaveBeenCalled()
    expect(logs.join(' ')).toContain('长度不对')
    expect(ms.buffers[0].log, '错的数据不该被 append 进去').not.toContain('append')
  })

  it('QuotaExceededError ⇒ **先淘汰再重试**，不是当场判死', async () => {
    // 80 秒的表：40 秒的表根本涨不过 `MAX_BUFFER`，测不到淘汰
    const { kernel, ms, onFatal, el } = await boot({ streams: makeStreams(16) })
    kernel.seekTo(60)                        // 跳到靠后的位置 ⇒ 缓冲跨过 MAX_BUFFER
    await flush(30)
    const log = ms.buffers[0].log.join(' ')
    expect(log, `缓冲超 ${MAX_BUFFER}s 就该淘汰，实际动作：${log}`).toContain('remove:')
    expect(onFatal).not.toHaveBeenCalled()
    expect(kernel.bufferedAhead(), '淘汰之后前方照样有数据（别把当前播放点砍掉）')
      .toBeGreaterThan(0)
    expect(el.currentTime).toBeCloseTo(60, 1)
    expect(KEEP_BEHIND).toBeLessThan(MAX_BUFFER)
  })

  it('配额在 append 上抛 ⇒ 淘汰后重试成功（一次配额不是故障）', async () => {
    const seg = 0
    const ms = new FakeMediaSource(seg)
    const f = fetcher(seg)
    const el = fakeEl(ms.buffers)
    const onFatal = vi.fn()
    const kernel = new MseKernel(el as unknown as HTMLVideoElement, {
      createMediaSource: () => ms as unknown as MediaSource,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => { /* 忽略 */ },
      fetchRange: f.fn, onFatal,
    })
    kernel.load(STREAMS)
    await flush(4)
    // 先把缓冲填起来，再让第 N 次 append 撞配额
    ms.buffers[0].quotaAt = ms.buffers[0].log.length + 3
    for (let i = 0; i < 20; i += 1) kernel.seekTo(i * 3)
    await flush(40)
    expect(ms.buffers[0].log.filter((l) => l === 'append').length).toBeGreaterThan(2)
  })

  it('段取不到（所有镜像都失败）⇒ onFatal **只报一次**（调用方据此退回渐进式）', async () => {
    const { onFatal } = await boot({ failFor: () => true })
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(String(onFatal.mock.calls[0][0])).toContain('取不到')
  })

  it('镜像链：首选挂了就换下一条（B站 baseUrl 常是 P2P 主机）', async () => {
    const seg = 0
    const ms = new FakeMediaSource(seg)
    const f = fetcher(seg, (url) => url.includes('cn-x'))
    const el = fakeEl(ms.buffers)
    const streams = {
      ...STREAMS,
      video: { ...STREAMS.video, urls: ['https://cn-x.bilivideo.com/v.m4s',
                                       'https://up-y.bilivideo.com/v.m4s'] },
    }
    const kernel = new MseKernel(el as unknown as HTMLVideoElement, {
      createMediaSource: () => ms as unknown as MediaSource,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => { /* 忽略 */ },
      fetchRange: f.fn, onFatal: vi.fn(),
    })
    kernel.load(streams)
    await flush(10)
    expect(f.calls.some((c) => c.url.includes('up-y')), '没换镜像就永远取不到段').toBe(true)
  })
})

describe('mseKernel · 收尾', () => {
  it('destroy 摘掉 blob src（且**不**动 React 已经换上的新地址）', async () => {
    const { kernel, el } = await boot()
    expect(el.src).toBe('blob:test')
    kernel.destroy()
    expect(el.src).toBe('')
    // 退回渐进式那一刻的顺序是"React 先改 src、effect 清理后跑" ⇒ 清理不能擦掉新地址
    const el2 = fakeEl([])
    const k2 = new MseKernel(el2 as unknown as HTMLVideoElement, {
      createMediaSource: () => new FakeMediaSource(0) as unknown as MediaSource,
      createObjectURL: () => 'blob:test2',
      revokeObjectURL: () => { /* 忽略 */ },
      fetchRange: fetcher(0).fn,
    })
    k2.load(STREAMS)
    expect(el2.src).toBe('blob:test2')
    el2.src = '/api/video-proxy?url=x'          // ← React 提交时换上去的新地址
    k2.destroy()
    expect(el2.src, '把渐进式的地址一起擦掉 = 点了播放没反应').toBe('/api/video-proxy?url=x')
  })

  it('没有 MediaSource 的宿主 ⇒ load 返回 false 且 onFatal 报文（调用方退渐进式）', () => {
    vi.stubGlobal('MediaSource', undefined)
    const el = fakeEl([])
    const onFatal = vi.fn()
    const kernel = new MseKernel(el as unknown as HTMLVideoElement, { onFatal })
    expect(kernel.load(STREAMS)).toBe(false)
    expect(onFatal).toHaveBeenCalledTimes(1)
  })
})
