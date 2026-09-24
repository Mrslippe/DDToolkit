import React from 'react'
import ReactDOM from 'react-dom/client'

import StatusWidgetWindow from './components/StatusWidgetWindow'
import './styles/tokens.css'
import './styles/status-island.css'

/**
 * 桌面状态控件小窗的**独立入口**（R38 批 5b，2026-09-24）。
 *
 * ## 为什么单独一个入口
 *
 * 原来是 `index.html?widget=1` —— `main.tsx` 里 `if (isWidgetWindow)` 分流。
 * 但**静态 import 拦不住**：`main.tsx` 顶部那些 `import App from './App'` /
 * `react-router` / `sonner` / `tooltip` / `button` 会被**无条件**打进小窗那个 renderer。
 * 实测小窗 renderer 占 **132MB**，而 Chromium 的基础开销只占小部分，大头是我们的代码与依赖。
 *
 * 独立入口后：**加载量 = 下面这几行**。物理上不可能再被主窗口的代码影响，
 * 「靠运行时判断」那种分流也就不需要了。
 *
 * ## 只加载两份 CSS
 *
 * - `tokens.css`：`--motion-*` / `--c-*` 等令牌（状态岛的过渡与动效全靠它）
 * - `status-island.css`：胶囊 + 面板（**从 `layout.css` 抽出来的那一份**）
 *
 * ⚠️ **不要**在这里 import `layout.css` / `index.css` —— 那正是这个入口要避免的东西。
 * 小窗需要新的视觉时，加进 `status-island.css`（两个宿主共用那一份）。
 */

/**
 * 渲染错误边界。
 *
 * 小窗 200×40 + 置顶 + 无边框：**开不了 devtools、看不到 console** ——
 * 一旦渲染抛错，用户只看到"一块空白"，排查手段为零（这个坑 2026-09-24 踩过一整轮）。
 * 所以错误要**画在窗口里**，同时通过 `widget_diag` 写进 `shell.log`。
 */
class WidgetErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { err: string | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { err: null }
  }

  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }

  componentDidCatch(e: unknown, info: React.ErrorInfo) {
    const detail = [
      `React 渲染抛错：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      `  componentStack: ${(info.componentStack || '').split('\n').slice(0, 6).join(' | ')}`,
      e instanceof Error && e.stack ? `  stack: ${e.stack.split('\n').slice(0, 6).join(' | ')}` : '',
    ].filter(Boolean).join('\n')
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('widget_diag', { info: detail })
      } catch {
        console.error('[widget]', detail)
      }
    })()
  }

  render() {
    if (this.state.err) {
      return (
        <pre
          style={{
            position: 'fixed', inset: 0, margin: 0, padding: '2px 4px',
            background: '#3a0000', color: '#ffd9d9', overflow: 'hidden',
            font: '9px/1.2 ui-monospace, monospace', whiteSpace: 'pre-wrap',
          }}
        >
          {`[渲染失败]\n${this.state.err}`}
        </pre>
      )
    }
    return this.props.children
  }
}

/**
 * 把异常写进 `shell.log`（用户能整份发过来）。
 *
 * ⚠️ `window.onerror` **抓不到 React 渲染阶段的异常**（React 自己捕获后走 boundary 链路），
 * 所以它和上面的 ErrorBoundary **都要有**：前者管"模块级/异步"错误，后者管"渲染"错误。
 */
const logToShell = (msg: string) => {
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('widget_diag', { info: msg })
    } catch {
      console.error('[widget]', msg)
    }
  })()
}
;(window as unknown as { __widgetLog?: (m: string) => void }).__widgetLog = logToShell

logToShell(`widgetMain 模块执行 q=${location.search}`)
window.addEventListener('error', (e) => {
  logToShell(`window.onerror ${e.message} @ ${(e.filename || '').split('/').slice(-1)[0]}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  logToShell(`unhandledrejection ${String((e as PromiseRejectionEvent).reason)}`)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WidgetErrorBoundary>
      <StatusWidgetWindow />
    </WidgetErrorBoundary>
  </React.StrictMode>,
)

// 开发态 UI 探针（`widget.html?probe=status-widget-window`）。
//
// ⚠️ **独立入口必须自己挂探针**（2026-09-24 踩到）：`main.tsx` 里那段
// `if (DEV && has('probe')) import('./dev/probe')` **只对 index.html 生效** ——
// 换了入口之后探针就不会跑了，而症状是"未拿到探针输出 / 页面未跑完"，
// 看起来像渲染失败，其实是**根本没加载探针代码**。
// 生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉。
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('probe')) {
  void import('./dev/probe').then((m) => m.runUiProbe())
}
