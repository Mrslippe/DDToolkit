/**
 * 小窗**自己**从推送通道取通知（M4，devlog/252）。
 *
 * ## 为什么需要它
 *
 * 改造前小窗的通知**全部**来自主窗口：`TopBar` 把汇总好的条目用 Tauri 事件
 * `widget:notices` 广播过来（R38 批 5b），小窗只显示、不取数 —— 好处是"只轮一次"，
 * 代价是**主窗口不在（没开 / 关掉了）小窗就永远是空的**。
 *
 * M4 把这条依赖拆掉一半：小窗**自己连推送通道**（`startMessageBus()`，与主窗口同一条
 * `GET /messages/stream`），把**推送类**通知自己算出来 —— 开播边沿（alert）、任务已受理
 * （progress）、操作完成（瞬时消息）。它与主窗口**并存**：
 *
 * | 主窗口在吗 | 小窗看到什么 |
 * |---|---|
 * | 在 | 两边**同一份**：轮询类（登录失效 / 风控冷却 / 完成报告 / 抓取进度）由广播来，推送类自己算的那份**主动让位**（见 `mergeWidgetNotices`） |
 * | 不在 | 推送类仍然到（这就是 M4 的全部收益）；轮询类暂时没有 —— 那要等 **M5** 把汇总搬到后端 |
 *
 * ⚠️ **`widget:notices` 本轮不删**：它现在还扛着"轮询类"那半边。方案 §3 的原话就是
 * "先并存、后退役"，退役点落在 M5（后端接管汇总之后）。
 *
 * ## 与主窗口共用同一套口径
 *
 * 条目模型、优先级、TTL 全在 `utils/notificationHub.ts`（纯函数，有单测）；
 * 本文件只补两件小窗特有的事：**从页面事件攒出推送类条目**、**与广播来的那份合并**。
 * `PILL_MS` / `PUSHED_PROGRESS_MS` 也从 `TopBar` 搬到这里 —— 两个宿主必须用**同一个**
 * 时长，各写一份迟早会漂（R46 那条"同一份数据不许有两个渲染器"的同款道理）。
 */
import { useEffect, useMemo, useState } from 'react'

import { EVENTS, on } from './appEvents'
import type { LiveEdgePayload, PushedProgressPayload } from './appEvents'
import { liveNotice, messageNotice } from './notificationHub'
import type { Notice } from './notificationHub'
import { startMessageBus } from './messageBus'

/** 操作结果覆盖态的展示时长（原 `TopBar` 常量，两个宿主共用） */
export const PILL_MS = 4000
/** 推送来的「任务已受理」进度条目的兜底 TTL：任务快到"没有任何一轮轮询看见它"时自己过期 */
export const PUSHED_PROGRESS_MS = 8000

/**
 * 把"自己算的推送类条目"与"主窗口广播来的条目"合一份给状态岛。
 *
 * 三条规则，各对应一种"两边并存会难看"的错法：
 * 1. **进度让位**：主窗口的轮询一旦报到同类进度（它更权威、带 i/N），自己那份就撤
 *    —— 与 `TopBar` 内部那条"`manual_running` 变 true 就清 `pushedProgress`"同源；
 * 2. **瞬时消息让位**：消息是"同一件事的两份副本"，两边都显示就是两条一样的通知；
 * 3. **按 id 去重**（自己那份优先）：开播告警两边用同一个 id（`live-<account_id>`）。
 */
export function mergeWidgetNotices(own: Notice[], fromMain: Notice[] | null): Notice[] {
  const main = fromMain ?? []
  const mainHasProgress = main.some((n) => n.kind === 'progress')
  const mainHasMessage = main.some((n) => n.kind === 'message')
  const kept = own.filter((n) => !(
    (n.kind === 'progress' && mainHasProgress) || (n.kind === 'message' && mainHasMessage)
  ))
  const ids = new Set(kept.map((n) => n.id))
  return [...kept, ...main.filter((n) => !ids.has(n.id))]
}

/** 推送类条目的原料（每条都带着**到达时刻** —— TTL 必须从它起算，不能拿渲染时的 `now`） */
export interface StreamNoticeSource {
  liveEdge: { payload: LiveEdgePayload; at: number } | null
  progress: { payload: PushedProgressPayload; at: number } | null
  message: { text: string; at: number } | null
}

/**
 * 纯函数：原料 → 条目（可单测；`now` 只用于过滤已过期的）。
 *
 * ⚠️ **TTL 从 `at` 起算**，不是从 `now` —— 否则每秒重算一次就把过期时间一直往后推，
 * 条目**永远不会消失**（那是"通知越堆越多"的经典形态）。
 */
export function buildStreamNotices(src: StreamNoticeSource, now: number): Notice[] {
  const list: Notice[] = []
  const { liveEdge, progress, message } = src
  if (liveEdge) {
    list.push(liveNotice({
      id: `live-${liveEdge.payload.account_id}`,
      name: liveEdge.payload.name,
      title: liveEdge.payload.live_title,
      now: liveEdge.at,
    }))
  }
  if (progress) {
    list.push({
      id: 'pushed-progress', kind: 'progress', source: '任务进度',
      text: progress.payload.text,
      expiresAt: progress.at + PUSHED_PROGRESS_MS,
    })
  }
  if (message) {
    list.push(messageNotice(message.text, message.at, PILL_MS))
  }
  return list.filter((n) => n.expiresAt === undefined || n.expiresAt > now)
}

/**
 * 小窗的推送类通知（自身的连接 + 事件订阅）。返回**已经过期过滤**的条目。
 *
 * `now` 由小窗那条 1s 心跳传进来（它本来就有 —— ttl 到点的条目得自己消失）。
 * `startMessageBus()` 是幂等的（重复调用不会开第二条流）。
 */
export function useStreamNotices(now: number): Notice[] {
  const [liveEdge, setLiveEdge] = useState<StreamNoticeSource['liveEdge']>(null)
  const [progress, setProgress] = useState<StreamNoticeSource['progress']>(null)
  const [message, setMessage] = useState<StreamNoticeSource['message']>(null)

  // 自己开流：**不依赖主窗口**（这就是 M4）。非桌面端/探针里同样成立 —— 它走的是
  // `apiBase`（Vite 代理或注入的 sidecar 端口），与主窗口用的是同一条端点。
  useEffect(() => {
    startMessageBus()
  }, [])

  useEffect(() => on(EVENTS.liveEdge, (payload) => {
    setLiveEdge({ payload, at: Date.now() })
  }), [])
  useEffect(() => on(EVENTS.progress, (payload) => {
    setProgress({ payload, at: Date.now() })
  }), [])
  // ⚠️ 瞬时消息走 `pillMessage` 而不是 `message`：`notice.message` 在总线里被
  //    `shouldToast`（originator 规则）过滤之后**才**落到 `pillMessage` ——
  //    小窗要的正是"该弹的那条"，两处口径必须同一条（见 messageBus 的注释）。
  useEffect(() => on(EVENTS.pillMessage, (d) => {
    const text = (d as { text?: string } | null)?.text
    if (text) setMessage({ text, at: Date.now() })
  }), [])

  return useMemo(
    () => buildStreamNotices({ liveEdge, progress, message }, now),
    [liveEdge, progress, message, now],
  )
}
