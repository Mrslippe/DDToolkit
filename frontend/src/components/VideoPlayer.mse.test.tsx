// @vitest-environment jsdom
/**
 * `VideoPlayer` 的 **MSE 内核**接线（devlog/312）。
 *
 * 这里钉的是"接上了没有"，不是内核自己的算法（那些在 `utils/mseKernel.test.ts`）：
 * ① 走 MSE 时**没有独立 `<audio>`**、元素上没有 `src`（流由 MediaSource 的 blob 提供）；
 * ② 拖进度条 ⇒ 取的是**目标那一段的字节范围**（`Range: bytes=…`）—— 这就是治"跳转后卡一帧"的那一步；
 * ③ 取不到段 ⇒ **自动退回渐进式**（音轨元素回来、元素拿回代理地址），不需要用户做任何事。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VideoPlayer from './VideoPlayer'
import { resetPlayerPrefs } from '../utils/playerPrefs'
import { resetVideoKernel } from '../utils/videoKernel'
import type { KernelStreams } from '../utils/mseKernel'

vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve(),
  // B2（devlog/381）：进/出全屏时会调它切窗口表面；jsdom 里没有壳，给个空实现
  setSurfaceOpaque: () => Promise.resolve(true),
  surfaceState: () => 'unknown', surfaceEverOpaque: () => false }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const SEG_DUR = 5
const SEG_COUNT = 8
const INIT_END = 947
const SEG0 = 948
const SEG_BYTES = 1000

function streams(prefix = 'v', count = SEG_COUNT, bandwidth = 0): KernelStreams {
  const seg = (kind: 'video' | 'audio') => ({
    url: `https://cn-x.bilivideo.com/${prefix}.m4s`,
    urls: [`https://cn-x.bilivideo.com/${prefix}.m4s`],
    mime: `${kind}/mp4; codecs="x"`,
    kind,
    init: { start: 0, end: INIT_END },
    segments: Array.from({ length: count }, (_, i) => ({
      i, start: SEG0 + i * SEG_BYTES, end: SEG0 + (i + 1) * SEG_BYTES - 1,
      dur_s: SEG_DUR, sap: true,
    })),
    duration_s: count * SEG_DUR,
    bandwidth,
  })
  return { video: seg('video'), audio: seg('audio'), duration_s: count * SEG_DUR }
}

const DASH = {
  video: 'https://cn-gddg-ct-01-12.bilivideo.com/v.m4s?sign=x',
  audio: 'https://cn-gddg-ct-01-12.bilivideo.com/a.m4s?sign=x',
}

/** 假 SourceBuffer：并发操作会抛（与 Chromium 一致）—— 内核必须单飞 */
class FakeSourceBuffer {
  updating = false
  mode = ''
  readonly ranges: [number, number][] = []
  private readonly listeners: Record<string, (() => void)[]> = {}
  constructor(readonly mime: string) {}
  get buffered() {
    const l = this.ranges
    return { length: l.length, start: (i: number) => l[i][0], end: (i: number) => l[i][1] }
  }
  addEventListener(t: string, fn: () => void) { (this.listeners[t] ??= []).push(fn) }
  private emit(t: string) { for (const fn of this.listeners[t] ?? []) fn() }
  /** 加一段并**归一化区间**：真 `TimeRanges` 永远是最大的连续区间（相邻会合并） */
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
  appendBuffer(buf: ArrayBuffer) {
    if (this.updating) throw new DOMException('busy', 'InvalidStateError')
    this.updating = true
    const dv = new DataView(buf)
    const s = dv.getFloat64(0)
    const e = dv.getFloat64(8)
    queueMicrotask(() => {
      this.updating = false
      if (e > s) this.addRange(s, e)
      this.emit('updateend')
    })
  }
  remove(_start: number, end: number) {
    if (this.updating) throw new DOMException('busy', 'InvalidStateError')
    this.updating = true
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
  readonly buffers: FakeSourceBuffer[] = []
  private readonly listeners: Record<string, (() => void)[]> = {}
  addEventListener(t: string, fn: () => void) {
    (this.listeners[t] ??= []).push(fn)
    if (t === 'sourceopen') queueMicrotask(() => { this.readyState = 'open'; fn() })
  }
  removeEventListener() { /* 忽略 */ }
  addSourceBuffer(mime: string) {
    const sb = new FakeSourceBuffer(mime)
    this.buffers.push(sb)
    return sb as unknown as SourceBuffer
  }
  endOfStream() { /* 结束 */ }
}

/**
 * 取段替身：把"这一段覆盖的时间"编进字节，内核的假 SourceBuffer 就能还原缓冲区间。
 *
 * `fail=true` 时**挂在闸门上不返回**，由用例调 `release()` 决定什么时候失败 ——
 * 失败时机必须是确定的（否则"回退时接着播"那条根本摆不好"已经在播"的前置状态）。
 */
function stubFetch(fail = false, delayMs = 0) {
  const calls: { url: string; range: string }[] = []
  let open: () => void = () => { /* 未启用闸门 */ }
  const gate = new Promise<void>((r) => { open = r })
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const range = new Headers(init?.headers).get('Range') ?? ''
    calls.push({ url, range })
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    if (fail) {
      await gate
      throw new TypeError('network down')
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range)
    const start = m ? Number(m[1]) : 0
    let t0 = 0
    let t1 = 1
    if (start !== 0) {
      const i = Math.floor((start - SEG0) / SEG_BYTES)
      t0 = i * SEG_DUR
      t1 = t0 + SEG_DUR
    }
    // ⚠️ 长度必须正好是请求的那一段（内核会校验，见 devlog/314）：固定 16 字节会被判"数据不对"
    const size = m ? Number(m[2]) - Number(m[1]) + 1 : 16
    const buf = new ArrayBuffer(size)
    const dv = new DataView(buf)
    dv.setFloat64(0, t0)
    dv.setFloat64(8, t1)
    return { ok: true, status: 206, arrayBuffer: async () => buf, text: async () => '' }
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls, release: () => open() }
}

async function flush(n = 30) {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * 等到条件成立（**按时间给预算**而不是"固定轮数"：这个环境里一轮 `setTimeout(0)` 实测要几毫秒，
 * 轮数写死会把 5s 的用例超时耗光 —— 这一批踩过一次，症状是"看起来功能坏了"，其实是等待太慢）。
 */
async function waitUntil(ok: () => boolean, budgetMs = 2500) {
  const t0 = Date.now()
  while (Date.now() - t0 < budgetMs) {
    if (ok()) return true
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  return ok()
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  resetPlayerPrefs()
  resetVideoKernel()
  vi.stubGlobal('MediaSource', FakeMediaSource)
  // jsdom 没有 `URL.createObjectURL`（真 WebView 有）
  Object.defineProperty(URL, 'createObjectURL',
                        { value: () => 'blob:mse', configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL',
                        { value: () => { /* 忽略 */ }, configurable: true, writable: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('VideoPlayer · MSE 内核（默认内核）', () => {
  it('走 MSE：**没有独立音轨**、元素上没有 `src`、总时长来自段表', async () => {
    stubFetch()
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} segments={streams()} />)
      await flush()
    })

    expect(host.querySelector('audio'), 'MSE 下音轨在同一条 SourceBuffer 上（这才是"一个钟"）')
      .toBeNull()
    const v = host.querySelector('video')!
    // ⚠️ 元素**不能**同时挂着渐进式的 `src`：那条流由 MediaSource 的 blob 提供
    expect(v.getAttribute('src')).toBe('blob:mse')
    // 总时长：段表 8×5=40s ⇒ 进度条立刻是 00:40（不用等 loadedmetadata）
    expect(host.querySelector('.vp-time')!.textContent).toContain('00:40')
  })

  it('**链路喂不饱这一档 ⇒ 自动降一级**，并在清晰度菜单里如实说明（ABR，devlog/328）', async () => {
    /**
     * 内核量"取回来的字节 / 耗时"，与段表里的码率比；连续几段都喂不饱就报事实，
     * 播放器据此降**一级**（走与"用户自己点档位"同一条路 ⇒ 菜单显示的是实际那一档）。
     * 这条用例把两半串起来跑：假网慢（每段 25ms、只有 1KB ⇒ ≈40KB/s）而段表写着 2Mbps。
     */
    stubFetch(false, 25)
    const onPickQuality = vi.fn()
    const qualities = [
      { id: 80, label: '高清 1080P' },
      { id: 64, label: '高清 720P' },
      { id: 32, label: '清晰 480P' },
    ]
    await act(async () => {
      root.render(
        <VideoPlayer video={{ url: DASH.video }} dash={DASH} permalink="https://b/1"
                      segments={streams('v', SEG_COUNT, 2_000_000)}
                      qualities={qualities} qualityId={80} onPickQuality={onPickQuality} />)
      await flush()
    })

    expect(await waitUntil(() => onPickQuality.mock.calls.length > 0, 6000),
           '链路喂不饱却一直不降 ⇒ 用户就一直卡').toBe(true)
    expect(onPickQuality, '只降**一级**（1080P ⇒ 720P）').toHaveBeenCalledWith(64)

    // 说明要看得见（菜单里一行，不弹窗）—— 用户得知道画质为什么掉了
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === '清晰度')!
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush() })
    const note = host.querySelector('[data-vp-autonote]')
    expect(note?.textContent, '自动降档不许静默').toContain('已自动降到 高清 720P')
    expect(note?.textContent).toContain('链路实测')
  })

  it('**多P 视频**：分P 菜单列出每一 P，点另一 P 回调 `onPickPage(cid)`（devlog/329）', async () => {
    /**
     * 起因：老实现永远只播第 1 P —— 实测某 7 P 直播实况（共 6.6 小时）在应用里只剩 76 分钟，
     * 而界面上**没有任何入口**（用户根本没机会发现丢了内容）。
     */
    stubFetch()
    const onPickPage = vi.fn()
    const pages = [
      { cid: 111, page: 1, part: '第一章', duration_s: 100 },
      { cid: 222, page: 2, part: '第二章', duration_s: 200 },
    ]
    await act(async () => {
      root.render(
        <VideoPlayer video={{ url: DASH.video }} dash={DASH} segments={streams()}
                      pages={pages} currentPage={1} onPickPage={onPickPage} />)
      await flush()
    })

    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === '分P')!
    expect(btn.textContent, '按钮显示当前在第几 P').toContain('P1')
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush() })

    const items = [...host.querySelectorAll('.vp-menu--page .vp-menu-item')]
    expect(items.map((b) => b.textContent)).toEqual(['P1 第一章', 'P2 第二章'])
    // 标题必须**在同一行**（P1 标题）且包在可滚动的 span 里 —— 只有 P1…P7 是 CSS 塌宽那次的形状
    expect(items[0].querySelector('.vp-page-label')?.textContent).toBe('P1 第一章')
    const p2 = items[1] as HTMLButtonElement
    await act(async () => { p2.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush() })
    expect(onPickPage, '切 P 要把那一 P 的 cid 交给调用方（它负责重取流）').toHaveBeenCalledWith(222)
  })

  it('**单P 视频**不渲染分P 菜单（多一个按钮纯属噪音）', async () => {
    stubFetch()
    await act(async () => {
      root.render(
        <VideoPlayer video={{ url: DASH.video }} dash={DASH} segments={streams()}
                      pages={[{ cid: 111, page: 1, part: '唯一一 P', duration_s: 100 }]}
                      currentPage={1} />)
      await flush()
    })
    expect([...host.querySelectorAll('button')]
      .some((b) => b.getAttribute('aria-label') === '分P')).toBe(false)
  })

  it('拖到未缓冲处 ⇒ 取的是**目标那一段**的字节范围（治"跳转后卡一帧"的那一步）', async () => {
    const { calls } = stubFetch()
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} segments={streams()} />)
      await flush()
    })
    const v = host.querySelector('video') as HTMLVideoElement
    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    calls.length = 0
    await act(async () => {
      // 80% ⇒ 32s ⇒ 第 7 段（30–35s），按段表它就是 bytes=6948-7947
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 80 }))
      await flush()
    })

    const want = `bytes=${SEG0 + 6 * SEG_BYTES}-${SEG0 + 7 * SEG_BYTES - 1}`
    expect(calls.map((c) => c.range), `跳转该取目标段 ${want}`).toContain(want)
    expect(calls.every((c) => c.url.includes('/video-proxy?url=')),
           '取段必须走本机代理（媒体 CDN 要 Referer）').toBe(true)
    expect(v.currentTime).toBeCloseTo(32, 1)
  })

  it('取段全失败 ⇒ **自动退回渐进式**（音轨回来、元素拿回代理地址），用户不用做任何事', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const net = stubFetch(true)
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} segments={streams()} />)
      await waitUntil(() => (host.querySelector('video')?.getAttribute('src') ?? '') === 'blob:mse')
    })
    // 内核已经建起来、正在取 init 段；这时放行失败 ⇒ 它自己会重试到放弃
    await act(async () => {
      net.release()
      await flush(40)
    })
    // ⚠️ 单独一个 act 边界：store（`useSyncExternalStore`）驱动的更新不会在"await 循环"里
    //    自己落地，要跨一次 act 才被 React 刷出来（测试环境的行为；生产里走微任务即可）
    await act(async () => { await Promise.resolve() })

    expect(host.querySelector('video')!.getAttribute('src'))
      .toBe(`/api/video-proxy?url=${encodeURIComponent(DASH.video)}`)
    expect(host.querySelector('audio'), '退回渐进式后音轨必须回来（否则没声音）').not.toBeNull()
    expect(host.querySelector('.vp-dead'), '这是内核回退，不是"播不了"').toBeNull()
    // 用户**没按过播放** ⇒ 内核回退不该顺手把画面播起来（那是最吓人的一种"自己动了"）
    expect(play.mock.contexts.filter((el) => (el as HTMLMediaElement).tagName === 'VIDEO').length,
           '没播放意图就别自动起播').toBe(0)
    play.mockRestore()
  })

  it('回退时**接着播**：位置承接、并继续放（否则用户看到"播到一半跳回开头/停住"）', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const net = stubFetch(true)
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH}
                                segments={streams()} autoPlay />)
      await waitUntil(() => Boolean(host.querySelector('video')))
    })
    const v = host.querySelector('video') as HTMLVideoElement
    // 摆好"已经播到 12 秒"（元素级意图 + 位置）—— **必须在放行失败之前**
    await act(async () => {
      v.currentTime = 12
      v.dispatchEvent(new Event('play'))
      await Promise.resolve()
    })
    await act(async () => {
      net.release()
      await flush(40)
    })
    // ⚠️ 单独一个 act 边界：store（`useSyncExternalStore`）驱动的更新不会在"await 循环"里
    //    自己落地，要跨一次 act 才被 React 刷出来（这是测试环境的行为，生产里走微任务即可）
    await act(async () => { await Promise.resolve() })
    expect(v.getAttribute('src'), '已经退回渐进式').toContain('/video-proxy?url=')
    expect(play.mock.contexts.filter((el) => (el as HTMLMediaElement).tagName === 'VIDEO').length,
           '有播放意图 ⇒ 回退后要接着放，不能停在原地').toBeGreaterThan(1)
    // ⚠️ 换 `src` 时**真浏览器会把位置清零**（加载算法），jsdom 不会 —— 这里手动补上，
    //    否则"承接位置"那条断言是空的（currentTime 本来就还是 12）。
    v.currentTime = 0
    await act(async () => {
      v.dispatchEvent(new Event('loadedmetadata'))
      await Promise.resolve()
    })
    expect(v.currentTime, '位置要承接（同一份媒体、同一条时间轴）').toBeCloseTo(12, 0)
    play.mockRestore()
  })

  it('跳转**先暂停**（不让旧内容继续放），目标段落地后自动接着放（devlog/317）', async () => {
    stubFetch()
    await act(async () => {
      // 200 秒的表：起播只缓冲前 20 秒 ⇒ 跳到 80%（160s）**必须去取段**，
      // 于是"目标段在路上"这段窗口可观察（8 段的表整片都在缓冲里，点了立刻落地，测不到）
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} segments={streams('v', 40)} />)
      await flush(30)
    })
    const v = host.querySelector('video') as HTMLVideoElement
    // 摆好"正在播"：jsdom 不维护 `paused`，按这条用例的需要在实例上钉一个可变值
    let paused = true
    Object.defineProperty(v, 'paused', { get: () => paused, configurable: true })
    const calls: string[] = []
    v.pause = () => { paused = true; calls.push('pause') }
    v.play = () => { paused = false; calls.push('play'); return Promise.resolve() }
    await act(async () => {
      void v.play()                               // 真的在播 ⇒ `paused=false`（组件据此判断要不要先停）
      v.dispatchEvent(new Event('play'))
      await Promise.resolve()
    })
    calls.length = 0

    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    // ⚠️ 用**同步** act 派发点击、并在里面立刻断言：取段替身是微任务完成的，
    //    只要 `await` 一次整条链就跑完了 ⇒ "目标段还在路上"那一段窗口必须同步看
    //    （异步 act 里断言会看到"已经落地并复播"，测不到用户报的那条）。
    act(() => {
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 80 }))
    })
    // MSE 下目标段还在路上（几百毫秒到几秒）——这段时间**不许**继续放旧内容
    expect(calls, '点完跳转还在放 = 用户看到的那条').toContain('pause')
    expect(paused).toBe(true)

    await act(async () => { await flush(60) })     // 等目标段落地
    expect(v.currentTime).toBeCloseTo(160, 0)
    expect(calls, '落地后要接着放（否则跳完停在那儿）').toContain('play')
    expect(paused).toBe(false)
  })

  it('播完 ⇒ 中央"重新播放"，点击回到 0 并接着放（devlog/317）', async () => {
    stubFetch()
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} segments={streams()} />)
      await flush(30)
    })
    const v = host.querySelector('video') as HTMLVideoElement
    let paused = true
    Object.defineProperty(v, 'paused', { get: () => paused, configurable: true })
    v.pause = () => { paused = true }
    v.play = () => { paused = false; return Promise.resolve() }

    await act(async () => {
      v.dispatchEvent(new Event('ended'))
      await Promise.resolve()
    })
    const replay = host.querySelector<HTMLButtonElement>('.vp-replay')!
    expect(replay, '播完要有"重新播放"').toBeTruthy()
    expect(host.querySelectorAll('.vp-bigplay:not(.vp-replay)').length,
           '两颗大键会叠在正中').toBe(0)

    await act(async () => { replay.click(); await flush(30) })
    expect(v.currentTime, '从头开始').toBeCloseTo(0, 1)
    expect(paused, '点了要真的放起来').toBe(false)
    expect(host.querySelector('.vp-replay'), '点了之后要收起').toBeNull()
    expect(host.querySelector('.vp-spin'), '落地了就别再转圈').toBeNull()
  })

  it('**拖拽松手要提交跳转**（MSE 下拖拽期间只动界面，松手走 settleAudio = 什么都没发生）', async () => {
    const { calls } = stubFetch()
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} segments={streams()} />)
      await flush(30)
    })
    const v = host.querySelector('video') as HTMLVideoElement
    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    calls.length = 0
    const ev = (type: string, x: number) =>
      bar.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x }))
    await act(async () => {
      ev('pointerdown', 20)
      ev('pointermove', 60)
      ev('pointermove', 80)
      ev('pointerup', 80)          // 松手 ⇒ 这才真去取目标段
      await flush(40)
    })
    const want = `bytes=${SEG0 + 6 * SEG_BYTES}-${SEG0 + 7 * SEG_BYTES - 1}`
    expect(calls.map((c) => c.range), `松手该取 80% 那一段（${want}）`).toContain(want)
    expect(v.currentTime, '松手不提交 = 拖完画面不动').toBeCloseTo(32, 1)
  })
})
