import React from 'react'
import ReactDOM from 'react-dom/client'

import StatusWidgetWindow from './components/StatusWidgetWindow'
import { holdApiUntilReady, markNoTokenRequired, setApiBase, setApiToken } from './api/api'
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

/**
 * ⚠️ **桌面端引导：注入后端端口**（2026-09-25 批 5g 加，用户反馈"日志里还是报错"）。
 *
 * `api.ts` 的默认 base 是 **`/api`**（相对路径）—— 在**主窗口**里它由 Vite 代理转发，
 * 而**桌面端根本没跑 Vite 代理**，所以 `main.tsx` 会调 `get_backend_port` 拿到 sidecar
 * 的真实端口，再 `setApiBase('http://127.0.0.1:<port>')`。
 *
 * **小窗是独立入口，不经过 `main.tsx`** ⇒ 这条注入从来没跑过 ⇒ `apiBase` 一直是 `/api`
 * ⇒ 每次 `api.getPrefs()`（穿透/全屏隐藏那两条轮询，**每 2 秒一次**）都打到
 * `http://127.0.0.1:8000` —— 那是**开发态 Vite 代理的目标端口**，桌面端没有服务在听
 * ⇒ `ECONNREFUSED`，日志里刷出一片 `http proxy error: /settings/prefs`（实测 ×48）。
 *
 * ⚠️ **这正是 `DEV-LOOP.md` §6.1 那条纪律的第三次现身**（"拆入口时顺带生效的东西最容易漏"）：
 * 前两次是 Tailwind preflight 的 `box-sizing`、`layout.css` 里的 `.os-*` 样式；
 * 这次是 **`main.tsx` 里的启动副作用** —— 它同样"不在 import 图里"，
 * 而且**失败得很安静**（面板照样显示，只是每 2 秒发一个必然失败的请求）。
 *
 * 与主窗口的区别：这里**不轮询 `/healthz`**（小窗是纯显示，不负责等后端就绪），
 * 拿到端口就设上；失败就保持 `/api`（探针/浏览器环境本来就走 Vite 代理，那是对的）。
 */
async function injectBackendPort(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const port = await invoke<number>('get_backend_port')
    // S1（devlog/202）：小窗**也要 token** —— 它照样发业务请求（读偏好、读状态）。
    // 端口与令牌一起注入；拿不到令牌就让闸门保持关着（请求挂住而不是打 401 风暴）。
    const token = await invoke<string>('get_api_token')
    if (typeof port === 'number' && port > 0) {
      setApiBase(`http://127.0.0.1:${port}`)
      setApiToken(token)
      logToShell(`已注入后端端口 ${port}`)
    }
  } catch {
    // 非桌面端（探针/浏览器）：没有 sidecar，`/api` 走 Vite 代理即可，**这是对的**。
    // ⚠️ 但闸门必须开 —— 见下面 `render()` 的说明。
    markNoTokenRequired()
  }
}

logToShell(`widgetMain 模块执行 q=${location.search}`)
window.addEventListener('error', (e) => {
  logToShell(`window.onerror ${e.message} @ ${(e.filename || '').split('/').slice(-1)[0]}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  logToShell(`unhandledrejection ${String((e as PromiseRejectionEvent).reason)}`)
})

// ⚠️ **先关闸、再注入、最后渲染**（批 5g + S1，devlog/202）。
//
// 批 5g 的教训：小窗一挂载就会去读偏好（穿透 / 全屏隐藏那两条），而读偏好要用 `apiBase`
// —— 注入晚一步，那两次请求就会打到 `/api`（ECONNREFUSED）。所以这里 `await` 一次
// （拿端口/令牌都是本进程 IPC，亚毫秒级，不会拖慢首绘）。
//
// S1 追加：**闸门要在最早期关上**。`injectBackendPort()` 现在多一次 `invoke`（取令牌），
// 而 `.finally()` 之后的渲染与"挂载即发请求"的组件之间没有别的屏障 ——
// 关闸之后它们在注入完成前挂住，而不是打出 401。
//
// ⚠️ 这是 `DEV-LOOP.md` §6.1 那条纪律的**第四次**现身（"拆入口时顺带生效的东西最容易漏"）：
//    前三次是 Tailwind preflight、`layout.css` 的 `.os-*`、`main.tsx` 的 `setApiBase` 副作用。
//    **新入口必须自己走一遍启动副作用的清单**，别指望它"跟着一起生效"。
holdApiUntilReady()
void injectBackendPort().finally(() => {
  // 兜底：无论注入成功与否都要开闸 —— 注入失败（非桌面端）时 `markNoTokenRequired()`
  // 已在 catch 里调过；这里再兜一次，保证**绝不把请求挂死**（那个症状没有报错、最难查）。
  if (!('__TAURI_INTERNALS__' in window)) markNoTokenRequired()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <WidgetErrorBoundary>
        <StatusWidgetWindow />
      </WidgetErrorBoundary>
    </React.StrictMode>,
  )
})

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
