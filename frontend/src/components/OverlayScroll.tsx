import { useCallback, useEffect, useRef } from 'react'
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  UIEvent,
} from 'react'

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
 * 覆盖式滚动条（滚动条视觉标准 2026-09-07 user 定案，2026-09-09 修订）：
 * - 原生滚动条隐藏（display:none + scrollbar-width:none）→ 不占布局宽度；
 * - 拇指绝对定位悬浮：透明轨 + 常态 --c-border 细灰；**指针压在拇指上或拖拽中**
 *   才变粉加粗（.os-thumb.os-show:hover / .os-drag），滚轮滚动时保持浅灰；圆角
 *   胶囊；内容不溢出不渲染；
 * - 显隐纯调度：滚动中亮出、停止 700ms 淡出；悬浮亮出、1.2s 无动作淡出；
 *   指针靠近右缘 18px 内亮出（否则「hover 拇指变粉」够不着）；移出立即淡出；
 *   隐藏定时器无条件执行；
 * - 拇指拖拽（2026-09-07 robust 版，非当初裸 pointer-capture）：
 *   · 按下 = 指针捕获 + 记录 grabY（指针相对拇指顶部的偏移），移动时绝对反解
 *     scrollTop（不依赖增量累加，天然消除 clamp 累积误差）；
 *   · 结束 = 四重兜底：pointerup / pointercancel / lostpointercapture /
 *     window blur（覆盖拖出窗口、alt-tab、弹层拦截、捕获丢失全部路径）——
 *     结束【无条件】reveal(700) 重新调度隐藏，不再有"拖拽中永不隐藏"的抑制位；
 *   · 拖拽期间 onScroll 仅 sync 不 reveal（停顿也保持显示，交由 endDrag 收尾）；
 * - 状态同步（sync）只改位置/尺寸/display：scroll（rAF）/ ResizeObserver
 *   （滚动体 + 首个子元素）/ 400ms 轮询兜底（内容异步长高）。
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
  /** 拖拽会话（无 = 未拖拽）；grabY = 按下时指针相对拇指顶的偏移 */
  const drag = useRef<{ pointerId: number; grabY: number } | null>(null)

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
      return
    }
    tb.style.display = 'block'
    const th = Math.max(28, Math.round((H / S) * H))
    const maxTop = Math.max(H - th - 8, 0)
    const top = S - H > 0 ? (sc.scrollTop / (S - H)) * maxTop : 0
    tb.style.height = `${th}px`
    tb.style.top = `${Math.max(4, top)}px`
  }, [])

  /** 亮出 + 调度自动隐藏；隐藏定时器无条件执行（不检查任何状态） */
  const reveal = useCallback((idleMs: number) => {
    const tb = thumbEl.current
    if (!tb) return
    tb.classList.add('os-show')
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      tb.classList.remove('os-show')
    }, idleMs)
  }, [])

  const hideNow = useCallback(() => {
    const tb = thumbEl.current
    if (!tb) return
    tb.classList.remove('os-show')
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
  }, [])

  /** 结束拖拽：无条件清会话 + 重新调度隐藏（700ms）——楔死免疫 */
  const endDrag = useCallback(() => {
    if (!drag.current) return
    drag.current = null
    thumbEl.current?.classList.remove('os-drag')
    reveal(700)
  }, [reveal])

  /** 拇指按下：指针捕获 + 记录 grabY；拖拽期间隐藏定时器不启动 */
  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const sc = scrollEl.current
    const root = rootRef.current
    const tb = thumbEl.current
    if (!sc || !root || !tb) return
    if (sc.scrollHeight <= sc.clientHeight + 1) return   // 无溢出不可拖
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    try {
      tb.setPointerCapture(e.pointerId)
    } catch {
      /* 极个别环境捕获失败：仍记会话，靠 window pointerup/blur 兜底 */
    }
    drag.current = {
      pointerId: e.pointerId,
      grabY: e.clientY - root.getBoundingClientRect().top - tb.offsetTop,
    }
    tb.classList.add('os-show', 'os-drag')   // os-drag → 拖拽期间保持粉色（layout.css）
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = undefined
    }
  }

  /** 拖动：绝对映射（不增量累加）——指针到拇指顶，由 grabY 反解 scrollTop */
  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const sc = scrollEl.current
    const root = rootRef.current
    if (!d || d.pointerId !== e.pointerId || !sc || !root) return
    const H = sc.clientHeight
    const S = sc.scrollHeight
    if (H <= 0 || S <= H + 1) return
    const th = Math.max(28, Math.round((H / S) * H))
    const maxTop = Math.max(H - th - 8, 0)
    const topPx = e.clientY - root.getBoundingClientRect().top - d.grabY
    const ratio = Math.min(Math.max((topPx - 4) / Math.max(maxTop, 1), 0), 1)
    sc.scrollTop = ratio * (S - H)
  }

  useEffect(() => {
    const sc = scrollEl.current
    const root = rootRef.current
    const tb = thumbEl.current
    if (!sc || !root || !tb) return

    const onScroll = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => {
        sync()
        // 拖拽中只同步不调度隐藏（停顿也保持显示，收尾由 endDrag 负责）
        if (!drag.current) reveal(700)
      })
    }
    const onEnter = () => reveal(1200)          // 悬浮亮出，1.2s 无动作自动淡出
    const onLeave = () => hideNow()
    // 指针靠近右缘（滚条槽区）→ 亮出：否则「hover 拇指变粉」几乎够不着
    // （滚完 700ms 就淡出，指针移过去时已经没了）。2026-09-09 随「粉只属于指针」补。
    const onMove = (e: MouseEvent) => {
      const r = root.getBoundingClientRect()
      if (r.right - e.clientX <= 18) reveal(1200)
    }
    // 四重兜底之三/四：window 级 pointerup（捕获丢失/拖出）+ blur（alt-tab）
    const onWinPointerUp = () => endDrag()
    const onWinBlur = () => endDrag()

    sc.addEventListener('scroll', onScroll, { passive: true })
    root.addEventListener('mouseenter', onEnter)
    root.addEventListener('mouseleave', onLeave)
    root.addEventListener('mousemove', onMove)
    window.addEventListener('pointerup', onWinPointerUp)
    window.addEventListener('blur', onWinBlur)

    // 内容尺寸变化：滚动体自身（视口缩放）+ 首个子元素（内容长高会改变其
    // 边框盒——scrollHeight 增长不会触发自身 RO）
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(sync)
    })
    ro.observe(sc)
    if (sc.firstElementChild) ro.observe(sc.firstElementChild)
    const poll = window.setInterval(() => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(sync)
    }, 400)

    sync()
    return () => {
      sc.removeEventListener('scroll', onScroll)
      root.removeEventListener('mouseenter', onEnter)
      root.removeEventListener('mouseleave', onLeave)
      root.removeEventListener('mousemove', onMove)
      window.removeEventListener('pointerup', onWinPointerUp)
      window.removeEventListener('blur', onWinBlur)
      ro.disconnect()
      window.clearInterval(poll)
      cancelAnimationFrame(frame.current)
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [sync, reveal, hideNow, endDrag])

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
      {/* 拇指：显示时可拖拽（os-show 才启用 pointer-events，见 layout.css）；
          显隐由调度驱动，拖拽结束无条件重排隐藏（四重兜底） */}
      <div
        ref={thumbEl}
        className="os-thumb"
        aria-hidden="true"
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
    </div>
  )
}
