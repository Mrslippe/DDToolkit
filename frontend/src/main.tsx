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
import { setApiBase } from './api/api'

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
          <>
            <div className={`splash-logo ${state === 'pending' ? 'splash-logo-pulse' : ''}`}>D</div>
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
  useEffect(() => {
    if (state === 'opening' || state === 'done') {
      document.documentElement.style.background = 'transparent'
    }
  }, [state])

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
