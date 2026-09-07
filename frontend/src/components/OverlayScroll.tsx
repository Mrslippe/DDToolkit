import { useCallback, useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode, UIEvent } from 'react'

interface OverlayScrollProps {
  /** 根节点类（外层定位容器，overflow:hidden）；滚动内容放 .os-scroll 内 */
  className?: string
  /** 根节点样式（如 fixed 定位弹层的位置/宽度） */
  style?: CSSProperties
  /** 可访问性透传（dialog 等） */
  role?: string
  'aria-modal'?: boolean
  children: ReactNode
  /** 透传给内部滚动体的 ref（调用方需要 scrollTo/scrollTop 时使用） */
  scrollRef?: { current: HTMLDivElement | null }
  /** 透传给内部滚动体的 onScroll */
  onScroll?: (e: UIEvent<HTMLDivElement>) => void
}

/**
 * 覆盖式滚动条（滚动条视觉标准 2026-09-07 user 定案）：
 * - 原生滚动条隐藏（display:none + scrollbar-width:none）→ **不占布局宽度**，
 *   容器/弹窗不会因滚动条变宽；
 * - 拇指绝对定位悬浮于内容之上：透明轨道 + 常态 --c-border 细灰 +
 *   hover 顶栏粉 --c-primary（第 4-6px）；圆角胶囊，可拖拽；
 * - 显示策略：滚动 / 鼠标悬浮容器时出现，静止 700ms 或移出后自动隐藏；
 * - 内容不溢出时不渲染拇指。
 */
export default function OverlayScroll({
  className = '', style, role, children, scrollRef, onScroll,
  'aria-modal': ariaModal,
}: OverlayScrollProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollEl = useRef<HTMLDivElement | null>(null)
  const thumbEl = useRef<HTMLDivElement | null>(null)
  const frame = useRef(0)
  const hideTimer = useRef<number | undefined>(undefined)
  const dragging = useRef(false)

  const update = useCallback(() => {
    const sc = scrollEl.current
    const tb = thumbEl.current
    if (!sc || !tb) return
    const H = sc.clientHeight
    const S = sc.scrollHeight
    if (S <= H + 1) {
      tb.style.display = 'none'
      return
    }
    tb.style.display = 'block'
    const th = Math.max(28, Math.round((H / S) * H))
    const maxTop = H - th - 8
    const top = S - H > 0 ? (sc.scrollTop / (S - H)) * maxTop : 0
    tb.style.height = `${th}px`
    tb.style.top = `${Math.max(4, top)}px`
    tb.classList.add('os-show')
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (!dragging.current) tb.classList.remove('os-show')
    }, 700)
  }, [])

  useEffect(() => {
    const sc = scrollEl.current
    const root = rootRef.current
    const tb = thumbEl.current
    if (!sc || !root || !tb) return
    const request = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(update)
    }
    const onEnter = () => {
      tb.classList.add('os-show')
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
    const onLeave = () => {
      if (!dragging.current) tb.classList.remove('os-show')
    }
    sc.addEventListener('scroll', request, { passive: true })
    root.addEventListener('mouseenter', onEnter)
    root.addEventListener('mouseleave', onLeave)
    // 内容异步加载/尺寸变化时重算（档案卡、弹窗数据加载完成等，2026-09-07）
    const ro = new ResizeObserver(request)
    ro.observe(sc)
    update()
    return () => {
      sc.removeEventListener('scroll', request)
      root.removeEventListener('mouseenter', onEnter)
      root.removeEventListener('mouseleave', onLeave)
      ro.disconnect()
      cancelAnimationFrame(frame.current)
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [update])

  const onThumbDown = (e: React.PointerEvent) => {
    dragging.current = true
    thumbEl.current?.setPointerCapture(e.pointerId)
  }

  const onThumbMove = (e: React.PointerEvent) => {
    const sc = scrollEl.current
    const tb = thumbEl.current
    const root = rootRef.current
    if (!sc || !tb || !root || !dragging.current) return
    const H = sc.clientHeight
    const S = sc.scrollHeight
    const th = tb.offsetHeight
    const maxTop = H - th - 8
    const rect = root.getBoundingClientRect()
    const top = e.clientY - rect.top - th / 2 - 4
    const clamped = Math.min(Math.max(top, 0), maxTop)
    sc.scrollTop = (clamped / maxTop) * (S - H)
  }

  const onThumbUp = () => {
    dragging.current = false
    const tb = thumbEl.current
    if (!tb) return
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => tb.classList.remove('os-show'), 700)
  }

  return (
    <div
      ref={rootRef}
      className={`os-root ${className}`.trim()}
      style={style}
      role={role}
      aria-modal={ariaModal}
    >
      <div
        ref={(el) => {
          scrollEl.current = el
          if (scrollRef) scrollRef.current = el
        }}
        className="os-scroll"
        onScroll={onScroll}
      >
        {children}
      </div>
      <div ref={thumbEl} className="os-thumb"
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
        onLostPointerCapture={onThumbUp}
      />
    </div>
  )
}
