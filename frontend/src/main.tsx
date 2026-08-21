import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp, Button, ConfigProvider, Result, Spin } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { BrowserRouter } from 'react-router-dom'
import 'antd/dist/reset.css'
import './styles/tokens.css'
import App from './App'
import { setApiBase } from './api/api'

const isTauri = '__TAURI_INTERNALS__' in window

const theme = {
  token: {
    colorPrimary: '#fb77a1',
    borderRadius: 8,
    fontFamily:
      "'Alimama FangYuanTi VF', system-ui, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
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

type BootState = 'ready' | 'pending' | 'failed'

function Root() {
  const [state, setState] = useState<BootState>(isTauri ? 'pending' : 'ready')

  useEffect(() => {
    if (!isTauri) return
    tauriBootstrap().then((ok) => setState(ok ? 'ready' : 'failed'))
  }, [])

  if (state === 'pending') {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
        <div style={{ color: '#647489' }}>后端服务启动中，首次运行可能需要几秒…</div>
      </div>
    )
  }

  if (state === 'failed') {
    return (
      <Result
        status="error"
        title="后端启动失败"
        subTitle="内置后端服务未能在时限内就绪。请关闭应用后重新打开；若反复失败，可删除数据目录后重试。"
        extra={
          <Button type="primary" onClick={() => window.location.reload()}>
            重试
          </Button>
        }
      />
    )
  }

  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntApp>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
