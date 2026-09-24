import './bootDiag' // 首个 import：诊断陷阱先于一切业务代码注册（CSP 放行同源脚本）
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { RotateCcw } from 'lucide-react'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import './index.css'
import './styles/tokens.css'
import App from './App'
import StatusWidgetWindow from './components/StatusWidgetWindow'
import Logo from './components/common/Logo'
import { setApiBase } from './api/api'
import { markFirstRun } from './bootState'
import { installShellLifecycle } from './utils/shellLifecycle'
import { applyCornersMode } from './utils/windowCorners'

const isTauri = '__TAURI_INTERNALS__' in window

// 冷启动计时（方案 0 埋点）：与后端 sidecar.log / Rust stdout 的 [perf] 行对照
const _t0 = performance.now()
const perfLog = (step: string) =>
  window.__bootLog?.(`[perf] ${step} +${Math.round(performance.now() - _t0)}ms`)

// 窗口以 visible:false 创建（见 tauri.conf.json）：此刻 index.html 静态粉幕已随
// DOM 解析绘制完成（module script 天然 defer），invoke 显示窗口后首帧即粉色，
// 彻底规避 WebView2 首绘前的白屏（白色闪屏修复，见 devlog/021）。
if (isTauri) {
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('present_window'))
    .catch((err) => window.__bootLog?.('[present_window] ' + String(err)))
}
perfLog('模块求值完成')

/** 桌面端引导：取 sidecar 端口 → 轮询 /healthz 就绪 → 注入 API 地址 */
async function tauriBootstrap(): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core')
  const port = await invoke<number>('get_backend_port')
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${base}/healthz`, { cache: 'no-store' })
      if (r.ok) {
        setApiBase(base)
        // 首次启动标记（后端只在第一次探活时给 true）→ TopBar 自动弹登录浮窗
        try {
          const boot = (await r.json()) as { first_run?: boolean }
          if (boot?.first_run) markFirstRun()
        } catch {
          /* 响应非 JSON：忽略，不影响启动 */
        }
        return true
      }
    } catch {
      /* 后端尚未就绪，继续等待 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

type BootState = 'pending' | 'opening' | 'done' | 'failed'

const ENVELOPE_MS = 750 // 信封展开动画时长（与 layout.css keyframes 对应）

/**
 * 启动幕：主色铺满全窗，中央 LOGO；就绪后「信封上下展开」揭出应用。
 * - pending: 两片闭合，LOGO 呼吸
 * - opening: 上片上滑、下片下滑，LOGO 淡出，露出下方已挂载的 App
 * - failed : 保持闭合，中央换错误卡片 + 重试
 */
function Splash({
  state,
  waited,
  onRetry,
}: {
  state: Exclude<BootState, 'done'>
  waited: number
  onRetry: () => void
}) {
  const opening = state === 'opening'
  return (
    <div className={`splash${opening ? ' splash-open' : ''}`}>
      <div className="splash-panel splash-panel-top" />
      <div className="splash-panel splash-panel-bottom" />
      <div className="splash-center">
        {state === 'failed' ? (
          <>
            <Logo className="splash-logo splash-logo-static" />
            <div className="mt-5 text-lg font-semibold text-white">后端启动失败</div>
            <p className="mt-2 max-w-md text-center text-sm text-white/80">
              内置后端服务未能在时限内就绪。请关闭应用后重新打开。
              若反复失败，请查看数据目录下的 <code>logs/sidecar.log</code>（含完整堆栈）。
            </p>
            <p className="mt-2 max-w-md text-center text-xs text-white/60">
              请勿删除数据目录 —— 那会连同已归档的证据一起删掉。
            </p>
            <Button variant="secondary" className="mt-4" onClick={onRetry}>
              <RotateCcw /> 重试
            </Button>
          </>
        ) : (
          <>
            <Logo className={`splash-logo ${state === 'pending' ? 'splash-logo-pulse' : ''}`} />
            {/* 冷启动可能十几秒（首次建库迁移 / 杀软首扫）：给出秒数，
                让「等待」和「卡死」可区分（2026-09-08 首启卡幕反馈） */}
            {state === 'pending' && waited >= 3 && (
              <p className="mt-5 text-sm text-white/70">正在启动内置服务… {waited}s</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Main() {
  return (
    <TooltipProvider delayDuration={200}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </BrowserRouter>
      <Toaster position="top-center" richColors />
    </TooltipProvider>
  )
}

function Root() {
  const [state, setState] = useState<BootState>(isTauri ? 'pending' : 'done')

  // 启动计时：React 挂载
  useEffect(() => {
    perfLog('React 挂载完成')
  }, [])

  // React Splash 已在首帧接管视觉（与 index.html 静态启动幕像素级一致），
  // 移除静态节点；诊断面板折叠为徽章待查（不再整版弹出）
  useEffect(() => {
    document.getElementById('boot-splash')?.remove()
    window.__bootFold?.()
  }, [])

  // 外壳可见性（R18，devlog/095）：接上 Tauri 的 `shell:hidden` / `shell:shown`
  // （浏览器/探针退化为 visibilitychange + dev 钩子）。必须在最外层装一次 ——
  // 顶栏轮询与状态岛轮播都靠它停表。
  useEffect(() => installShellLifecycle(), [])

  useEffect(() => {
    if (!isTauri) return
    perfLog('tauriBootstrap 开始')
    tauriBootstrap()
      .then((ok) => {
        perfLog(ok ? 'healthz OK → opening' : 'healthz 超时 → failed')
        setState(ok ? 'opening' : 'failed')
      })
      .catch((err) => {
        // invoke（取 sidecar 端口）失败也必须落地到 failed——否则幕布永远停在
        // 呼吸态、既无错误也无重试入口（2026-09-08 直装版首启卡幕反馈的兜底）
        window.__bootLog?.('[bootstrap] ' + String(err))
        setState('failed')
      })
  }, [])

  // 首启等待计时：让「正在启动」和「卡死」可区分
  const [waited, setWaited] = useState(0)
  useEffect(() => {
    if (!isTauri || state !== 'pending') return
    const timer = window.setInterval(() => setWaited((s) => s + 1), 1000)
    return () => window.clearInterval(timer)
  }, [state])

  // 揭幕开始：html 首绘底色切回透明，恢复 L3 圆角透出桌面
  // 揭幕完成（done）：再给 `<html>` 挂 `shell-settled` —— 壳层那层近白兜底可以撤了。
  // 为什么必须等这一刻（devlog/135 补）：撤早了会闪桌面 —— 实测揭幕期间
  // 各区域还在跑 `rise-in-page` 渐显（最晚 0.45s 延迟 + 0.32s 时长），那时窗口中心是**透的**；
  // 而撤晚了四角就一直是"区域色压在近白底上"的白边。`done` = 幕收完、壳已完全画出。
  useEffect(() => {
    if (state === 'opening' || state === 'done') {
      document.documentElement.style.background = 'transparent'
    }
    if (state === 'done') {
      document.documentElement.classList.add('shell-settled')
    }
  }, [state])

  // 圆角归谁画（R34，devlog/136）：问壳"这扇窗口的圆角是系统（DWM）画的吗" ——
  // Win11 ⇒ true：CSS 半径归零（`html.dwm-corners`），圆角/吸附方角全交给系统；
  // Win10 探测失败 ⇒ false：保留 CSS 半径兜底（8px），不会变成裸方角。
  // 浏览器/探针里没有 Tauri ⇒ 保持 false（= 走 CSS 那条路，正好也能被探针断言到）。
  // dev 钩子 `__ddtoolkitCorners` 让探针能模拟壳的答复（与 `__ddtoolkitShellHidden` 同路数）。
  useEffect(() => {
    const devHook = window as unknown as { __ddtoolkitCorners?: (v: boolean) => void }
    devHook.__ddtoolkitCorners = applyCornersMode
    if (!isTauri) return
    let disposed = false
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<boolean>('window_corners_mode'))
      .then((ok) => {
        if (!disposed) applyCornersMode(ok)
      })
      .catch(() => { /* 问不到就按 CSS 圆角走，不打扰任何人 */ })
    return () => { disposed = true }
  }, [])

  // 信封展开动画播完后卸载启动幕，同时折叠诊断面板
  useEffect(() => {
    if (state !== 'opening') return
    window.__bootFold?.()
    const timer = window.setTimeout(() => {
      perfLog('揭幕完成（应用壳可见）')
      setState('done')
    }, ENVELOPE_MS)
    return () => clearTimeout(timer)
  }, [state])

  return (
    <>
      {/* opening 阶段即挂载 App 在幕布之下，动画结束时无缝接管 */}
      {state !== 'pending' && state !== 'failed' && <Main />}
      {state !== 'done' && (
        <Splash state={state} waited={waited} onRetry={() => window.location.reload()} />
      )}
    </>
  )
}

/**
 * 桌面状态控件小窗（R38 批 5b）：Rust 用 `index.html?widget=1` 开这扇窗。
 *
 * **必须在 `Root` 之前分流** —— 小窗里不该跑主窗口那套启动链路（后端探活、揭幕幕布、
 * 路由、首启浮窗、探针……）。它只要一个胶囊。
 */
const isWidgetWindow = new URLSearchParams(window.location.search).has('widget')

// ⚠️ **小窗必须自己摘掉 `index.html` 里那层静态启动幕**（2026-09-24 真机反馈的真凶）。
//
// 那层幕是 `#boot-splash`：`position:fixed; inset:0; z-index:150` + **不透明粉底**
// （`background:#ffa2b4`）。它存在的理由是"HTML 解析即绘制，消除启动白闪"，
// 而**唯一**摘掉它的地方是 `Root` 的 effect（下面那个 `document.getElementById('boot-splash')`）
// —— 小窗跑的是 `StatusWidgetWindow`，**根本不走 `Root`** ⇒ 幕永远摘不掉，
// 把 200×40 的胶囊整个盖住。用户看到的就是"一块粉底、看不到胶囊"。
//
// 为什么放在**这里**（模块作用域）而不是 `StatusWidgetWindow` 的 effect 里：
// 这是**静态 HTML 节点**，不等 React。早一帧摘掉就少一帧"先粉后黑"的闪。
// 主窗口那条路径**不受影响** —— React 版 `<Splash>` 在 `Root` 首帧就位、像素级一致，
// 所以这里只摘小窗的（主窗口仍然等 `Root` 挂载后再摘，保持原来的无白闪修复）。
if (isWidgetWindow) {
  document.getElementById('boot-splash')?.remove()
  document.documentElement.dataset.widgetWindow = '1'

  // ⚠️ **小窗的兜底错误显示**（2026-09-24 第三轮真机反馈加）。
  //
  // 小窗是 200×40 + 置顶 + 无边框，**没法开 devtools、看不到 console** ——
  // 一旦渲染抛错，用户只会看到"一块空白"，而排查手段为零（前两轮我就是在盲猜）。
  // 这里把错误**画在窗口里**：至少"有没有抛错、抛在哪个文件哪一行"不用再猜。
  window.addEventListener('error', (e) => {
    const el = document.createElement('pre')
    el.id = 'widget-error'
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;margin:0;padding:2px 4px;background:#3a0000;' +
      'color:#ffd9d9;font:9px/1.2 ui-monospace,monospace;white-space:pre-wrap;overflow:hidden'
    el.textContent =
      `[widget error] ${e.message}\n${(e.filename || '').split('/').slice(-1)[0]}:${e.lineno}`
    document.body.appendChild(el)
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isWidgetWindow ? <StatusWidgetWindow /> : <Root />}
  </React.StrictMode>,
)

// 开发态 UI 探针（?probe=1）：布局回归的机器可验证入口，见 src/dev/probe.ts
// 与 scripts/ui_probe.py。生产构建里 import.meta.env.DEV 为 false → 整段被摇掉。
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('probe')) {
  void import('./dev/probe').then((m) => m.runUiProbe())
}

// 开发态强制首启标记（?firstRun=1）：用来在浏览器里验证「首启自动弹登录浮窗」，
// 免得为了看一次弹窗去清数据目录。
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('firstRun')) {
  markFirstRun()
}
