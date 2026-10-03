/**
 * 播放诊断（2026-10-03，devlog/306/307）：把"跳转后画面低帧率"这类**只在真机上出现**的现象
 * 变成一行可以交给开发者的数字。
 *
 * ## 为什么要它（以及第一版为什么不够）
 *
 * 用户报的是：「点跳转 → 画面先卡在一帧 → 以很低的帧率播一段 → 再正常；音频全程正常」。
 * 第一版只量"8 秒一行的平均帧率"，真机跑了几次**只留下一行**：
 * 平均会把 3 秒的低谷抹平；而且窗口被顶掉、或组件卸载时**整条丢弃**（`cancel`）——
 * 偏偏"关掉抽屉那几次"才是要看的那几次。
 *
 * ## 这一版量什么（能直接分开两种病因）
 *
 * 每秒采一次样，记 `currentTime` 与**解码帧数的增量**：
 * · `currentTime` 不前进 ⇒ **数据没到**（卡帧/饿住）；
 * · `currentTime` 前进但这一秒一帧都没解出来 ⇒ **帧没被解出/没被呈现**（解码或合成的问题）。
 * 再把窗口切成"前 3 秒 vs 之后"——用户描述的就是"开头差、之后正常"，这两段一比就出来。
 * 窗口 30 秒；**卸载时把已采到的先报出去**（不再丢弃）。
 */
import { api } from '../api/api'

interface Sample {
  /** 第几秒（1 起） */
  t: number
  /** 这一秒**解出**多少帧（`getVideoPlaybackQuality`） */
  fps: number
  /** 这一秒**呈现**了多少帧（`requestVideoFrameCallback` 的 `presentedFrames` 增量）；量不到 = null */
  presented: number | null
  /** 这一秒末的前方缓冲（秒）；量不到 = null */
  ahead: number | null
  /** 这一秒 `currentTime` 有没有前进（没前进 = 数据没到） */
  advanced: boolean
  /** 这一秒页面是不是**被浏览器判为不可见**（`document.visibilityState === 'hidden'`：
   *  切走、最小化、以及 Windows 上的"窗口被完全遮挡"都会落到这里） */
  hidden: boolean
  /** 这一秒页面有没有焦点（部分遮挡/失焦时 Chromium 会降级渲染） */
  focused: boolean
}

export interface PlaybackWindow {
  reason: string
  targetS?: number
  startedAt: number
  baseFrames: number
  baseDropped: number
  waiting: number
  minAhead: number | null
  readyMs: number | null
  samples: Sample[]
  /** **呈现**侧（`requestVideoFrameCallback`）：见 `summarize` 的"判定" */
  pres: { supported: boolean; maxGapMs: number; gaps: number[] }
}

const WINDOW_MS = 30_000
const SAMPLE_MS = 1_000
/** 低于后段的这个比例就认为"开头确实差"，多报一行每秒曲线 */
const DIP_RATIO = 0.7

/** 帧计数（Chromium 有 `getVideoPlaybackQuality`；没有就退回 webkit* 字段）。 */
export function frameStats(el: HTMLVideoElement): { frames: number; dropped: number } {
  const q = el.getVideoPlaybackQuality?.()
  if (q) return { frames: q.totalVideoFrames ?? 0, dropped: q.droppedVideoFrames ?? 0 }
  const legacy = el as HTMLVideoElement & {
    webkitDecodedFrameCount?: number; webkitDroppedFrameCount?: number
  }
  return { frames: legacy.webkitDecodedFrameCount ?? 0, dropped: legacy.webkitDroppedFrameCount ?? 0 }
}

export function openWindow(el: HTMLVideoElement, reason: string, targetS?: number): PlaybackWindow {
  const { frames, dropped } = frameStats(el)
  return { reason, targetS, startedAt: performance.now(), baseFrames: frames,
           baseDropped: dropped, waiting: 0, minAhead: null, readyMs: null, samples: [],
           pres: { supported: false, maxGapMs: 0, gaps: [] } }
}

/** 当前位置前方还有多少秒缓冲（不在任何缓冲区间 ⇒ null）。 */
export function aheadOf(el: HTMLMediaElement): number | null {
  try {
    for (let i = 0; i < el.buffered.length; i += 1) {
      if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i)) {
        const v = el.buffered.end(i) - el.currentTime
        return v >= 0 ? v : null        // 负数只是读数竞争的毛刺，**别当成"缓冲 −1 秒"报上去**
      }
    }
  } catch {
    /* 量不到就算了 */
  }
  return null
}

/** 窗口里"数据没到"的秒数（`currentTime` 没前进）。 */
export function stalledSeconds(w: PlaybackWindow): number {
  return w.samples.filter((s) => !s.advanced).length
}

/** 窗口里"帧没来"的秒数（`currentTime` 在走，但这一秒一帧都没解出来 ⇒ 解码/呈现问题）。 */
export function idleSeconds(w: PlaybackWindow): number {
  return w.samples.filter((s) => s.advanced && s.fps === 0).length
}

/** 窗口里"浏览器认为页面不可见"的秒数（切走/遮挡/最小化）。 */
export function hiddenSeconds(w: PlaybackWindow): number {
  return w.samples.filter((s) => s.hidden).length
}

/** 窗口里"页面失焦"的秒数。 */
export function unfocusedSeconds(w: PlaybackWindow): number {
  return w.samples.filter((s) => !s.focused).length
}

function avgFps(w: PlaybackWindow, from: number, to: number): number | null {
  const seg = w.samples.filter((s) => s.t > from && s.t <= to)
  if (!seg.length) return null
  return seg.reduce((n, s) => n + s.fps, 0) / seg.length
}

/** 窗口里**呈现**帧率的均值（量不到 = null）。 */
export function presentedFps(w: PlaybackWindow): number | null {
  const seg = w.samples.filter((s) => s.presented != null)
  if (!seg.length) return null
  return seg.reduce((n, s) => n + (s.presented ?? 0), 0) / seg.length
}

/**
 * 一句判定（`devlog/308`）：把"该往哪儿修"直接写在行里，省得每次都要人肉对表。
 *
 * - **数据受限**：`currentTime` 卡住过，或缓冲掉到 0.5s 以下还反复饿；
 * - **呈现受限**：帧**解出来了**（解码帧率正常）却**没被呈现**——`presentedFrames` 明显低于解码帧率，
 *   或呈现间隔里出现过 ≥0.5s 的大洞。这条以前量不到，而真机上"画面卡一帧/低帧率"最可能落在它上面；
 * - **正常**：都不成立。
 */
export function verdict(w: PlaybackWindow, decodedFps: number): string {
  const stalled = stalledSeconds(w)
  const thin = w.minAhead != null && w.minAhead < 0.5 && w.waiting >= 3
  if (stalled >= 2 || thin) return '数据受限'
  /**
   * ⚠️ 真机三次复现全落在这里（`devlog/309`）：**缓冲 2.6–19.4 秒、解码 30–75fps、
   * 但呈现只有 7–15fps 且出现过 3–4 秒完全不出帧**（`currentTime` 一直在走、音频正常）。
   * 那个形状只说明一件事：**浏览器把画面挂起了**——而这正是 Chromium 对
   * "页面不可见 / 窗口被完全遮挡 / 最小化"的标准行为（音频继续、视频停）。
   * 所以先问"当时窗口可见吗"，可见才谈"是不是合成太慢"。
   */
  if (hiddenSeconds(w) >= 1) return '窗口不可见(浏览器挂起画面，音频照常)'
  const pres = presentedFps(w)
  if (!w.pres.supported) return '正常(呈现量不到)'
  const presBad = (pres != null && decodedFps >= 5 && pres < decodedFps * 0.7)
  if (presBad || w.pres.maxGapMs >= 500) return '呈现受限'
  return '正常'
}

/** 把窗口收成一行（纯函数，便于单测：数字怎么算的都能钉住）。 */
export function summarize(w: PlaybackWindow, el: HTMLMediaElement, now: number): string {
  const elapsed = (now - w.startedAt) / 1000
  const { frames, dropped } = frameStats(el as HTMLVideoElement)
  const gained = Math.max(0, frames - w.baseFrames)
  const droppedGained = Math.max(0, dropped - w.baseDropped)
  const fps = elapsed > 0 ? gained / elapsed : 0
  const head = avgFps(w, 0, 3)
  const later = avgFps(w, 3, 1e9)
  const pres = presentedFps(w)
  return [
    `[video] ${w.reason}${w.targetS != null ? `→${w.targetS.toFixed(1)}s` : ''}`,
    `判定=${verdict(w, fps)}`,
    `窗口=${elapsed.toFixed(1)}s`,
    `起播=${w.readyMs == null ? '未出画' : `${(w.readyMs / 1000).toFixed(1)}s`}`,
    `饿住=${w.waiting}次`,
    `最低缓冲=${w.minAhead == null ? '量不到' : `${w.minAhead.toFixed(1)}s`}`,
    `解码=${fps.toFixed(1)}fps`,
    `呈现=${pres == null ? '量不到' : `${pres.toFixed(1)}fps`}`,
    `最长停顿=${w.pres.supported ? `${(w.pres.maxGapMs / 1000).toFixed(2)}s` : '量不到'}`,
    `停顿次数=${w.pres.gaps.length}`,
    `前3秒=${head == null ? '-' : head.toFixed(1)}`,
    `后段=${later == null ? '-' : later.toFixed(1)}`,
    `卡帧=${stalledSeconds(w)}s`,     // currentTime 没动 ⇒ 数据没到
    `空转=${idleSeconds(w)}s`,        // currentTime 在动却没解出帧 ⇒ 解码
    `隐藏=${hiddenSeconds(w)}s`,      // 浏览器判页面不可见（切走/遮挡/最小化）
    `失焦=${unfocusedSeconds(w)}s`,
    `丢帧=${droppedGained}/${gained}`,
    `末缓冲=${aheadOf(el)?.toFixed(1) ?? '?'}s`,
  ].join(' ')
}

/** 每秒曲线（只在确实有低谷/卡顿时附一行，避免把日志刷满）。 */
export function curveLine(w: PlaybackWindow, max = 15): string | null {
  const head = avgFps(w, 0, 3)
  const later = avgFps(w, 3, 1e9)
  const dip = head != null && later != null && later > 0 && head < later * DIP_RATIO
  const bad = stalledSeconds(w) >= 2 || idleSeconds(w) >= 2
  if (!dip && !bad) return null
  const items = w.samples.slice(0, max).map(
    (s) => `${s.t}s:${s.fps}fps/${s.ahead == null ? '×' : s.ahead.toFixed(1)}${s.advanced ? '' : '*'}`)
  return `[video] 曲线(${w.reason}) ${items.join(' ')}${w.samples.length > max ? ' …' : ''}`
    + ' （`*` = 该秒 currentTime 没前进）'
}

export interface ProbeHandle {
  noteWaiting: () => void
  noteAhead: (v: number | null) => void
  noteReady: () => void
  /** **现在就把已采到的报出去**（组件卸载/播放结束时用）。第一版这里是"丢弃"，
   *  于是用户关掉抽屉那几次恰好什么都没留下（真机只捞到 1 行就是这么来的）。 */
  finish: () => void
  /** 丢弃（被新的窗口顶掉：连续拖拽只留最后一次） */
  cancel: () => void
}

export function watchPlayback(el: HTMLVideoElement, reason: string, targetS?: number): ProbeHandle {
  const w = openWindow(el, reason, targetS)
  let alive = true
  let lastFrames = w.baseFrames
  let lastPresented = 0
  let lastPresentedSampled = 0
  let lastCur = el.currentTime
  let lastPresentedAt = 0
  let tick = 0

  /**
   * **呈现**侧（`devlog/308`）：`getVideoPlaybackQuality` 数的是**解出来**的帧，
   * 而用户看到的是**被画出来**的帧 —— 两者可以差很远（合成/GPU/窗口遮挡时：
   * 解码 30fps、画面却一顿一顿）。`requestVideoFrameCallback` 给的 `presentedFrames`
   * 才是"真的上了屏"的数，回调之间的间隔就是**卡顿本身**。
   */
  const rvfc = (el as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { presentedFrames?: number }) => void) => number
  }).requestVideoFrameCallback?.bind(el)
  if (rvfc) {
    w.pres.supported = true
    const onFrame = (now: number, meta: { presentedFrames?: number }) => {
      if (!alive) return
      // ⚠️ 用**回调自带的 `now`**（浏览器给的呈现时刻），不用 `performance.now()`：
      //    前者才是"这一帧什么时候上的屏"，而且它可注入 ⇒ 单测能确定性地造出"卡 1.2 秒"
      const t = typeof now === 'number' && now > 0 ? now : performance.now()
      if (lastPresentedAt) {
        const gap = t - lastPresentedAt
        if (gap > w.pres.maxGapMs) w.pres.maxGapMs = gap
        // 只留"看得见的卡顿"（>100ms ≈ 掉了 3 帧以上），最多 20 条免得涨内存
        if (gap > 100 && w.pres.gaps.length < 20) w.pres.gaps.push(Math.round(gap))
      }
      lastPresentedAt = t
      if (typeof meta?.presentedFrames === 'number') lastPresented = meta.presentedFrames
      rvfc(onFrame)
    }
    rvfc(onFrame)
  }

  const sample = () => {
    tick += 1
    const { frames } = frameStats(el)
    const fps = Math.max(0, frames - lastFrames)
    lastFrames = frames
    const advanced = el.currentTime - lastCur >= 0.2
    lastCur = el.currentTime
    const ahead = aheadOf(el)
    if (ahead != null) w.minAhead = w.minAhead == null ? ahead : Math.min(w.minAhead, ahead)
    // `meta.presentedFrames` 是**累计值** ⇒ 这里存**这一秒的增量**，`presentedFps` 才能当帧率用
    const presDelta = w.pres.supported ? Math.max(0, lastPresented - lastPresentedSampled) : null
    lastPresentedSampled = lastPresented
    // 页面可见性/焦点：Chromium 对"不可见"的页面**会挂起画面**（音频继续）——
    // 真机三次复现的画面停摆就落在这条上（devlog/309）
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const focused = typeof document === 'undefined' || document.hasFocus()
    w.samples.push({ t: tick, fps, presented: presDelta, ahead, advanced, hidden, focused })
  }
  const timer = window.setInterval(sample, SAMPLE_MS)
  const stop = () => { alive = false; window.clearInterval(timer); window.clearTimeout(windowTimer) }
  const post = () => {
    // 什么都没采到（挂载就被卸载）就别留垃圾行
    if (!w.samples.length && !w.waiting) return
    void api.clientLog(summarize(w, el, performance.now()))
      .catch(() => { /* 诊断上报失败就算了，绝不影响播放 */ })
    const curve = curveLine(w)
    if (curve) void api.clientLog(curve).catch(() => { /* 同上 */ })
  }
  const windowTimer = window.setTimeout(() => { if (alive) { stop(); post() } }, WINDOW_MS)

  return {
    noteWaiting: () => { w.waiting += 1 },
    noteAhead: (v) => {
      if (v == null || v < 0) return
      w.minAhead = w.minAhead == null ? v : Math.min(w.minAhead, v)
    },
    noteReady: () => { if (w.readyMs == null) w.readyMs = performance.now() - w.startedAt },
    finish: () => { if (alive) { stop(); post() } },
    cancel: () => stop(),
  }
}
