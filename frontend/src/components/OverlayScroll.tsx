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
 * - 原生滚动条隐藏（display:none + scrollbar-width:none）→ **不占布局宽度**；
 * - 拇指绝对定位悬浮：透明轨 + 常态 --c-border 细灰 + hover 粉 --c-primary，
 *   圆角胶囊、可拖拽；内容不溢出不渲染；
 * - 显示策略：滚动时亮出、停止 700ms 淡出；悬浮亮出、1.5s 无动作淡出；
 *   移出立即淡出；
 * - 状态同步（sync）与显隐调度（show/hide）分离：
 *   · sync 由 scroll（rAF）/ ResizeObserver（滚动体 + 首个子元素：内容长高会
 *     改变子元素边框盒）/ 400ms 低频轮询 触发——只改位置/尺寸/display；
 *   · show/hide 只在交互事件中调度，绝不叠加，杜绝「陈旧拇指常亮」。
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

  /** 仅同步位置/尺寸/display（不动显隐），可频繁调用 */
  const sync = useCallback(() => {
    const sc = scrollEl.current
    const tb = thumbEl.current
    if (!sc || !tb) return
    const H = sc.clientHeight
    const S = sc.scrollHeight
    if (H <= 0) return                 // 布局未定，交给轮询/RO 再试
    if (S <= H + 1) {
      tb.style.display = 'none'
      tb.style.opacity = ''
      return
    }
    tb.style.display = 'block'
    const th = Math.max(28, Math.round((H / S) * H))
    const maxTop = Math.max(H - th - 8, 0)
    const top = S - H > 0 ? (sc.scrollTop / (S - H)) * maxTop : 0
    tb.style.height = `${th}px`
    tb.style.top = `${Math.max(4, top)}px`
  }, [])

  /** 同步 + 亮出 + 700ms 无交互自动淡出（滚动触发；悬浮用 onEnter 独立 1.5s） */
  const update = useCallback(() => {
    const tb = thumbEl.current
    sync()
    if (!tb) return
    tb.classList.add('os-show')
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (!dragging.current) tb.classList.remove('os-show')
    }, 700)
  }, [sync])

  const hideNow = useCallback(() => {
    const tb = thumbEl.current
    if (!tb || dragging.current) return
    tb.classList.remove('os-show')
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
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
      hideTimer.current = window.setTimeout(() => {
        if (!dragging.current) tb.classList.remove('os-show')
      }, 1500)
    }
    const onLeave = () => hideNow()

    sc.addEventListener('scroll', request, { passive: true })
    root.addEventListener('mouseenter', onEnter)
    root.addEventListener('mouseleave', onLeave)

    // 内容尺寸变化：滚动体自身（视口缩放）+ 首个子元素（内容长高会改变其
    // 边框盒——ResizeObserver 只看边框盒，scrollHeight 增长不会触发自身）
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(sync)
    })
    ro.observe(sc)
    if (sc.firstElementChild) ro.observe(sc.firstElementChild)
    // 轮询兜底（异步加载/占位切换等极端情形，400ms 极轻）
    const poll = window.setInterval(() => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(sync)
    }, 400)

    sync()
    return () => {
      sc.removeEventListener('scroll', request)
      root.removeEventListener('mouseenter', onEnter)
      root.removeEventListener('mouseleave', onLeave)
      ro.disconnect()
      window.clearInterval(poll)
      cancelAnimationFrame(frame.current)
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [update, sync, hideNow])

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
