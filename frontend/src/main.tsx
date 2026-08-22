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
import { setApiBase } from './api/api'

const isTauri = '__TAURI_INTERNALS__' in window

// 窗口以 visible:false 创建：模块一加载立即显示。此刻 index.html 静态幕已随
// DOM 解析绘制完成（module script 天然 defer），用户见到的首帧必为粉色。
// 走应用自有命令 present_window——不受 capability 权限约束（此前
// getCurrentWindow().show() 因缺 allow-show 权限被静默拒绝，正是动画不可见的根因）。
// api/core 的动态导入与 tauriBootstrap 同源，实践中稳定可用；仍留诊断留痕
if (isTauri) {
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('present_window'))
    .catch((err) => window.__bootLog?.('[show] ' + String(err)))
}

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
function Splash({ state, onRetry }: { state: Exclude<BootState, 'done'>; onRetry: () => void }) {
  const opening = state === 'opening'
  return (
    <div className={`splash${opening ? ' splash-open' : ''}`}>
      <div className="splash-panel splash-panel-top" />
      <div className="splash-panel splash-panel-bottom" />
      <div className="splash-center">
        {state === 'failed' ? (
          <>
            <div className="splash-logo splash-logo-static">D</div>
            <div className="mt-5 text-lg font-semibold text-white">后端启动失败</div>
            <p className="mt-2 max-w-md text-center text-sm text-white/80">
              内置后端服务未能在时限内就绪。请关闭应用后重新打开；
              若反复失败，可删除数据目录后重试。
            </p>
            <Button variant="secondary" className="mt-4" onClick={onRetry}>
              <RotateCcw /> 重试
            </Button>
          </>
        ) : (
          <div className={`splash-logo ${state === 'pending' ? 'splash-logo-pulse' : ''}`}>D</div>
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

  // React Splash 已在首帧接管视觉（与 index.html 静态启动幕像素级一致），
  // 移除静态节点；诊断面板折叠为徽章待查（不再整版弹出）
  useEffect(() => {
    document.getElementById('boot-splash')?.remove()
    window.__bootFold?.()
  }, [])

  useEffect(() => {
    if (!isTauri) return
    tauriBootstrap().then((ok) => setState(ok ? 'opening' : 'failed'))
  }, [])

  // 揭幕开始：html 首绘底色切回透明，恢复 L3 圆角透出桌面
  useEffect(() => {
    if (state === 'opening' || state === 'done') {
      document.documentElement.style.background = 'transparent'
    }
  }, [state])

  // 信封展开动画播完后卸载启动幕，同时折叠诊断面板
  useEffect(() => {
    if (state !== 'opening') return
    window.__bootFold?.()
    const timer = window.setTimeout(() => setState('done'), ENVELOPE_MS)
    return () => clearTimeout(timer)
  }, [state])

  return (
    <React.StrictMode>
      {/* opening 阶段即挂载 App 在幕布之下，动画结束时无缝接管 */}
      {state !== 'pending' && state !== 'failed' && <Main />}
      {state !== 'done' && (
        <Splash state={state} onRetry={() => window.location.reload()} />
      )}
    </React.StrictMode>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
