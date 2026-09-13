/**
 * 场景切换机：**预取门控 + 原子提交**（从 `PostsPage` 抽出，devlog/080）。
 *
 * 它存在的理由只有一个：**全程没有「正在加载」闪帧**。切 V（或切视图）时——
 *
 * ```
 * 目标变化 → 并行预取新 V 数据（旧内容冻结可见）
 *          → 数据就绪 → exiting=true（旧内容 fall-out 淡出）
 *          → EXIT_MS 后一次性提交（写入预取数据 + exiting=false）→ 新内容入场
 * ```
 *
 * ## 契约（只搬不改，语义与抽出前逐行一致）
 *
 * - **只负责状态与定时器**：取什么数据（`prefetch`）、提交时写哪些 state（`onCommit`）、
 *   失败怎么收尾（`onFail`）都由调用方注入 —— 这个 hook 不 import `api`，
 *   也就保住"纯机器"的可测与可读；
 * - **同目标复用**：`prefetch` 只对"目标账号"发起一次；在途/已就绪都直接复用；
 * - **快速连点**：新目标会替换 `prefetchRef`，旧请求的晚到结果由 `alive()` 丢弃
 *   （**注意：旧请求不会 abort** —— 与抽出前一致；要省配额可在 `prefetch` 里自行 abort）；
 * - **失败兜底**：预取失败也进 `done`，提交时走 `onFail`（不留"永远转圈"）；
 * - **仅视图变化**：无数据依赖，直接退场 → `EXIT_MS` 后提交。
 *
 * ## 为什么要有护栏（devlog/071 的教训）
 *
 * 这台机器的错法很隐蔽：**进了退场态却没提交**，画面停在淡出的中间相 ——
 * 布局不变量（出窗/滚动条/宽度）对此完全无感。`ui_probe.py --scene` 现在会真的点侧栏切 V，
 * 记录 fetch 全程 + `.view-body` 的 class 变化，未提交即判失败。
 * （071 三次"卡死"其实是探针在看点击前抓到的旧节点，见 devlog/080。）
 */
import { useEffect, useRef, useState } from 'react'

/** 场景退场时长（ms）：与 `styles/layout.css` 的 `.scene-exit` 0.2s 保持同步 */
export const EXIT_MS = 200

export interface PrefetchEntry<T> {
  acc: number
  controller: AbortController
  done: boolean
  failed?: string
  data?: T
}

interface Options<T, V extends string> {
  /** 当前目标账号 / 视图（提交后才会成为"已生效"的那一个） */
  vtuberId: number
  view: V
  /** 取数据；`signal` 供调用方传给可取消的请求（hook 不自行 abort） */
  prefetch: (acc: number, view: V, signal: AbortSignal) => Promise<T>
  /** 提交：把预取结果一次性写进页面状态 */
  onCommit: (data: T, ctx: { vtuberId: number; view: V }) => void
  /** 预取失败时的收尾（清空 + 错误占位） */
  onFail: (message: string | undefined, ctx: { vtuberId: number; view: V }) => void
  /** 退场时长覆盖（测试用；默认 `EXIT_MS`） */
  exitMs?: number
}

export interface SceneTransition<V extends string> {
  /** 当前**已提交**的账号（渲染用它，而不是目标 `vtuberId`） */
  sceneAcc: number
  sceneView: V
  /** 是否处于退场态（`view-body` 挂 `.scene-exit`） */
  exiting: boolean
}

export function useSceneTransition<T, V extends string>({
  vtuberId, view, prefetch, onCommit, onFail, exitMs = EXIT_MS,
}: Options<T, V>): SceneTransition<V> {
  const [scene, setScene] = useState({ acc: vtuberId, view, exiting: false })
  const [readyTick, bumpReady] = useState(0)
  const entryRef = useRef<PrefetchEntry<T> | null>(null)
  // 提交回调放进 ref：定时器闭包可能过期，而 effect 依赖里不该带回调（会每帧重跑）
  const cbRef = useRef({ prefetch, onCommit, onFail })
  cbRef.current = { prefetch, onCommit, onFail }

  /** 启动（或复用）对 `acc` 的预取；完成/失败都会 `bumpReady` 让门控 effect 重跑 */
  const startPrefetch = (acc: number, targetView: V) => {
    const pf = entryRef.current
    if (pf && pf.acc === acc) return // 同目标：在途或已就绪，复用
    const controller = new AbortController()
    const entry: PrefetchEntry<T> = { acc, controller, done: false }
    entryRef.current = entry
    const alive = () => entryRef.current === entry
    const finish = () => {
      if (!alive()) return
      entry.done = true
      bumpReady((x) => x + 1)
    }
    cbRef.current
      .prefetch(acc, targetView, controller.signal)
      .then((data) => {
        if (!alive()) return
        entry.data = data
        finish()
      })
      .catch((e: Error) => {
        if (!alive()) return
        entry.failed = e?.message || '加载失败'
        finish()
      })
  }

  useEffect(() => {
    const accChanged = scene.acc !== vtuberId
    const viewChanged = scene.view !== view
    if (!accChanged && !viewChanged && !scene.exiting) return

    // 仅视图变化：无数据依赖，立即退场 → 提交
    if (!accChanged) {
      setScene((s) => (s.exiting ? s : { ...s, exiting: true }))
      const t = setTimeout(() => {
        entryRef.current = null
        setScene({ acc: vtuberId, view, exiting: false })
      }, exitMs)
      return () => clearTimeout(t)
    }

    // 账号变化：预取门控
    startPrefetch(vtuberId, view)
    const pf = entryRef.current
    const ready = !!pf && pf.acc === vtuberId && pf.done
    if (!ready) {
      // 未就绪：旧内容保持可见冻结（若在退场中先回退），等预取完成信号重入门控
      setScene((s) => (s.exiting ? { ...s, exiting: false } : s))
      return
    }
    setScene((s) => (s.exiting ? s : { ...s, exiting: true }))
    const t = setTimeout(() => {
      const entry = entryRef.current
      const ctx = { vtuberId, view }
      if (entry && entry.acc === vtuberId && entry.data !== undefined && !entry.failed) {
        cbRef.current.onCommit(entry.data, ctx)
      } else {
        cbRef.current.onFail(entry?.failed, ctx)
      }
      entryRef.current = null
      setScene({ acc: vtuberId, view, exiting: false })
    }, exitMs)
    return () => clearTimeout(t)
    // startPrefetch 是每次渲染新建的闭包：不进依赖（它只读 ref 与 props），
    // 依赖里放它会让 effect 每帧重跑、把提交定时器反复清掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vtuberId, view, scene.acc, scene.view, scene.exiting, readyTick, exitMs])

  return { sceneAcc: scene.acc, sceneView: scene.view, exiting: scene.exiting }
}
