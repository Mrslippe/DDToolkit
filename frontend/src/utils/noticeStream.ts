/**
 * 通知的取数与合并（M4 起于小窗；**M5-2b 起两个宿主共用**）。
 *
 * ## 单一真源 = 后端
 *
 * M5-1（devlog/253）把"汇总"搬到了后端：`GET /vtuber/notices` 直接给出**已排序**的条目 +
 * 服务端 `now`（ttl 基准）+ `manual_running`。本文件负责把它取回来，并与**本地覆盖**合并。
 *
 * ## 为什么还要本地覆盖（而不是纯轮询）
 *
 * 三条都是实测/设计边界，不是偷懒：
 * 1. **瞬时消息的 TTL（4s）短于空闲轮询（10s）** ⇒ 纯轮询**必然漏**（推送到达时先本地显示，
 *    下一轮轮询带回服务端那份时按 kind 让位，见 `mergeNotices`）；
 * 2. **"任务已受理"后端不进环形缓冲**（`_note_manual_start` 只 publish）⇒ 点完按钮那一瞬
 *    只有推送知道，等轮询就是 3–10s（那正是 M2 要消掉的等待）；
 * 3. **客户端自己的事实**（磁盘快满、发现新版本）后端根本不知道 ⇒ 只能本地出条目。
 *
 * ## 合并规则（三条，各对应一种"两边并存会难看"的错法）
 *
 * 1. **同类让位**：服务端一旦报到 progress / message，本地那份立刻撤（服务端更权威、
 *    带 i/N 与真正的记录时刻）；
 * 2. **按 id 去重**（本地优先）：开播告警两边用同一个 id（`live-<account_id>`）；
 * 3. **过期过滤**：本地条目的 TTL 从**到达时刻**起算（不能拿渲染时的 `now` —— 否则每秒
 *    重算就把过期时间往后推，条目永远不会消失）。
 *
 * ⚠️ **`widget:notices` 广播已退役**（M5-2b）：各宿主各自拉同一个端点，
 * 不再需要"主窗口替别人取数"那条通道（小窗那条宿主 2026-10-01 整窗退役，
 * 但这条合并规则与宿主无关，照旧成立）。
 */
import { useEffect, useMemo, useState } from 'react'

import { api } from '../api/api'
import { EVENTS, on } from './appEvents'
import type { LiveEdgePayload, PushedProgressPayload } from './appEvents'
import { liveNotice, messageNotice, EVENT_TTL_MS } from './notificationHub'
import type { Notice } from './notificationHub'
import { startMessageBus } from './messageBus'

/** 操作结果覆盖态的展示时长（两个宿主共用；服务端那份 `MSG_TTL_MS` 与它同值）
 *
 *  ⚠️ L1（2026-10-05）：值从 4000 提到 6000（`EVENT_TTL_MS`，设计案 §3.1）——
 *  告知类的默认时长。三处必须同值：这里、后端 `notices.MSG_TTL_MS`、以及
 *  `notificationHub.EVENT_TTL_MS`（有用例对账，别只改一处）。 */
export const PILL_MS = EVENT_TTL_MS
/** 推送来的「任务已受理」进度条目的兜底 TTL：任务快到"没有任何一轮轮询看见它"时自己过期 */
export const PUSHED_PROGRESS_MS = 8000

/**
 * 服务端进度到达后，本地那条「受理进度」**再多留这么久**（L1）。
 *
 * 为什么需要：`mergeNotices` 的让位是"本地撤 + 服务端上"两件事，而服务端那条的**到达节奏**
 * 与本地这条无关 ⇒ 存在"本地已撤、服务端还没进列表"的空窗（`devlog/341` 里探针连读三次
 * 都撞在空窗上）。3 秒的并存窗口把空窗糊掉，而两条的文案同源（`compose_task_text`），
 * 叠在一起看是同一句话，不会误导。
 */
export const HANDOVER_GRACE_MS = 3000

/** 最近一次"服务端报了进度"的时刻（模块级：本模块只服务一个宿主；见 `mergeNotices`） */
let handedOverAt: number | null = null

/** 清掉让位宽限窗口（**单测用**：模块级状态跨用例串味会让"先并存再撤"那条时绿时红） */
export function resetHandover(): void {
  handedOverAt = null
}

/**
 * 把**本地覆盖**与**服务端列表**合一份给状态岛。
 *
 * `local` = 只在本进程知道的条目（推送来的进度/消息、dev 注入的自检条目、磁盘/更新提示）；
 * `server` = `GET /vtuber/notices` 那份（权威：进度、风控、登录、完成报告、环形消息）。
 */
export function mergeNotices(local: Notice[], server: Notice[] | null): Notice[] {
  const srv = server ?? []
  // ⚠️ **按任务让位，不是按 kind**（2026-09-30 探针实测抓到）：本地那条"任务已受理"只该被
  // **同一个任务**的服务端进度顶掉（`progress-post` / `progress-account`）——
  // 写成"服务端只要有 progress 就让位"时，**外部同步**那条（`progress-external`，与手动动作
  // 无关，且常常一直在跑）会把本地进度一起顶掉 ⇒ 点按钮的人又得等 3–10s 轮询（M2 的收益没了）。
  // 旧口径（TopBar 的 `status.manual_running` 一变真就清 `pushedProgress`）也是这个粒度。
  //
  // ⚠️ L1（2026-10-05，`devlog/341`）**再收紧一格**：上面的判据是"服务端**有没有**
  // 任务进度"，而不是"有没有**这一条**的进度"。探针 `--messages` 实测抓到过后果：
  // 探针发一条 `task='account'` 的受理进度，而此刻服务端正在跑**另一个**任务
  // （收录回填/第三方同步）⇒ 本地那条被无辜顶掉，面板里找不到它
  // （报"推了受理进度，面板里却没有"）。⇒ 现在**按 id 配对**：本地 `pushed-progress`
  // 带着它自己的 `task`，只有服务端出现**同一个任务**的进度条目时才让位。
  //
  // ⚠️ 让位那一下**不许闪**：服务端轮询一到，本地这条立刻消失、服务端那条在同一次渲染里
  // 出现 —— 顺序上没问题（`[...kept, ...srv]`），但**服务端的进度条目有自己的到达节奏**，
  // 于是存在"本地已撤、服务端还没进列表"的空窗（`devlog/341` 里探针连读三次都撞在空窗上）。
  // 滚动窗口实现的"见过服务端 3 秒内不撤本地"就是为它：两条并存最多 3 秒（文案同源），
  // 而"永远不撤"会让本地那条赖着不走（8s TTL 到了才消失）。
  const now = Date.now()
  const localInFlight = local.some((n) => n.id === 'pushed-progress')
  const srvHasProgress = srv.some((n) => n.kind === 'progress')
  if (localInFlight && srvHasProgress) {
    // ⚠️ **只在进入让位那一刻记时间**（`??=`）：每拍都刷新会让宽限窗口**永远不会到点**
    //（窗口从"最后一次调用"起算 ⇒ 每 ≤3s 调一次就永远宽限下去），第一版就是这么写的。
    handedOverAt ??= now
  }
  if (!localInFlight) handedOverAt = null     // 本地那条走了 ⇒ 窗口复位，下一次重新计
  const justHanded = handedOverAt !== null && now - handedOverAt < HANDOVER_GRACE_MS
  const srvTasks = new Set(srv.filter((n) => n.kind === 'progress').map((n) => n.id))
  const handOver = (n: Notice) =>
    n.id === 'pushed-progress'
      ? !justHanded && srvTasks.has(`progress-${(n as Notice & { task?: string }).task ?? ''}`)
      : n.kind === 'progress' && (srvTasks.has('progress-post') || srvTasks.has('progress-account'))
  const srvHasMessage = srv.some((n) => n.kind === 'message')
  const kept = local.filter((n) => !(
    (n.kind === 'progress' && handOver(n)) || (n.kind === 'message' && srvHasMessage)
  ))
  // 服务端那条与本地这条**同 id 时去重**（本地优先）：本地带的是推送那一刻的文案/到达时刻
  const ids = new Set(kept.map((n) => n.id))
  return [...kept, ...srv.filter((n) => !ids.has(n.id))]
}

/** 本地覆盖的原料（每条都带着**到达时刻** —— TTL 必须从它起算，不能拿渲染时的 `now`） */
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
      id: 'pushed-progress', kind: 'progress', form: 'state', source: '任务进度',
      text: progress.payload.text,
      // `task` 是**配对用**的机器字段（`account`/`post`/`update`…）：`mergeNotices` 靠它认出
      // "服务端这份进度是不是同一条任务的"，从而只让**同一个任务**的服务端进度顶掉本地的
      // （L1 收紧，见 `mergeNotices` 的注释）。它不进 UI。
      ...({ task: progress.payload.task || '' } as object),
      createdAt: progress.at,
      expiresAt: progress.at + PUSHED_PROGRESS_MS,
    } as Notice)
  }
  if (message) {
    list.push(messageNotice(message.text, message.at, PILL_MS))
  }
  return list.filter((n) => n.expiresAt === undefined || n.expiresAt > now)
}

/**
 * 两扇窗共用的通知取数：**轮询服务端 + 订阅推送 + 合并**。
 *
 * - `poll` 由宿主决定节奏（主窗口跟它那条 fetch-status 链同拍；小窗自己一条 3s 链），
 *   返回的是一个"取一次"的函数 —— 这样"节奏"只有一处（宿主的 schedule），
 *   hook 不自己造定时器（否则两扇窗各有一条隐藏的链，R18 的托盘停摆判据会漏掉它）；
 * - `startMessageBus()` 幂等（重复调用不会开第二条流）—— 推送那一路**两个宿主都要**：
 *   主窗口收进托盘时它仍在（M1 立的规矩），小窗独立时它是唯一的即时来源（M4）。
 */
export function useNotices(now: number, options: {
  /** 服务端列表（宿主轮询得到；null = 还没取到第一份） */
  server: Notice[] | null
  /** 额外的本地条目（dev 注入的自检条目等），与推送类一起参与合并 */
  extraLocal?: Notice[]
}): Notice[] {
  const { server, extraLocal } = options
  const [liveEdge, setLiveEdge] = useState<StreamNoticeSource['liveEdge']>(null)
  const [progress, setProgress] = useState<StreamNoticeSource['progress']>(null)
  const [message, setMessage] = useState<StreamNoticeSource['message']>(null)

  // 自己开流：**不依赖另一扇窗**（M4）。非桌面端/探针里同样成立 —— 它走 `apiBase`
  // （Vite 代理或注入的 sidecar 端口），与主窗口用的是同一条端点。
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
  //    我们要的正是"该弹的那条"，两处口径必须同一条（见 messageBus 的注释）。
  useEffect(() => on(EVENTS.pillMessage, (d) => {
    const text = (d as { text?: string } | null)?.text
    if (text) setMessage({ text, at: Date.now() })
  }), [])

  return useMemo(() => {
    const local = [...buildStreamNotices({ liveEdge, progress, message }, now), ...(extraLocal ?? [])]
    return mergeNotices(local, server)
  }, [liveEdge, progress, message, now, server, extraLocal])
}

/** 轮询函数工厂：宿主把它塞进自己的 schedule 链（`await fetchNotices()` → `setNotices`）。 */
export function useNoticesPoll(
  onPayload: (data: { now: number; notices: Notice[]; manual_running: boolean }) => void,
): () => Promise<void> {
  return useMemo(() => async () => {
    try {
      const data = await api.getNotices()
      onPayload(data)
    } catch {
      /* 后端不可达时保持上一份（与 fetch-status 那条链同一处置） */
    }
  }, [onPayload])
}
