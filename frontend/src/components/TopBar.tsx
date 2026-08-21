import { useEffect, useRef, useState } from 'react'
import { App as AntApp } from 'antd'
import { api } from '../api/api'
import type { FetchStatus } from '../api/types'
import './../styles/layout.css'

const POLL_ACTIVE_MS = 3000 // 有任务运行时的高频轮询
const POLL_IDLE_MS = 15000 // 空闲时的低频轮询

const isTauri = '__TAURI_INTERNALS__' in window

async function tauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/**
 * 顶栏：LOGO 占位 + 标题 + 实时抓取状态 + 窗口控制按钮。
 * - 状态来自 GET /vtuber/fetch-status 轮询；任务结束沿触发
 *   'ddtoolkit:fetch-idle' 事件，供 VtuberSidebar 等组件刷新数据。
 * - 桌面端（Tauri）：头部为拖拽区，最小化/关闭接原生窗口；
 *   有抓取任务运行时关闭需二次确认。
 */
export default function TopBar() {
  const [status, setStatus] = useState<FetchStatus | null>(null)
  const prevRunning = useRef(false)
  const { modal } = AntApp.useApp()

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      let active = false
      try {
        const s = await api.getFetchStatus()
        if (cancelled) return
        active = s.account.running || s.post.running
        setStatus((prev) => {
          const wasRunning = prev ? prev.account.running || prev.post.running : prevRunning.current
          if (wasRunning && !active) {
            window.dispatchEvent(new Event('ddtoolkit:fetch-idle'))
          }
          prevRunning.current = active
          return s
        })
      } catch {
        /* 后端不可达时保持上次状态，按空闲节奏重试 */
      }
      if (!cancelled) {
        timer = window.setTimeout(poll, active ? POLL_ACTIVE_MS : POLL_IDLE_MS)
      }
    }

    poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  const busy = status ? status.account.running || status.post.running : false

  let statusText = '数据服务运行中'
  let dotClass = 'topbar-status-dot'
  if (status?.post.running) {
    statusText = `${status.post.target ?? 'VTuber'} 帖子抓取中`
    dotClass = 'topbar-status-dot busy'
  } else if (status?.account.running) {
    const a = status.account
    const progress = a.total > 0 ? ` ${a.index}/${a.total}` : ''
    statusText = `${a.current ?? '账号'} 信息抓取${progress}`
    dotClass = 'topbar-status-dot busy'
  }

  const handleMinimize = () => void tauriWindow().then((w) => w.minimize())

  const handleClose = () => {
    if (busy) {
      modal.confirm({
        title: '抓取任务正在进行中',
        content: '关闭窗口会中断后台抓取进程，确定退出吗？',
        okText: '退出',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => void tauriWindow().then((w) => w.close()),
      })
    } else {
      void tauriWindow().then((w) => w.close())
    }
  }

  return (
    <header className="topbar" {...(isTauri ? { 'data-tauri-drag-region': true } : {})}>
      {/* TODO(独立窗体阶段): LOGO 区域后续替换为图片 <img src="/logo.png" alt="logo" /> */}
      <div className="topbar-logo">D</div>
      <h1 className="topbar-title">DDtoolkit</h1>

      <span className="topbar-status">
        <i className={dotClass} />
        {statusText}
      </span>

      <div className="topbar-spacer" />

      {/* Web 下仅装饰（禁用）；桌面端接原生窗口控制 */}
      <div className="topbar-window-controls">
        <button
          className="topbar-win-btn"
          disabled={!isTauri}
          title={isTauri ? '最小化' : '最小化（桌面端可用）'}
          onClick={handleMinimize}
        >
          —
        </button>
        <button
          className="topbar-win-btn"
          title="刷新"
          onClick={() => window.location.reload()}
        >
          ⟳
        </button>
        <button
          className="topbar-win-btn"
          disabled={!isTauri}
          title={isTauri ? '关闭' : '关闭（桌面端可用）'}
          onClick={handleClose}
        >
          ✕
        </button>
      </div>
    </header>
  )
}
