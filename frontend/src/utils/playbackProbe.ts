/**
 * 播放诊断（2026-10-03，devlog/306）：把"跳转后画面低帧率"这类**只在真机上出现**的现象
 * 变成一行可以交给开发者的数字。
 *
 * ## 为什么要它
 *
 * 用户报的是：「点跳转 → 画面先卡在一帧 → 以很低的帧率播一段 → 再正常；音频全程正常」。
 * 这句话能排除"音画不同步"，但**分不出**是 CDN 慢、本机代理慢、还是浏览器/解码慢：
 * · CDN/代理慢 ⇒ 本机日志里那条 `[视频代理]` 诊断行会显示首字节/前 5 秒吞吐；
 * · 浏览器侧慢 ⇒ 这里量到的**有效帧率**与**掉帧数**会难看，而缓冲其实是够的。
 *
 * 两边一对照，结论就不用猜了。
 *
 * ## 口径
 *
 * · 只量**一段窗口**（默认 8 秒，从 seek 到位 / 起播那一刻开始）；
 * · 帧数用 `getVideoPlaybackQuality()`（没有就退回 `webkitDecodedFrameCount`）；
 * · 一行一并发给后端（`POST /settings/client-log`）⇒ 落进 `logs/app.log`，
 *   与代理那些行在**同一个文件**里，用户一次就能把整条证据交上来；
 * · 失败（没网/端点不通）**静默**：诊断绝不影响播放。
 */
import { api } from '../api/api'

export interface PlaybackWindow {
  /** 哪个动作触发的（`seek` / `start`） */
  reason: string
  /** 目标时刻（seek 才有） */
  targetS?: number
  /** 窗口开始时刻（ms，`performance.now()`） */
  startedAt: number
  /** 进入窗口那一刻的丢帧计数（用来算增量） */
  frames: number
  dropped: number
  /** 窗口内 `waiting` 次数（画面饿住的次数） */
  waiting: number
  /** 窗口内见过的最低"前方缓冲"（秒；null = 量不到） */
  minAhead: number | null
  /** 从窗口开始到**第一次真的出画**（`playing`）用了多久（ms；null = 窗口内没出画） */
  readyMs: number | null
}

const WINDOW_MS = 8000

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
  return { reason, targetS, startedAt: performance.now(), frames, dropped,
           waiting: 0, minAhead: null, readyMs: null }
}

/** 当前位置前方还有多少秒缓冲（不在任何缓冲区间 ⇒ null）。 */
export function aheadOf(el: HTMLVideoElement): number | null {
  try {
    for (let i = 0; i < el.buffered.length; i += 1) {
      if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i)) {
        return el.buffered.end(i) - el.currentTime
      }
    }
  } catch {
    /* 量不到就算了 */
  }
  return null
}

/** 把窗口收成一行（纯函数，便于单测：数字怎么算的都能钉住）。 */
export function summarize(w: PlaybackWindow, el: HTMLVideoElement, now: number): string {
  const elapsed = (now - w.startedAt) / 1000
  const { frames, dropped } = frameStats(el)
  const gained = Math.max(0, frames - w.frames)
  const droppedGained = Math.max(0, dropped - w.dropped)
  const fps = elapsed > 0 ? gained / elapsed : 0
  const parts = [
    `[video] ${w.reason}${w.targetS != null ? `→${w.targetS.toFixed(1)}s` : ''}`,
    `窗口=${elapsed.toFixed(1)}s`,
    `起播=${w.readyMs == null ? '未出画' : `${(w.readyMs / 1000).toFixed(1)}s`}`,
    `饿住=${w.waiting}次`,
    `最低缓冲=${w.minAhead == null ? '量不到' : `${w.minAhead.toFixed(1)}s`}`,
    `帧率=${fps.toFixed(1)}fps`,
    `丢帧=${droppedGained}/${gained}`,
    `已缓冲=${aheadOf(el)?.toFixed(1) ?? '?'}s`,
  ]
  return parts.join(' ')
}

export interface ProbeHandle {
  noteWaiting: () => void
  noteAhead: (v: number | null) => void
  noteReady: () => void
  /** 取消（组件卸载 / 又被新的窗口顶掉）——**必须取消**：否则窗口会在卸载后照样发一行，
   *  连续拖拽还会攒出一串没人看的行（单测里表现为"跑完还有一堆定时器"）。 */
  cancel: () => void
}

/**
 * 开一个窗口并在 `WINDOW_MS` 后收尾上报（**一个播放器同时只跟一个窗口**：
 * 连续拖拽会反复开窗，旧的那个直接丢弃 —— 我们要的是"这次操作之后发生了什么"）。
 */
export function watchPlayback(el: HTMLVideoElement, reason: string, targetS?: number): ProbeHandle {
  const w = openWindow(el, reason, targetS)
  let alive = true
  const timer = window.setTimeout(() => {
    if (!alive) return
    alive = false
    const line = summarize(w, el, performance.now())
    void api.clientLog(line).catch(() => { /* 诊断上报失败就算了，绝不影响播放 */ })
  }, WINDOW_MS)
  return {
    noteWaiting: () => { w.waiting += 1 },
    noteAhead: (v) => {
      if (v == null) return
      w.minAhead = w.minAhead == null ? v : Math.min(w.minAhead, v)
    },
    noteReady: () => { if (w.readyMs == null) w.readyMs = performance.now() - w.startedAt },
    cancel: () => { alive = false; window.clearTimeout(timer) },
  }
}
