/**
 * 外壳可见性生命周期（R18，devlog/095）—— 「隐藏到托盘后前端不再渲染」的那一半。
 *
 * 为什么需要它：窗口**隐藏**之后 WebView2 本来就不再绘制，但页面里的 JS 还在跑 ——
 * 顶栏 10s 抓取轮询、60s 登录态轮询、状态岛 6s 空闲轮播定时器…… 隐藏 8 小时就是几千次
 * 无意义的请求与重渲染。所以"隐藏"必须**主动告诉前端**，让它把表停掉。
 *
 * 三条设计取舍：
 * 1. **不是 `document.visibilitychange`**：窗口 `hide()` 在 WebView2 里不一定触发它
 *    （而且它在切到别的窗口时也会触发，语义不准）。事实来源是 Rust 侧发的
 *    `shell:hidden` / `shell:shown` 事件；浏览器/探针环境退化为 `visibilitychange`。
 * 2. **恢复要"立刻刷一轮"**：只恢复定时器的话，用户回来看到的是最多 10s 前的旧数据 ——
 *    所以订阅者拿到 `false`（可见）时应当主动拉一次，再开始定时。
 * 3. **纯模块 + 可注入的 dev 钩子**：判定逻辑不依赖 React，探针能在 dev 构建下
 *    用 `window.__ddtoolkitSetShellHidden(true/false)` 直接驱动（隐藏窗口这件事在无头浏览器里
 *    没法真做，但"隐藏之后该发生什么"完全可以断言）。
 */

export type ShellVisibilityListener = (hidden: boolean) => void

let hidden = false
const listeners = new Set<ShellVisibilityListener>()

export function isShellHidden(): boolean {
  return hidden
}

/** 幂等：同值重复设置不会通知订阅者（避免恢复时被多次"立刻刷一轮"打爆） */
export function setShellHidden(next: boolean): void {
  if (next === hidden) return
  hidden = next
  for (const fn of [...listeners]) {
    try {
      fn(hidden)
    } catch {
      /* 单个订阅者抛错不影响别人（顶栏挂了也不能带倒侧栏） */
    }
  }
}

export function onShellVisibilityChange(fn: ShellVisibilityListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 测试用：清空订阅者与状态（运行时不该调） */
export function resetShellLifecycle(): void {
  listeners.clear()
  hidden = false
}

/** Tauri 事件名（Rust 侧 `emit` 的常量；两边必须一致） */
export const SHELL_HIDDEN_EVENT = 'shell:hidden'
export const SHELL_SHOWN_EVENT = 'shell:shown'

interface UnlistenLike { (): void }

/**
 * 接上真实事件源。返回注销函数（含 dev 钩子的清理）。
 *
 * 桌面端：`@tauri-apps/api/event` 的 listen（动态 import：浏览器/探针环境没有该模块也能跑）。
 * 浏览器：`document.visibilitychange` 兜底（dev 里切标签页也会停表，行为一致）。
 */
export function installShellLifecycle(): () => void {
  let disposed = false
  const offs: UnlistenLike[] = []

  // dev 钩子：探针用它驱动"隐藏/恢复"（无头浏览器里没有托盘，也没有真窗口）
  const w = globalThis as unknown as {
    __ddtoolkitSetShellHidden?: (v: boolean) => void
    __ddtoolkitShellHidden?: () => boolean
  }
  w.__ddtoolkitSetShellHidden = (v: boolean) => setShellHidden(!!v)
  w.__ddtoolkitShellHidden = () => hidden

  const onDocVisibility = () => setShellHidden(!!globalThis.document?.hidden)
  try {
    globalThis.document?.addEventListener('visibilitychange', onDocVisibility)
  } catch {
    /* 无 document（node 测试环境）：跳过 */
  }

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const a = await listen(SHELL_HIDDEN_EVENT, () => setShellHidden(true))
      const b = await listen(SHELL_SHOWN_EVENT, () => setShellHidden(false))
      if (disposed) {           // 安装过程中就被卸载：立刻解绑，别留下监听
        a()
        b()
        return
      }
      offs.push(a, b)
    } catch {
      /* 非 Tauri 环境（浏览器/探针）：靠 visibilitychange 与 dev 钩子 */
    }
  })()

  return () => {
    disposed = true
    for (const off of offs) {
      try { off() } catch { /* 忽略 */ }
    }
    offs.length = 0
    try {
      globalThis.document?.removeEventListener('visibilitychange', onDocVisibility)
    } catch { /* 忽略 */ }
    delete w.__ddtoolkitSetShellHidden
    delete w.__ddtoolkitShellHidden
  }
}
