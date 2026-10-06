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
import { surfaceEverOpaque, surfaceState } from './shellBridge'

interface Sample {
  /** 第几秒（1 起） */
  t: number
  /** 这一秒**提交给合成器**的帧（`totalVideoFrames` 增量）—— 见 `frameStats` 的三段口径 */
  fps: number
  /** 这一秒**解出来**的帧（`webkitDecodedFrameCount` 增量）；量不到 = null */
  decoded: number | null
  /** 这一秒**呈现**了多少帧（`requestVideoFrameCallback` 的 `presentedFrames` 增量）；量不到 = null */
  presented: number | null
  /** 这一秒页面**画了多少帧**（`requestAnimationFrame` 回调数）—— 用于区分"整页卡"与"只有视频卡" */
  pageFps: number | null
  /** 这一秒末的前方缓冲（秒）；量不到 = null */
  ahead: number | null
  /** 这一秒 `currentTime` 有没有前进（没前进 = 数据没到） */
  advanced: boolean
  /** 这一秒页面是不是**被浏览器判为不可见**（`document.visibilityState === 'hidden'`：
   *  切走、最小化、以及 Windows 上的"窗口被完全遮挡"都会落到这里） */
  hidden: boolean
  /** 这一秒页面有没有焦点（部分遮挡/失焦时 Chromium 会降级渲染） */
  focused: boolean
  /** 这一秒末的 `readyState`（4 = 够播下去） */
  readyState: number
  /** 这一秒里元素是不是处在 `seeking` */
  seeking: boolean
  /** 这一秒里**新丢**了多少帧（`droppedVideoFrames` 增量，`devlog/384`）。
   *  单看窗口总数的"丢帧 34/469"看不出**分布在哪儿**：均匀漏 2 帧/秒与某 1 秒崩 30 帧
   *  指向完全相反的修法（前者 = 呈现路径吞吐不够；后者 = 某一刻解码器/码率被重建）。 */
  dropped?: number
  /** 这一秒里 rVFC 相邻回调的间隔（ms）。抖动**不在采样时判** —— 判据要拿整窗的中位数当基准，
   *  所以这里只存原料，`summarize` 时用 `judderStats` 统一判（纯函数，可单测）。 */
  intervals?: number[]
  /** 这一秒里**超过 50ms 的主线程任务**个数（`PerformanceObserver('longtask')`）——
   *  用来排掉"是我们自己的 JS 把主线程堵住了"这条线（量不到 = 省略）。 */
  longTasks?: number
  /** 这一秒有没有**正在跑的 CSS 动画/过渡**（`document.getAnimations().length`）；
   *  量不到 = null。全屏时页面里还有东西在动 ⇒ 合成器永远闲不下来（B2 的一条假设）。 */
  anims?: number | null
  /** 这一秒是不是处在**元素全屏**（`document.fullscreenElement`）。 */
  fs?: boolean
  /** 这一秒里页面自绘（rAF）**最长的一次间隔**（ms）——`devlog/386`：
   *  用来分辨"合成器整页卡了一下"与"只有视频那一拍被推迟"：前者页面自绘也会跟着停。 */
  rafMaxMs?: number
}

export interface PlaybackWindow {
  reason: string
  targetS?: number
  /** 这次窗口是哪个内核在放（`MSE` / `渐进`，devlog/312）。**空 = 没记**（老调用方）。 */
  kernel?: string
  /**
   * 这次窗口里有没有进过全屏（2026-10-06，`devlog/379`）。
   *
   * 为什么值得单记一格：用户报的"播放一下一下地慢"只在**全屏**复现（非全屏/小窗都顺、
   * B 站本身也顺），而全屏与窗口态的差别全在**合成**那一侧 —— 日志里没有这一格时，
   * 同一段视频的两组数（全屏 / 非全屏）根本对不上账。
   *
   * ⚠️ `devlog/384` 补：这一格第一版只在**开局**与**报告**两拍取 —— 用户"先窗口播 20 秒、
   * 再点全屏 5 秒"时两拍都是"不在全屏"，整段全屏时间被记成 `全屏=0`（`表面=` 上一批
   * 就是这么骗过我的）。现在靠 `fullscreenchange` 监听把它变成**整窗粘性**的，
   * 并且按秒采样出 `全屏=N/M秒`（`Sample.fs`）—— 既能说"进过"，也能说"进了多久"。
   */
  fullscreen?: boolean
  /** 见上：整窗只要进过全屏就置位（`fullscreenchange` 监听负责）。 */
  everFullscreen?: boolean
  startedAt: number
  baseFrames: number
  baseDropped: number
  /** 窗口开始时的**解码**帧数（`webkitDecodedFrameCount`）；量不到 = null */
  baseDecoded: number | null
  waiting: number
  minAhead: number | null
  readyMs: number | null
  samples: Sample[]
  /** **呈现**侧（`requestVideoFrameCallback`）：见 `summarize` 的"判定" */
  pres: { supported: boolean; maxGapMs: number; gaps: number[]; repeats: number }
  /** 整窗最长的一次主线程长任务（ms）；量不到 = null */
  longTaskMaxMs?: number | null
  /** 整窗见过的**在跑**的动画签名（`name@元素`，最多 3 个）——`devlog/385`：
   *  `动画=N秒` 只说"有几秒在动"，说不出**是什么在动**；不知道是什么就没法关掉它。 */
  animNames?: string[]
  /** 整窗**最大**的视频显示尺寸（CSS px）——`devlog/387`：报告那一拍元素往往已经卸掉，
   *  现场量 `getBoundingClientRect()` 只会得到 `?`。采样时记，才能读"放大到多大"。 */
  maxDisp?: { w: number; h: number }
}

const WINDOW_MS = 30_000
const SAMPLE_MS = 1_000
/** 低于后段的这个比例就认为"开头确实差"，多报一行每秒曲线 */
const DIP_RATIO = 0.7
/**
 * 丢帧**也要**触发每秒曲线（2026-10-06，`devlog/384`）。
 *
 * 为什么：B2 的日志里唯一异常就是丢帧（5~10%），而曲线只在"有低谷/卡顿"时才附一行 ——
 * 于是**丢帧那一轮反而一行曲线都没有**，"帧是均匀漏掉的、还是某一刻崩的"根本看不出来。
 * 这两个假设指向完全相反的修法（前者 = 呈现路径吞吐不够；后者 = 某一刻解码器/码率被重建）。
 */
const DROP_MIN_FRAMES = 5
/** 判定里"丢帧算不算问题"的比例（3%）。 */
const DROP_VERDICT_RATIO = 0.03
/** 抖动/长任务触发曲线的次数门槛。 */
const BAD_SECONDS_TRIGGER = 3
/** 被顶掉的窗口**采到这么多秒**就留一行（标 `(顶掉)`）——见 `cancel`。
 *  用采样数而不是墙钟：采样由 1 秒定时器产生，判据在假时钟下也确定（单测直接钉得住）。 */
const CANCEL_REPORT_SAMPLES = 5

/**
 * 抖动（2026-10-06，`devlog/384`）——**用户说的"一下一下地慢"就是它**。
 *
 * 口径：以 rVFC 相邻回调间隔的**中位数**为基准（30fps ≈ 33.3ms、60fps ≈ 16.7ms，
 * 不写死帧率），超过 `max(中位数 × 1.35, 中位数 + 6ms)` 就算"这一拍被拖住"。
 *
 * ⚠️ 用中位数而不是最小值：合成器重复呈现同一帧时会出现 ~8ms 的小间隔，拿最小值当基准
 * 会把整窗都判成抖动。⚠️ 与 `>100ms` 的 `gaps`（停顿）是**两件事**：停顿 = 画面不动了，
 * 抖动 = 画面在动但节拍被拖住 —— 真机上"停顿次数=0 而用户说卡"就落在后者，
 * 那正是 B2 里探针**量不到症状**的原因。
 */
export function judderStats(intervals: number[]): { count: number; maxMs: number } {
  if (intervals.length < 8) return { count: 0, maxMs: 0 }   // 样本太少不判（开局那几帧间隔不准）
  const limit = judderLimit(intervals)
  const bad = intervals.filter((g) => g > limit)
  return { count: bad.length, maxMs: bad.length ? Math.max(...bad) : 0 }
}

/** 抖动的判定上限（ms）；样本太少 = Infinity（不判）。 */
function judderLimit(intervals: number[]): number {
  if (intervals.length < 8) return Infinity
  const sorted = [...intervals].sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  return Math.max(median * 1.35, median + 6)
}

/**
 * 两次**抖动之间**隔了多久（中位数，秒）—— 用来分辨"周期性"与"随机"（2026-10-06，`devlog/385`）。
 *
 * 为什么值得单出一格：真机日志里丢帧是**每秒正好 2 帧**（30fps 的 6.7%，连续 15 秒一模一样），
 * 这不是调度噪声的形状。周期性 ⇒ 有人在按固定节拍打扰（我们的 MSE 泵是 400ms 一跳）；
 * 随机 ⇒ 合成器的截止时间竞争。两者的修法完全不同。
 */
export function judderPeriod(intervals: number[]): number | null {
  const limit = judderLimit(intervals)
  if (!Number.isFinite(limit)) return null
  const idx: number[] = []
  intervals.forEach((g, i) => { if (g > limit) idx.push(i) })
  if (idx.length < 3) return null
  const spans: number[] = []
  for (let k = 1; k < idx.length; k += 1) {
    // 两次抖动之间的**时间** = 中间那些间隔的和（从抖动的下一拍算到下一次抖动）
    let sum = 0
    for (let i = idx[k - 1] + 1; i <= idx[k]; i += 1) sum += intervals[i]
    spans.push(sum)
  }
  spans.sort((a, b) => a - b)
  return spans[spans.length >> 1] / 1000
}

/** 整窗"在跑"的动画签名（`name@元素`，最多 3 个）——见 `PlaybackWindow.animNames`。 */
export function runningAnimations(): { count: number; names: string[] } {
  if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') {
    return { count: 0, names: [] }
  }
  const names: string[] = []
  let count = 0
  for (const a of document.getAnimations()) {
    /* ⚠️ 只认 `running`：`getAnimations()` 会把 `fill: forwards` 那种**早已跑完但还在生效**
       的动画也列出来（第一版就是这么把"每秒都在动"报成 30/30 秒的 —— 假阳性）。 */
    if (a.playState !== 'running') continue
    count += 1
    if (names.length < 3) {
      const meta = a as unknown as { animationName?: string; transitionProperty?: string }
      const name = meta.animationName ?? meta.transitionProperty ?? 'anim'
      const target = (a.effect as KeyframeEffect | null)?.target as Element | null
      /* ⚠️ SVG 元素的 `className` 是 `SVGAnimatedString` 对象（`String()` 出来是 "[object …]"）——
         第一版日志里就出现了 `vp-spin@svg.[object`。字符串拿不到就退回 `class` 属性。 */
      const rawCls = target
        ? (typeof (target as { className?: unknown }).className === 'string'
            ? (target as { className: string }).className
            : target.getAttribute?.('class') ?? '')
        : ''
      const cls = rawCls ? `.${rawCls.trim().split(/\s+/)[0]}` : ''
      const one = `${name}@${target ? target.tagName.toLowerCase() : '?'}${cls}`
      if (!names.includes(one)) names.push(one)
    }
  }
  return { count, names }
}

/** 整窗的 rVFC 间隔（按秒分片存的，这里拼回来）。 */
function allIntervals(w: PlaybackWindow): number[] {
  return w.samples.flatMap((s) => s.intervals ?? [])
}

/** 整窗抖动（判据口径见 `judderStats`）。 */
export function windowJudder(w: PlaybackWindow): { count: number; maxMs: number } {
  return judderStats(allIntervals(w))
}

/** 整窗主线程长任务（个数 / 最长 ms）；量不到 = null。 */
export function longTasks(w: PlaybackWindow): { count: number; maxMs: number } | null {
  if (!w.samples.some((s) => s.longTasks != null)) return null
  const count = w.samples.reduce((n, s) => n + (s.longTasks ?? 0), 0)
  return { count, maxMs: Math.round(w.longTaskMaxMs ?? 0) }
}

/** 整窗**有东西在动**的秒数（CSS 动画/过渡在跑）；量不到 = null。 */
export function animatingSeconds(w: PlaybackWindow): number | null {
  if (!w.samples.some((s) => s.anims != null)) return null
  return w.samples.filter((s) => (s.anims ?? 0) > 0).length
}

/** 整窗页面自绘的最长间隔（ms）；量不到 = null。 */
export function pageMaxGapMs(w: PlaybackWindow): number | null {
  const vals = w.samples.map((s) => s.rafMaxMs).filter((v): v is number => v != null)
  if (!vals.length) return null
  return Math.max(...vals)
}

/** 视频源尺寸 → 元素**最大**显示尺寸（`1920x1080→2560x1440`）；量不到 = `?`。
 *
 * ⚠️ 显示尺寸取**采样期间见过的最大值**（`w.maxDisp`），不是报告那一刻现场量的：
 * 日志是在窗口结束时写的，那时元素往往已经卸掉 ⇒ 现场量只会得到 `?`（真机就是这么发生的）。 */
function sizeLabel(el: HTMLMediaElement, w?: PlaybackWindow): string {
  const vw = (el as HTMLVideoElement).videoWidth
  const vh = (el as HTMLVideoElement).videoHeight
  const disp = w?.maxDisp
  if (!vw || !vh) return '?'
  return `${vw}x${vh}→${disp ? `${disp.w}x${disp.h}` : '?'}`
}

/**
 * rAF（整页自绘节拍）**只采前 10 秒**（2026-10-06，`devlog/385`）。
 *
 * 为什么：探针自己的 rAF 循环会把合成器按在显示刷新率上跑 —— 而"合成器忙着画整页、
 * 于是视频那一拍被推迟"正是我们要查的东西。它可能**自己就是**那 2 帧/秒的来源。
 * 只跑前 10 秒 ⇒ 同一个窗口里天然留出**对照组**：对着每秒曲线比 1~10s 与 11~30s 的 `丢N`，
 * 一样 ⇒ 与探针无关；后 20 秒明显变干净 ⇒ 探针自己造成的（先修尺子，再谈症状）。
 * 代价：`页面=` 这一格只代表前 10 秒。
 */
const RAF_WINDOW_MS = 10_000

/**
 * 环境能不能**硬件解码**这一档（`MediaCapabilities.decodingInfo().powerEfficient`）。
 *
 * ⚠️ 这是**能力**查询，不是"刚才真的走了硬解" —— 后者页面里查不到（要 CDP 的 Media 域）。
 * 为什么值得记：B2 排查时有人把矛头指向"WebView2 的解码器（VDAVideoDecoder）比 Chrome 的
 * D3D11VideoDecoder 差"，而 Edge 与 WebView2 是**同一个内核**、同一套媒体栈 ——
 * 若这里答"无"，才轮到解码器这条线；答"有"就把这条线也关掉。
 */
let hwDecode: '有' | '无' | '不支持' | '未知' = '未知'

async function probeHwDecode(el: HTMLVideoElement): Promise<void> {
  const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities
  if (!mc?.decodingInfo) return
  try {
    const info = await mc.decodingInfo({
      type: 'media-source',
      video: {
        contentType: 'video/mp4; codecs="avc1.640028"',
        width: el.videoWidth || 1920,
        height: el.videoHeight || 1080,
        bitrate: 4_000_000,
        framerate: 30,
      },
    })
    hwDecode = !info.supported ? '不支持' : (info.powerEfficient ? '有' : '无')
  } catch { /* 量不到就保持"未知"，不编 */ }
}

/**
 * 帧计数**三段口径**（`devlog/310`）—— 卡在哪一段直接决定"该往哪儿修"：
 *
 * | 指标 | 来源 | 含义 |
 * |---|---|---|
 * | `decoded` | `webkitDecodedFrameCount` | 解码器**解出来**多少帧 |
 * | `frames` | `getVideoPlaybackQuality().totalVideoFrames` | 有多少帧被**提交给合成器** |
 * | `presented` | `requestVideoFrameCallback` 的 `presentedFrames` | 有多少帧**真的上了屏** |
 *
 * 只量其中一两个会得出互相矛盾的结论（真机上就吃过：解码 30fps、呈现 7fps，
 * 而"到底哪一段掉的"决定了是解码器停、渲染器不提交、还是合成器不画）。
 */
export function frameStats(el: HTMLVideoElement): {
  frames: number; dropped: number; decoded: number | null
} {
  const q = el.getVideoPlaybackQuality?.()
  const legacy = el as HTMLVideoElement & {
    webkitDecodedFrameCount?: number; webkitDroppedFrameCount?: number
  }
  if (q) {
    return { frames: q.totalVideoFrames ?? 0, dropped: q.droppedVideoFrames ?? 0,
             decoded: legacy.webkitDecodedFrameCount ?? null }
  }
  return { frames: legacy.webkitDecodedFrameCount ?? 0,
           dropped: legacy.webkitDroppedFrameCount ?? 0, decoded: null }
}

export function openWindow(el: HTMLVideoElement, reason: string, targetS?: number,
                           kernel?: string): PlaybackWindow {
  const { frames, dropped, decoded } = frameStats(el)
  return { reason, targetS, kernel, startedAt: performance.now(), baseFrames: frames,
           baseDropped: dropped, baseDecoded: decoded, waiting: 0, minAhead: null,
           readyMs: null, samples: [],
           /* 进全屏这件事可能发生在窗口**开始之后**（点全屏键那一下），所以这里只记"开局"，
              报告那一拍再取一次（`summarize` 里取并集）—— 加上按秒的 `Sample.fs`，
              "进过没有"与"进了多久"就都有了（`devlog/384`）。 */
           fullscreen: isFullscreen(), everFullscreen: isFullscreen(),
           pres: { supported: false, maxGapMs: 0, gaps: [], repeats: 0 } }
}

/** 现在是不是全屏（`document` 在非浏览器环境里没有 `fullscreenElement`）。 */
function isFullscreen(): boolean {
  return typeof document !== 'undefined' && Boolean(document.fullscreenElement)
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

/** 窗口里"页面画不出来"的秒数（`currentTime` 在走、缓冲够，但这一秒**一帧都没提交给合成器**）。 */
export function idleSeconds(w: PlaybackWindow): number {
  return w.samples.filter((s) => s.advanced && s.fps === 0).length
}

/** 这一秒**解码器有没有在干活**（量不到 ⇒ null）。 */
function decoderRunning(s: Sample): boolean | null {
  if (s.decoded == null) return null
  return s.decoded > 0
}

/** 窗口里"解码器停着但画面本该在动"的秒数（三段里**第一段**掉的）。 */
export function decoderStallSeconds(w: PlaybackWindow): number {
  return w.samples.filter((s) => s.advanced && decoderRunning(s) === false).length
}

/** 窗口里"解码有帧、却一帧没提交给合成器"的秒数（三段里**第二段**掉的）。 */
export function submitStallSeconds(w: PlaybackWindow): number {
  return w.samples.filter((s) => s.advanced && s.fps === 0 && decoderRunning(s) === true).length
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

function avgOf(w: PlaybackWindow, pick: (s: Sample) => number | null): number | null {
  const vals = w.samples.map(pick).filter((v): v is number => v != null)
  if (!vals.length) return null
  return vals.reduce((n, v) => n + v, 0) / vals.length
}

/** 窗口里**解码**帧率的均值（量不到 = null）。 */
export function decodedFps(w: PlaybackWindow): number | null {
  return avgOf(w, (s) => s.decoded)
}

/** 窗口里**页面自绘**帧率的均值（rAF；量不到 = null）。用来区分"整页卡"与"只有视频卡"。 */
export function pageFps(w: PlaybackWindow): number | null {
  return avgOf(w, (s) => s.pageFps)
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
  /* 三段里**哪一段掉的**决定修法（devlog/310）：
     · 解码器停 ⇒ 管线在做 seek 追赶（progressive 无索引源的典型行为，MSE 能根治）；
     · 解码有帧却没提交 ⇒ 渲染器/GPU 那一段；
     · 都正常但呈现低 ⇒ 合成器节拍。 */
  const decStall = decoderStallSeconds(w)
  const subStall = submitStallSeconds(w)
  if (decStall >= 2) return '呈现受限(解码器停：seek 后在追赶)'
  if (subStall >= 2) return '呈现受限(解码有帧但没提交)'
  const pres = presentedFps(w)
  if (!w.pres.supported) return '正常(呈现量不到)'
  const presBad = (pres != null && decodedFps != null && decodedFps >= 5 && pres < decodedFps * 0.7)
  if (presBad || w.pres.maxGapMs >= 500) return '呈现受限(合成节拍)'
  /* 丢帧/抖动（devlog/384）：三段都正常、也没停住，但**帧在漏 / 节拍被拖住** ——
     这正是 B2 的形状（解码=提交=30fps、停顿 0 次，而用户就是看着卡）。
     不给它一句判定的话，日志读起来像"一切正常"，与用户的体验正好相反。 */
  const gained = w.samples.reduce((n, s) => n + s.fps, 0)
  const dropped = w.samples.reduce((n, s) => n + (s.dropped ?? 0), 0)
  const ratio = gained > 0 ? dropped / gained : 0
  const jud = windowJudder(w).count
  if (ratio >= DROP_VERDICT_RATIO && jud >= BAD_SECONDS_TRIGGER) return '呈现受限(丢帧+抖动)'
  if (ratio >= DROP_VERDICT_RATIO) return `呈现受限(丢帧${Math.round(ratio * 100)}%)`
  if (jud >= BAD_SECONDS_TRIGGER) return `呈现受限(抖动${jud}次)`
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
  const dec = decodedFps(w)
  const page = pageFps(w)
  const pageMax = pageMaxGapMs(w)
  const jud = windowJudder(w)
  const period = judderPeriod(allIntervals(w))
  const lt = longTasks(w)
  const anim = animatingSeconds(w)
  const fsSec = w.samples.filter((s) => s.fs).length
  const fsEver = Boolean(w.everFullscreen || w.fullscreen || isFullscreen())
  return [
    `[video] ${w.reason}${w.targetS != null ? `→${w.targetS.toFixed(1)}s` : ''}`,
    /* 哪个内核（devlog/312）：旧内核的病（seek 后解码追赶）和新内核的效果必须能对账 */
    ...(w.kernel ? [`内核=${w.kernel}`] : []),
    /* 全屏与否（2026-10-06，devlog/379；devlog/384 改成按秒）：
       `全屏=15/16秒` = 这一窗里有多少秒处在元素全屏 —— 既能说"进过"，也能说"进了多久"；
       没有采样（测试、或开局即结束）时退回原来的 1/0；`(曾)` = 采样缝里进过全屏
       （进/出在同一秒内），按秒数是 0 但**确实进过**，别让它被读成"没进过"。 */
    `全屏=${w.samples.length
      ? `${fsSec}/${w.samples.length}秒${fsEver && fsSec === 0 ? '(曾)' : ''}`
      : `${fsEver ? 1 : 0}`}`,
    /* 窗口表面（devlog/382，`devlog/383` 改正口径）：`曾不透明` = 这个窗口期间**成功切到过**
       不透明表面。第一版记的是"写日志那一刻"的状态，而日志是在窗口结束时写的 —— 那时多半
       已经退出全屏，于是每一行都显示 `transparent`，根本读不出那一轮到底带没带不透明表面。
       `failed` = 跑在旧壳上（命令不存在），那一轮的数**不能**用来判断那一刀有没有用。 */
    `表面=${surfaceEverOpaque() ? '曾不透明' : surfaceState()}`,
    /* 硬解**能力**（devlog/384）：`无` 才轮到"WebView2 的解码器比 Chrome 差"那条线。 */
    `硬解=${hwDecode}`,
    `判定=${verdict(w, fps)}`,
    `窗口=${elapsed.toFixed(1)}s`,
    `起播=${w.readyMs == null ? '未出画' : `${(w.readyMs / 1000).toFixed(1)}s`}`,
    `饿住=${w.waiting}次`,
    `最低缓冲=${w.minAhead == null ? '量不到' : `${w.minAhead.toFixed(1)}s`}`,
    /* 三段口径：解码 → 提交合成器 → 真的上屏（外加"整页画了多少帧"作对照） */
    `解码=${dec == null ? '量不到' : `${dec.toFixed(1)}fps`}`,
    `提交=${fps.toFixed(1)}fps`,
    `呈现=${pres == null ? '量不到' : `${pres.toFixed(1)}fps`}`,
    `页面=${page == null ? '量不到' : `${page.toFixed(1)}fps`}`,
    /* 页面自绘最长一次间隔（devlog/386）：与丢帧合看能分开"合成器整页卡"与"只有视频被推迟" */
    `页面峰=${pageMax == null ? '量不到' : `${(pageMax / 1000).toFixed(2)}s`}`,
    /* 视频源尺寸 → 元素实际显示尺寸（devlog/386；devlog/387 改成取采样期间的最大值）：
       全屏与窗口的**放大倍数**差别在这一格。 */
    `尺寸=${sizeLabel(el, w)}`,
    /* 设备像素比（devlog/387）：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 一旦设了
       `--force-device-scale-factor`，整台机器的渲染比例就变了（而且会**顺带**把 wry 的默认参数
       整串顶掉）—— 排查时若忘了它会一路污染后面的每一组数。写进日志，一眼能看出来。 */
    `dpr=${typeof devicePixelRatio === 'number' ? devicePixelRatio : '?'}`,
    `最长停顿=${w.pres.supported ? `${(w.pres.maxGapMs / 1000).toFixed(2)}s` : '量不到'}`,
    `停顿次数=${w.pres.gaps.length}`,
    /* 抖动（devlog/384）：用户症状的**直读口径** —— "一下一下地慢"是节拍被拖住，不是停住。
       `抖间隔`（devlog/385）= 两次抖动之间隔多久：周期性 ⇒ 有人按固定节拍打扰（MSE 泵 400ms
       一跳）；随机 ⇒ 合成器截止时间竞争。真机那条"每秒正好 2 帧"就是靠它才能定性。 */
    `抖动=${jud.count}次`,
    `抖峰=${(jud.maxMs / 1000).toFixed(2)}s`,
    `抖间隔=${(period == null ? '不规律' : `${period.toFixed(2)}s`)}`,
    `重复帧=${w.pres.repeats}`,
    /* 主线程长任务（devlog/384）：把"是我们自己的 JS 堵住了"这条线排掉。 */
    `长任务=${lt == null ? '量不到' : `${lt.count}次`}`,
    `长任务峰=${lt == null ? '量不到' : `${(lt.maxMs / 1000).toFixed(2)}s`}`,
    /* 全屏时页面里还有东西在动吗（devlog/384）：合成器闲不下来的一条硬假设；
       `动画名`（devlog/385）是**谁**在动 —— 不知道是谁就没法关掉它。 */
    `动画=${anim == null ? '量不到' : `${anim}秒`}`,
    ...(w.animNames?.length ? [`动画名=${w.animNames.join(',')}`] : []),
    `前3秒=${head == null ? '-' : head.toFixed(1)}`,
    `后段=${later == null ? '-' : later.toFixed(1)}`,
    `卡帧=${stalledSeconds(w)}s`,        // currentTime 没动 ⇒ 数据没到
    `解码停=${decoderStallSeconds(w)}s`,  // 解码器没出帧（第一段）
    `提交停=${submitStallSeconds(w)}s`,   // 解出来了却没交给合成器（第二段）
    `隐藏=${hiddenSeconds(w)}s`,         // 浏览器判页面不可见（切走/遮挡/最小化）
    `失焦=${unfocusedSeconds(w)}s`,
    `丢帧=${droppedGained}/${gained}${gained ? `(${((droppedGained / gained) * 100).toFixed(1)}%)` : ''}`,
    `末缓冲=${aheadOf(el)?.toFixed(1) ?? '?'}s`,
  ].join(' ')
}

/** 每秒曲线（只在确实有低谷/卡顿/丢帧/抖动/长任务时附一行，避免把日志刷满）。 */
export function curveLine(w: PlaybackWindow, max = 15): string | null {
  const head = avgFps(w, 0, 3)
  const later = avgFps(w, 3, 1e9)
  const dip = head != null && later != null && later > 0 && head < later * DIP_RATIO
  const drops = w.samples.reduce((n, s) => n + (s.dropped ?? 0), 0)
  const jud = windowJudder(w).count
  const lt = longTasks(w)?.count ?? 0
  /* `devlog/384`：丢帧/抖动/长任务**也要**触发曲线 —— 否则"帧在漏但没停"的那一轮
     一行曲线都没有，而"漏在哪儿、按什么节拍漏"正是要看的。 */
  const bad = stalledSeconds(w) >= 2 || idleSeconds(w) >= 2
    || drops >= DROP_MIN_FRAMES || jud >= BAD_SECONDS_TRIGGER || lt >= BAD_SECONDS_TRIGGER
  if (!dip && !bad) return null
  const one = (s: Sample) => {
    const d = s.dropped ?? 0
    const j = judderStats(s.intervals ?? []).count
    return `${s.t}s:${s.fps}fps/${s.ahead == null ? '×' : s.ahead.toFixed(1)}`
      + `${s.advanced ? '' : '*'}${d ? `丢${d}` : ''}${j ? `抖${j}` : ''}`
      + `${s.longTasks ? `长${s.longTasks}` : ''}`
      /* 这一秒页面自绘最长间隔（>40ms 才算"整页卡了一下"）：与 `丢N` 同秒出现 ⇒ 合成器整页卡 */
      + `${(s.rafMaxMs ?? 0) > 40 ? `页${Math.round(s.rafMaxMs ?? 0)}` : ''}`
  }
  const items: string[] = []
  for (const s of w.samples.slice(0, max)) {
    items.push(one(s))
    /* 单行 ≤400 字是接口的硬限制（`api.clientLog`）⇒ 到顶就不再往里塞，宁可少几秒 */
    if (items.join(' ').length > 300) break
  }
  return `[video] 曲线(${w.reason}) ${items.join(' ')}${w.samples.length > items.length ? ' …' : ''}`
    + ' （`*`=没前进 丢=丢帧 抖=抖动 长=长任务 页=整页卡顿ms）'
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

export function watchPlayback(el: HTMLVideoElement, reason: string, targetS?: number,
                              kernel?: string): ProbeHandle {
  const w = openWindow(el, reason, targetS, kernel)
  let alive = true
  let lastFrames = w.baseFrames
  let lastDecoded = w.baseDecoded ?? 0
  let lastDropped = w.baseDropped
  let lastPresented = 0
  let lastPresentedSampled = 0
  let lastCur = el.currentTime
  let lastPresentedAt = 0
  let lastMediaTime: number | null = null
  let rafCount = 0
  let rafSampled = 0
  let lastRafAt = 0
  let pendingRafMax = 0
  let tick = 0
  /** 这一秒里攒的原料（采样时倒进 `Sample`，然后清空）。 */
  let pendingIntervals: number[] = []
  let pendingLongTasks = 0

  /* 整窗粘性（devlog/384）：`fullscreenchange` 只有进/出两拍会响，但**报告那一拍可能已经退出**
     全屏 —— 只看开局与报告两拍会把"中途进过全屏"整段记成 `全屏=0`（`表面=` 上一批就是这么
     骗过我的）。按秒的 `Sample.fs` 再补上"进了多久"。 */
  const onFsChange = () => { if (isFullscreen()) w.everFullscreen = true }
  if (typeof document !== 'undefined') document.addEventListener('fullscreenchange', onFsChange)
  w.everFullscreen = Boolean(w.everFullscreen || isFullscreen())

  /** 环境能不能硬解（`devlog/384`）：一次就够，写完就一直在行里。 */
  void probeHwDecode(el)

  /* 主线程长任务（`devlog/384`）：把"是我们自己的 JS 堵住了"这条线排掉 ——
     浏览器不支持 `longtask`（jsdom、部分 WebView 版本）时静默留白，不编数。 */
  let longObserver: PerformanceObserver | null = null
  try {
    if (typeof PerformanceObserver === 'function') {
      longObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          pendingLongTasks += 1
          w.longTaskMaxMs = Math.max(w.longTaskMaxMs ?? 0, e.duration)
        }
      })
      longObserver.observe({ entryTypes: ['longtask'] })
    }
  } catch { longObserver = null }

  // 整页自绘节拍（rAF）：与"视频呈现"对照，能分开"整页卡"与"只有视频卡"。
  // ⚠️ 只跑前 10 秒（`RAF_WINDOW_MS`）：它自己会给合成器加负载，而后 20 秒当对照组。
  let rafHandle = 0
  const onRaf = () => {
    rafCount += 1
    const now = performance.now()
    /* 页面自绘的**最长间隔**（devlog/386）：`页面=` 只有均值，看不出"整页卡了一下"。
       丢帧与它会合看：两者同时出现 ⇒ 合成器整页卡；只有视频丢 ⇒ 视频那条路自己的事。 */
    if (lastRafAt) {
      const gap = now - lastRafAt
      if (gap > pendingRafMax) pendingRafMax = gap
    }
    lastRafAt = now
    if (now - w.startedAt < RAF_WINDOW_MS) {
      rafHandle = window.requestAnimationFrame(onRaf)
    } else {
      rafHandle = 0
    }
  }
  if (typeof window.requestAnimationFrame === 'function') rafHandle = window.requestAnimationFrame(onRaf)

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
    const onFrame = (now: number, meta: { presentedFrames?: number; mediaTime?: number }) => {
      if (!alive) return
      // ⚠️ 用**回调自带的 `now`**（浏览器给的呈现时刻），不用 `performance.now()`：
      //    前者才是"这一帧什么时候上的屏"，而且它可注入 ⇒ 单测能确定性地造出"卡 1.2 秒"
      const t = typeof now === 'number' && now > 0 ? now : performance.now()
      if (lastPresentedAt) {
        const gap = t - lastPresentedAt
        if (gap > w.pres.maxGapMs) w.pres.maxGapMs = gap
        // 只留"看得见的卡顿"（>100ms ≈ 掉了 3 帧以上），最多 20 条免得涨内存
        if (gap > 100 && w.pres.gaps.length < 20) w.pres.gaps.push(Math.round(gap))
        /* 抖动（devlog/384）：原料按秒攒着，判据（中位数基准）在 `summarize` 里算 ——
           "画面在动、节拍被拖住"与">100ms 的停顿"是两件事，用户说的"一下一下地慢"是前者。 */
        if (gap > 0) pendingIntervals.push(gap)
      }
      lastPresentedAt = t
      /* 重复帧（devlog/384）：同一个 `mediaTime` 又来一次 = 这一帧被**重复呈现**了，
         视觉上就是"顿一下"。与抖动互为交叉验证（抖动看间隔、重复看内容）。 */
      if (typeof meta?.mediaTime === 'number') {
        if (lastMediaTime != null && Math.abs(meta.mediaTime - lastMediaTime) < 1e-6) {
          w.pres.repeats += 1
        }
        lastMediaTime = meta.mediaTime
      }
      if (typeof meta?.presentedFrames === 'number') lastPresented = meta.presentedFrames
      rvfc(onFrame)
    }
    rvfc(onFrame)
  }

  const sample = () => {
    tick += 1
    const { frames, decoded, dropped } = frameStats(el)
    const fps = Math.max(0, frames - lastFrames)
    lastFrames = frames
    const decDelta = decoded == null ? null : Math.max(0, decoded - lastDecoded)
    if (decoded != null) lastDecoded = decoded
    /* 丢帧**按秒**（devlog/384）：窗口总数看不出"均匀漏"还是"某一刻崩"，而这两者修法相反 */
    const dropDelta = Math.max(0, dropped - lastDropped)
    lastDropped = dropped
    const advanced = el.currentTime - lastCur >= 0.2
    lastCur = el.currentTime
    const ahead = aheadOf(el)
    if (ahead != null) w.minAhead = w.minAhead == null ? ahead : Math.min(w.minAhead, ahead)
    // `meta.presentedFrames` 是**累计值** ⇒ 这里存**这一秒的增量**，`presentedFps` 才能当帧率用
    const presDelta = w.pres.supported ? Math.max(0, lastPresented - lastPresentedSampled) : null
    lastPresentedSampled = lastPresented
    const pageDelta = typeof window.requestAnimationFrame === 'function'
      ? Math.max(0, rafCount - rafSampled) : null
    rafSampled = rafCount
    // 页面可见性/焦点：Chromium 对"不可见"的页面**会挂起画面**（音频继续）——
    // 真机三次复现的画面停摆就落在这条上（devlog/309）
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const focused = typeof document === 'undefined' || document.hasFocus()
    /* 全屏时页面里**还有东西在动**吗（devlog/384）：全屏里若有东西一直在动，合成器就永远
       闲不下来 —— 这是 B2 的一条硬假设。⚠️ 只认 `playState === 'running'`（见
       `runningAnimations`），并且把**是谁在动**也记下来（不知道是什么就没法关掉它）。 */
    const anim = runningAnimations()
    if (anim.names.length) {
      const known = w.animNames ?? []
      for (const n of anim.names) if (!known.includes(n) && known.length < 3) known.push(n)
      w.animNames = known
    }
    /* 显示尺寸取**采样期间的最大值**（devlog/387）：报告那一拍元素通常已经卸掉，现场量是 0 */
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
    if (rect && rect.width > 0 && rect.height > 0) {
      const cur = w.maxDisp ?? { w: 0, h: 0 }
      if (rect.width * rect.height > cur.w * cur.h) {
        w.maxDisp = { w: Math.round(rect.width), h: Math.round(rect.height) }
      }
    }
    w.samples.push({ t: tick, fps, decoded: decDelta, presented: presDelta, pageFps: pageDelta,
                     ahead, advanced, hidden, focused,
                     readyState: el.readyState, seeking: el.seeking,
                     dropped: dropDelta, intervals: pendingIntervals,
                     longTasks: pendingLongTasks, anims: anim.count, fs: isFullscreen(),
                     rafMaxMs: pendingRafMax || undefined })
    pendingIntervals = []
    pendingLongTasks = 0
    pendingRafMax = 0
  }
  const timer = window.setInterval(sample, SAMPLE_MS)
  const stop = () => {
    alive = false
    window.clearInterval(timer)
    window.clearTimeout(windowTimer)
    if (rafHandle) window.cancelAnimationFrame(rafHandle)
    longObserver?.disconnect()
    if (typeof document !== 'undefined') document.removeEventListener('fullscreenchange', onFsChange)
  }
  const post = (tag?: string) => {
    // 什么都没采到（挂载就被卸载）就别留垃圾行
    if (!w.samples.length && !w.waiting) return
    void api.clientLog(`${summarize(w, el, performance.now())}${tag ?? ''}`)
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
    /**
     * 被新窗口顶掉（连续拖拽只留最后一次）。
     *
     * ⚠️ `devlog/387`：**播够久的那种"顶掉"不许把证据一起丢掉**。真机上就有过一次 ——
     * 用户跑了三次，其中**唯一不卡的那一次**恰好被下一秒的新窗口顶掉，日志里只剩"另外两次卡"，
     * 而"不卡的那次到底哪一格不一样"正是最值钱的信息。现在跑满 5 秒就留一行（标 `(顶掉)`），
     * 只有拖拽那种秒级的碎窗口才真的丢弃。
     */
    cancel: () => {
      if (w.samples.length >= CANCEL_REPORT_SAMPLES) post(' (顶掉)')
      stop()
    },
  }
}
