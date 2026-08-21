import { useEffect, useRef, useState } from 'react'
import { api } from '../api/api'
import type { FetchStatus } from '../api/types'
import './../styles/layout.css'

const POLL_ACTIVE_MS = 3000 // 有任务运行时的高频轮询
const POLL_IDLE_MS = 15000 // 空闲时的低频轮询

/**
 * 顶栏：LOGO 占位 + 标题 + 实时抓取状态 + 装饰性窗口控制按钮。
 * 状态来自 GET /vtuber/fetch-status 轮询；任务结束沿触发
 * 'ddtoolkit:fetch-idle' 事件，供 VtuberSidebar 等组件刷新数据。
 */
export default function TopBar() {
  const [status, setStatus] = useState<FetchStatus | null>(null)
  const prevRunning = useRef(false)

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

  return (
    <header className="topbar">
      {/* TODO(独立窗体阶段): LOGO 区域后续替换为图片 <img src="/logo.png" alt="logo" /> */}
      <div className="topbar-logo">D</div>
      <h1 className="topbar-title">DDtoolkit</h1>

      <span className="topbar-status">
        <i className={dotClass} />
        {statusText}
      </span>

      <div className="topbar-spacer" />

      {/* 独立窗体（Tauri/Electron）打包后接线：最小化/刷新/关闭 */}
      <div className="topbar-window-controls">
        <button className="topbar-win-btn" disabled title="最小化（桌面端可用）">
          —
        </button>
        <button
          className="topbar-win-btn"
          title="刷新"
          onClick={() => window.location.reload()}
        >
          ⟳
        </button>
        <button className="topbar-win-btn" disabled title="关闭（桌面端可用）">
          ✕
        </button>
      </div>
    </header>
  )
}
