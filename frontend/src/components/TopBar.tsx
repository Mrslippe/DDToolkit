import { useEffect, useRef, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import spinnerSvg from '../assets/icons/Frame_41_8.svg'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '../api/api'
import type { FetchStatus } from '../api/types'
import './../styles/layout.css'

const POLL_ACTIVE_MS = 3000 // 有任务运行时的高频轮询
const POLL_IDLE_MS = 10000 // 空闲时的低频轮询
const PILL_MS = 4000 // 操作结果覆盖态的展示时长

const isTauri = '__TAURI_INTERNALS__' in window

async function tauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/**
 * 顶栏（视觉严格按 docs/react Pixso 设计稿 Frame411）：
 * 千图小兔体 LOGO + 字小魂锐艺黑标题 + 居中状态文字 + 通栏窗口控制钮。
 * - 状态来自 GET /vtuber/fetch-status 轮询；抓取中显示设计稿加载图标；
 *   任务结束沿触发 'ddtoolkit:fetch-idle' 事件，供 VtuberSidebar 等组件刷新数据。
 * - 账号快照增量派发 'ddtoolkit:account-progress'，侧栏就地合并零请求刷新。
 * - 桌面端：头部为拖拽区，最小化/关闭接原生窗口；有任务运行时关闭需二次确认。
 */
export default function TopBar() {
  const [status, setStatus] = useState<FetchStatus | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [pillMsg, setPillMsg] = useState<string | null>(null)
  const prevRunning = useRef(false)
  const seenRecent = useRef(0)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      let active = false
      try {
        const s = await api.getFetchStatus()
        if (cancelled) return
        active = s.account.running || s.post.running

        // 账号快照增量 → 派发事件，侧栏就地刷新（每完成一条触发一次）
        const recent = s.account.recent ?? []
        if (recent.length > seenRecent.current) {
          const fresh = recent.slice(seenRecent.current)
          seenRecent.current = recent.length
          window.dispatchEvent(
            new CustomEvent('ddtoolkit:account-progress', { detail: fresh }),
          )
        } else if (recent.length < seenRecent.current) {
          seenRecent.current = recent.length // 新一轮任务，基线重置
        }

        // 新任务启动时立即让位给实时状态显示
        if (active) setPillMsg(null)

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

    pollRef.current = poll
    poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  // 操作按钮点击/完成时「踢一脚」：状态即时反映任务启动与结束，
  // 不必等下一轮轮询
  const pollRef = useRef<() => void>(() => {})
  useEffect(() => {
    const kick = () => pollRef.current?.()
    window.addEventListener('ddtoolkit:kick-poll', kick)
    return () => window.removeEventListener('ddtoolkit:kick-poll', kick)
  }, [])

  // 成功类操作提示覆盖态：优先于常规状态文案，PILL_MS 后自动还原；
  // 新任务启动时由轮询立即清除让位
  const pillTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const onPill = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (!text) return
      setPillMsg(text)
      if (pillTimer.current !== undefined) clearTimeout(pillTimer.current)
      pillTimer.current = window.setTimeout(() => setPillMsg(null), PILL_MS)
    }
    window.addEventListener('ddtoolkit:pill-message', onPill)
    return () => window.removeEventListener('ddtoolkit:pill-message', onPill)
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

  // 显示优先级：覆盖消息（且无任务运行）> 实时状态
  const showOverride = pillMsg !== null && !busy
  const displayText = showOverride ? pillMsg! : statusText
  const displayDot = showOverride ? 'topbar-status-dot ok' : dotClass

  const handleMinimize = () => void tauriWindow().then((w) => w.minimize())

  const closeApp = () => void tauriWindow().then((w) => w.close())
  const handleClose = () => (busy ? setConfirmClose(true) : closeApp())

  // 最大化状态跟踪：onResized 触发时重查 isMaximized，切换 还原/最大化 图标
  const [isMax, setIsMax] = useState(false)
  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const update = () => {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        if (disposed) return
        void getCurrentWindow()
          .isMaximized()
          .then(setIsMax)
      })
    }
    update()
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (disposed) return
      void getCurrentWindow()
        .onResized(update)
        .then((u) => {
          unlisten = u
        })
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const handleToggleMaximize = () =>
    void tauriWindow().then((w) => w.toggleMaximize())

  return (
    <header className="topbar" {...(isTauri ? { 'data-tauri-drag-region': true } : {})}>
      <div className="topbar-logo-zone">
        <div className="topbar-logo">D</div>
      </div>
      <h1 className="topbar-title">DDtoolkit</h1>

      <span className="topbar-status">
        {displayDot.includes('busy') ? (
          <img src={spinnerSvg} alt="" className="topbar-status-spinner" />
        ) : (
          <i className={displayDot} />
        )}
        <span key={displayText} className="pill-text-fade">
          {displayText}
        </span>
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
          <Minus className="size-[30px]" />
        </button>
        <button
          className="topbar-win-btn"
          disabled={!isTauri}
          title={isMax ? '还原' : '最大化'}
          onClick={handleToggleMaximize}
        >
          {isMax ? <Copy className="size-5" /> : <Square className="size-5" />}
        </button>
        <button
          className="topbar-win-btn close"
          disabled={!isTauri}
          title={isTauri ? '关闭' : '关闭（桌面端可用）'}
          onClick={handleClose}
        >
          <X className="size-[30px]" />
        </button>
      </div>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>抓取任务正在进行中</AlertDialogTitle>
            <AlertDialogDescription>
              关闭窗口会中断后台抓取进程，确定退出吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={closeApp}
            >
              退出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  )
}
