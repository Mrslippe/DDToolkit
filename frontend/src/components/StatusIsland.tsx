import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2 } from 'lucide-react'
import OverlayScroll from './OverlayScroll'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import { KIND_PRIORITY, pickPrimary } from '../utils/notificationHub'

interface Props {
  notices: Notice[]
  /** 点面板里的动作（由 TopBar 映射到具体行为） */
  onAction: (kind: NoticeActionKind, n: Notice) => void
  /** 当前时间（每次渲染现取，保证过期判定跟着走） */
  now: number
}

const KIND_ICON: Record<string, React.ReactNode> = {
  alert: <AlertTriangle className="size-[13px]" />,
  progress: <Loader2 className="size-[13px] animate-spin" />,
  report: <CheckCircle2 className="size-[13px]" />,
  message: <CheckCircle2 className="size-[13px]" />,
}

const KIND_LABEL: Record<string, string> = {
  alert: '注意',
  progress: '进行中',
  report: '已完成',
  message: '提示',
}

/**
 * 顶栏「状态岛」（R12a，devlog/089）：把原来三套并存的顶栏信息收成**一个控件**。
 *
 * 四态：`idle`（只有绿点 + 「数据服务运行中」）· `pill`（一条主文案 + 图标）·
 * `expand`（面板：全部条目 + 动作）· 空闲时**没有容器**（用户 2026-09-10：
 * 频繁轮询不必占顶栏 —— 那条规则的判定在 `utils/notificationHub.ts` 里，有反向用例）。
 *
 * ⚠️ DOM 契约（探针 `ui_probe --status-island` 直接查）：
 *   `.si-island`（`.on` = 有事发生）· `.si-dot` · `.si-text` · `.si-count`
 *   `.si-panel` / `.si-item[data-kind]` / `.si-item-action` / `.si-empty`
 * 面板用 **portal + fixed 定位**（顶栏容器 overflow:hidden 会裁掉内联面板）；
 * 位置在打开时按 island 的矩形算一次，滚动/缩放时重算。
 */
export default function StatusIsland({ notices, onAction, now }: Props) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const primary = pickPrimary(notices, now)
  const lit = !!primary

  /** 面板位置：贴在状态岛下方，越界时收进视口 */
  const place = () => {
    const r = anchorRef.current?.getBoundingClientRect()
    if (!r) return
    const width = 340
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8))
    setPos({ left, top: r.bottom + 6, width })
  }

  useEffect(() => {
    if (!open) return
    place()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onResize = () => place()
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 条目清空（例如瞬时消息过期后没有别的事）→ 面板自己收起，别留个空面板
  useEffect(() => {
    if (open && !primary) setOpen(false)
  }, [open, primary])

  const text = primary?.text ?? '数据服务运行中'
  const href = primary?.source ?? ''

  return (
    <>
      <span
        ref={anchorRef}
        className={`si-island topbar-status${lit ? ' on' : ''}${open ? ' open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={lit ? `${text}（点击查看全部通知）` : text}
        onClick={() => lit && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (lit) setOpen((o) => !o)
          }
        }}
      >
        <i className={`si-dot topbar-status-dot${primary?.kind === 'progress' ? ' busy'
          : primary?.kind === 'alert' ? ' warn' : lit ? ' ok' : ''}`} />
        <span key={text} className="si-text pill-text-fade">{text}</span>
        {lit && notices.length > 1 && <span className="si-count">{notices.length}</span>}
        {lit && <ChevronDown className="si-chevron size-[12px]" />}
      </span>

      {open && pos && primary &&
        createPortal(
          <div
            className="si-panel"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            role="dialog"
            aria-label="顶栏通知"
          >
            <div className="si-panel-head">
              <span className="si-panel-title">通知（{notices.length}）</span>
              <span className="si-panel-hint">{href}</span>
            </div>
            <OverlayScroll className="si-panel-scroll">
              <ul className="si-list">
                {notices.map((n) => (
                  <li key={n.id} className="si-item" data-kind={n.kind}>
                    <span className={`si-item-icon k-${n.kind}`}>{KIND_ICON[n.kind]}</span>
                    <span className="si-item-main">
                      <span className="si-item-text">{n.text}</span>
                      {n.detail && <span className="si-item-detail">{n.detail}</span>}
                      <span className="si-item-meta">
                        {KIND_LABEL[n.kind]}
                        {n.source ? ` · ${n.source}` : ''}
                        {n.sticky ? ' · 常驻' : ''}
                      </span>
                    </span>
                    {n.action && (
                      <button
                        type="button"
                        className="si-item-action"
                        onClick={() => onAction(n.action!.kind, n)}
                      >
                        {n.action.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </OverlayScroll>
            <div className="si-panel-foot">
              <span className="si-panel-order">
                优先级：{Object.entries(KIND_PRIORITY).sort((a, b) => b[1] - a[1])
                  .map(([k]) => KIND_LABEL[k]).join(' > ')}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
