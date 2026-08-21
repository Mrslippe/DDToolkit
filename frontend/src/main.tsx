import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Loader2, RotateCcw } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import './index.css'
import './styles/tokens.css'
import App from './App'
import { setApiBase } from './api/api'

const isTauri = '__TAURI_INTERNALS__' in window

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

type BootState = 'ready' | 'pending' | 'failed'

function BootScreen({ state }: { state: Exclude<BootState, 'ready'> }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 text-muted-foreground">
      {state === 'pending' ? (
        <>
          <Loader2 className="size-8 animate-spin text-primary" />
          <div>后端服务启动中，首次运行可能需要几秒…</div>
        </>
      ) : (
        <>
          <div className="text-lg font-semibold text-foreground">后端启动失败</div>
          <div className="max-w-md text-center text-sm">
            内置后端服务未能在时限内就绪。请关闭应用后重新打开；若反复失败，可删除数据目录后重试。
          </div>
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RotateCcw /> 重试
          </Button>
        </>
      )}
    </div>
  )
}

function Root() {
  const [state, setState] = useState<BootState>(isTauri ? 'pending' : 'ready')

  useEffect(() => {
    if (!isTauri) return
    tauriBootstrap().then((ok) => setState(ok ? 'ready' : 'failed'))
  }, [])

  if (state !== 'ready') return <BootScreen state={state} />

  return (
    <TooltipProvider delayDuration={200}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </BrowserRouter>
      <Toaster position="top-center" richColors />
    </TooltipProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
