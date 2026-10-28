import { useSyncExternalStore } from 'react'

import { api } from '../api/api'
import type { FanAnalyzeProgress, FanCollectProgress } from '../api/types'

/**
 * 工作台的**采集任务**（2026-10-28，B 批）。
 *
 * ## 为什么必须是应用级 store，而不是页面里的 `useState`
 *
 * 用户口径（2026-10-28）：「小窗允许暂时关闭，抓取进程保持在后台，在顶栏中展示出来」。
 * 采集本来就跑在后端（`_TASKS`），**真正会"停"的是前端这一侧的轮询**：
 * 轮询原来挂在 `WorkbenchPage` 的 `useEffect` 里 ⇒ 一离开工作台、关掉浮窗，
 * 进度就没人看了。所以把「任务状态 + 轮询循环」搬到模块级：
 *
 * - 谁都能读（工作台、任务浮窗、未来的顶栏点击入口）；
 * - 组件卸载/切页/关浮窗**不影响**轮询；
 * - 同一时刻只允许一个任务（采集与分析互斥：它们吃同一份数据目录和 CPU）。
 *
 * 与 `utils/hideNicknames.ts` / `utils/groupBadgePref.ts` 同一套路（模块级现值 + 订阅），
 * 区别是这里的状态会**频繁变**（每秒一拍），所以只在真的变了时 `emit`。
 *
 * ⚠️ 分析与采集共用这个 store，但**分析侧要等后端任务化**（逐场进度）才有 `kind: 'analyze'`
 * 的真实进度。在此之前，分析仍由页面自己发请求，`kind` 恒为 `'collect'`。
 * ⚠️ 任务结束后**不自动清空**：`state` 停在 `done/failed/cancelled` 上，
 * 让浮窗能显示"完成/失败原因"，也让页面能据此刷新一次活动。清空由 `dismissTask()` 触发。
 */

export type FanTaskKind = 'collect' | 'analyze'
export type FanTaskState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'

export interface FanTaskSnapshot {
  kind: FanTaskKind | null
  /** 任务属于哪个主播（与页面当前选中的 V **可以不同**：切走不该丢掉正在跑的任务） */
  vtuber: string
  since: string
  until: string
  state: FanTaskState
  progress: FanCollectProgress | null
  /** 失败原因（`state === 'failed'` 时有值；不静默失败） */
  error: string | null
  /** 结束时刻（ms）。页面用它做"刚刚结束**这一次**"的边沿判断 */
  finishedAt: number | null
  /** 结束那一刻的进度快照（清空 `progress` 后浮窗仍能显示结果摘要） */
  result: FanCollectProgress | null
  /** 任务浮窗是否打开（2026-10-28 C 批：浮窗**不自动弹**，由用户点顶栏通知打开） */
  openWindow: boolean
  /**
   * 「请求分析」的自增计数（C 批）。
   * 为什么不放回调：浮窗挂在 `App` 上，而分析逻辑在工作台页里 —— 用回调会变成
   * "全局注册一个可能已经卸载的函数"。改成计数：工作台监听它的变化，自己决定怎么分析。
   */
  analyzeRequest: number
}

const IDLE: FanTaskSnapshot = {
  kind: null, vtuber: '', since: '', until: '', state: 'idle',
  progress: null, error: null, finishedAt: null, result: null,
  openWindow: false, analyzeRequest: 0,
}

/** 采集进度轮询间隔。采集一场 2~18 秒，1 秒一刷够用且不打满后端 */
export const POLL_MS = 1000

/**
 * 顶栏刷新事件（2026-10-28，第 3 条改进）。
 *
 * 顶栏的进度胶囊来自**后端** `notices.progress-fan`，而顶栏是轮询/推送拿通知的 ——
 * 于是"点了采集 → 顶栏出现"会差 1~3 秒（等下一拍）。任务一发起就广播这个事件，
 * 顶栏收到后**立刻**拉一次通知，延迟就降到一次请求（几十毫秒）。
 *
 * ⚠️ 用 DOM 事件而不是 import 耦合：`TopBar` 已经在渲染树上层，反向依赖 store 的
 * 内部函数没必要；事件也让"谁发起"与"谁听"解耦。
 */
export const FAN_TASK_EVENT = 'ddtoolkit:fan-task-changed'

function notifyTopBar(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FAN_TASK_EVENT))
}

let snap: FanTaskSnapshot = IDLE
const subs = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
/** 连续"后端没有任务条目"的次数（见 `tick`：一次空不判死）。 */
let emptyProbes = 0

function emit(patch: Partial<FanTaskSnapshot>): void {
  snap = { ...snap, ...patch }
  for (const fn of [...subs]) fn()
}

function stopPolling(): void {
  if (timer != null) { clearInterval(timer); timer = null }
}

/** 当前快照（非组件读取用） */
export function fanTask(): FanTaskSnapshot {
  return snap
}

export function subscribeFanTask(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** 组件里读任务（状态变了就重渲染） */
export function useFanTask(): FanTaskSnapshot {
  return useSyncExternalStore(subscribeFanTask, fanTask, fanTask)
}

/** 有任务在跑吗（互斥判定用；顶栏/按钮禁用都读它） */
export function fanTaskRunning(): boolean {
  return snap.state === 'running'
}

async function tick(vtuber: string): Promise<void> {
  try {
    const r = await api.fanCollectStatus(vtuber)
    const p = r.items[0] ?? null
    if (!p) {
      /* 后端没有这个任务条目 = 从未开始、或已被清掉（重启/清缓存）。
         ⚠️ **一次空响应不判死**（2026-10-28）：任务刚发起时后端可能还没登记，
         单次空就结束会让界面闪一下"完成"、甚至让页面误以为采集结束了。
         连续两拍都空才收摊。 */
      emptyProbes += 1
      if (emptyProbes < 2) return
      stopPolling()
      emit({ state: 'done', progress: null, result: null, finishedAt: Date.now() })
      notifyTopBar()
      return
    }
    emptyProbes = 0
    if (p.state === 'running') {
      emit({ progress: p })
      return
    }
    stopPolling()
    const state: FanTaskState =
      p.state === 'done' ? 'done' : p.state === 'cancelled' ? 'cancelled' : 'failed'
    emit({
      progress: p, result: p, state, finishedAt: Date.now(),
      error: state === 'failed' ? (p.message || '采集失败（没有更多信息）') : null,
    })
    notifyTopBar()
  } catch {
    /* 轮询失败不弹窗、不结束任务：下一拍再试（后端重启/网络抖动都靠这个兜住） */
  }
}

function startPolling(vtuber: string): void {
  stopPolling()
  timer = setInterval(() => { void tick(vtuber) }, POLL_MS)
}

/**
 * 发起采集。`liveIds` 为空 = 采区间内全部待采场次（对比页"采集并分析"用这条）。
 *
 * ⚠️ 发起请求失败要**如实落到 `state: 'failed'`**，不能只 throw 给调用方 ——
 *    否则浮窗/顶栏会以为任务还在跑（`running` 永远不结束）。
 */
export async function startCollect(opts: {
  vtuber: string
  since: string
  until: string
  liveIds: Array<{ live_id: string; start_at: string }>
  /** 预估总场次（来自窗口读数；未知给 0 = 浮窗显示"?"而不是编一个数） */
  total: number
}): Promise<void> {
  if (snap.state === 'running') throw new Error('已有任务正在运行，等它结束或先取消')
  stopPolling()
  const stub: FanCollectProgress = {
    vtuber: opts.vtuber, since: opts.since, until: opts.until, state: 'running',
    total: opts.total, done: 0, failed: 0, skipped: 0,
    current: '', message: '', elapsed: 0,
  }
  emit({
    kind: 'collect', vtuber: opts.vtuber, since: opts.since, until: opts.until,
    state: 'running', progress: stub, error: null, finishedAt: null, result: null,
  })
  try {
    await api.fanCollect(opts.vtuber, opts.since, opts.until, opts.liveIds)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ state: 'failed', error: msg, finishedAt: Date.now() })
    throw e
  }
  /* 用户口径（2026-10-28 修订）：点采集后**直接弹窗**看细节。
     关掉它不影响任务（轮询在本模块），顶栏胶囊照旧。 */
  emit({ openWindow: true })
  notifyTopBar()
  startPolling(opts.vtuber)
  void tick(opts.vtuber)      // 立刻探一次：首个进度不用等 1 秒（2026-10-28）
}

/** 取消当前采集（后端立即中断；失败就把原因抛给调用方显示） */
export async function cancelCollect(): Promise<void> {
  if (snap.kind !== 'collect' || snap.state !== 'running') return
  await api.fanCollectCancel(snap.vtuber)
}

/** 分析进度 → 浮窗认识的形状（浮窗只画，不想为两种任务写两套模板） */
function asProgress(a: FanAnalyzeProgress): FanCollectProgress {
  return {
    vtuber: a.vtuber, since: a.since ?? '', until: a.until ?? '',
    state: a.state === 'done' ? 'done' : a.state === 'failed' ? 'failed' : 'running',
    total: a.total, done: a.done, failed: 0, skipped: 0,
    current: a.current, message: a.error, elapsed: 0, phase: a.phase,
    sessions_detail: [],
  }
}

async function analyzeTick(vtuber: string): Promise<void> {
  try {
    const r = await api.fanAnalyzeStatus(vtuber)
    const a = r.items[0] ?? null
    if (!a) {
      emptyProbes += 1
      if (emptyProbes < 2) return       // 同采集：一次空不判死
      stopPolling()
      emit({ state: 'done', progress: null, result: null, finishedAt: Date.now() })
      notifyTopBar()
      return
    }
    emptyProbes = 0
    if (a.state === 'running') {
      emit({ progress: asProgress(a) })
      return
    }
    stopPolling()
    const state: FanTaskState = a.state === 'done' ? 'done' : 'failed'
    emit({
      progress: asProgress(a), result: asProgress(a), state, finishedAt: Date.now(),
      error: state === 'failed' ? (a.error || '分析失败（没有更多信息）') : null,
    })
    notifyTopBar()
  } catch {
    /* 同采集：轮询失败不结束任务，下一拍再试 */
  }
}

/**
 * 发起分析（2026-10-28）。
 *
 * ⚠️ **分析没有取消**：后端是纯计算，没有 `_STOP` 那样的中断点；前端「取消」按钮
 * 在分析任务上是灰的（见 `FanTaskDialog`）。要说清楚，别让用户以为点了会立刻停。
 */
export async function startAnalyze(opts: {
  vtuber: string
  window: number
  since: string
  until: string
  /** 窗口清单：**必须与页面随后 `/ranked` 的 ids 一致**，否则缓存键不同、结果要重算一遍 */
  liveIds?: string[]
}): Promise<void> {
  if (snap.state === 'running') throw new Error('已有任务正在运行，等它结束或先取消')
  stopPolling()
  const stub: FanCollectProgress = {
    vtuber: opts.vtuber, since: opts.since, until: opts.until, state: 'running',
    total: 0, done: 0, failed: 0, skipped: 0,
    current: '', message: '', elapsed: 0, phase: 'load',
  }
  emit({
    kind: 'analyze', vtuber: opts.vtuber, since: opts.since, until: opts.until,
    state: 'running', progress: stub, error: null, finishedAt: null, result: null,
  })
  try {
    await api.fanAnalyzeStart(opts.vtuber, {
      window: opts.window,
      since: opts.since || undefined,
      until: opts.until || undefined,
      ids: opts.liveIds?.length ? opts.liveIds : undefined,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ state: 'failed', error: msg, finishedAt: Date.now() })
    throw e
  }
  // 与采集同一口径：发起即弹窗（2026-10-28 用户修订）
  emit({ openWindow: true })
  notifyTopBar()
  stopPolling()
  timer = setInterval(() => { void analyzeTick(opts.vtuber) }, POLL_MS)
  void analyzeTick(opts.vtuber)   // 同上：首个进度立刻探
}

/** 关掉浮窗/收起提示时清空（**只对已结束的任务生效**，运行中不许清） */
export function dismissTask(): void {
  if (snap.state === 'running') return
  stopPolling()
  emit({ ...IDLE })
  notifyTopBar()
}

/** 打开任务浮窗（顶栏通知点击 / 工作台「查看进度」都走它） */
export function openTaskWindow(): void {
  emit({ openWindow: true })
}

/** 只关窗口，**不动任务**（任务继续跑，顶栏通知还在） */
export function closeTaskWindow(): void {
  if (!snap.openWindow) return
  emit({ openWindow: false })
}

/**
 * 请求分析（浮窗的「分析」按钮）：**只发信号**，真正的分析由工作台页执行。
 * 同时把浮窗关掉 —— 分析开始后进度由工作台的结果区接管（用户口径：完成 = 回工作台）。
 */
export function requestAnalyze(): void {
  emit({ analyzeRequest: snap.analyzeRequest + 1, openWindow: false })
}

/**
 * 清回初始状态 —— **只给用例用**。
 * 与 `resetHideNicknames()` 同一路数：模块级状态不重置会跨用例串味。
 */
export function resetFanTask(): void {
  stopPolling()
  emptyProbes = 0          // ⚠️ 这个计数是模块级的，不重置会跨用例累积
  snap = IDLE
  for (const fn of [...subs]) fn()
}
