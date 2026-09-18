import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react'
import ProxyImage from './common/ProxyImage'

export interface ViewerImage {
  url: string
  width?: number
  height?: number
}

interface Props {
  images: ViewerImage[]
  /** 当前展示的下标（父级持有，切换由 onIndexChange 上报） */
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}

/** 退场时长：与详情窗退场（200ms）同拍 */
const EXIT_MS = 200

/** 灯箱大图：状态机与占位统一走 ProxyImage（外层 key=url 逐张重置） */
function ViewerImg({ src, alt, zoom = 1, pan = { x: 0, y: 0 }, anim = 'none' }:
{ src: string; alt?: string; zoom?: number; pan?: Pan; anim?: 'none' | 'zoom' | 'settle' }) {
  return (
    <ProxyImage
      src={src}
      alt={alt}
      className="max-h-[84vh] max-w-[92vw] select-none object-contain"
      fallbackClassName=""
      draggable={false}
      /* R40c/R40e：缩放与拖动都走 `transform`（合成器属性，不重排）；
         **位移写外层、缩放写内层** ⇒ 位移是屏幕像素，边界好算。
         `transform-origin` **恒定居中**（跟着指针走会在缩小时闪位置 —— 用户当场否掉的那版）。
         过渡按模式分派：拖动中 `none`（跟手）、滚轮 `zoom`（短）、松手回位 `settle`（带一点过冲 = 弹性）。 */
      style={{
        transform: zoom === 1 && !pan.x && !pan.y
          ? undefined
          : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: '50% 50%',
        transition: anim === 'none'
          ? 'none'
          : anim === 'settle'
            ? 'transform 280ms cubic-bezier(0.22, 1.18, 0.36, 1)'   // 轻微过冲 = 弹性约束
            : 'transform 140ms ease-out',
      }}
      fallback={
        <div className="flex flex-col items-center gap-2 px-6 text-muted-foreground">
          <ImageOff className="size-10" />
          <span className="text-sm">图片加载失败</span>
        </div>
      }
    />
  )
}

/** 缩放范围：1 = 适应窗口（默认），最大 4 倍。不允许小于 1（比适应窗口更小没有意义）。 */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 4
/** 每一格滚轮的缩放步进（按 deltaY 的符号走指数曲线，手感比线性稳） */
export const ZOOM_STEP = 0.22

/** 纯函数：滚轮增量 → 新的缩放倍数（夹在 [ZOOM_MIN, ZOOM_MAX]） */
export function nextZoom(cur: number, deltaY: number): number {
  if (!deltaY) return cur
  const next = deltaY < 0 ? cur * (1 + ZOOM_STEP) : cur / (1 + ZOOM_STEP)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 1000) / 1000))
}

export interface Pan { x: number; y: number }

/**
 * 纯函数：缩放时**把指针下的那个点钉住**（R40e，用户 2026-09-19）。
 *
 * ⚠️ 为什么不用 `transform-origin` 跟指针（R40c 的第一版就是那么写的，被用户当场否掉）：
 *   每个滚轮事件都重算 origin，缩小时锚点又变 + 已有位移还在 ⇒ **突然闪到别的位置** ✗。
 * 正确做法（B站那套）：**origin 恒定居中**，用**位移**去补偿缩放 ——
 *   图片上某点 `u`（相对中心的未缩放坐标）在屏幕上的位置是 `pan + u·scale`；
 *   要让指针位置 `a`（相对中心）底下的那个点缩放后还在原地，就得
 *     `pan' = a − (a − pan) · (scale'/scale)`
 *   ⇒ 缩小到 1 倍时 `pan'` 自然收敛回 0（再由 `clampPan` 钉死），**不会跳**。
 */
export function zoomPan(pan: Pan, scale: number, nextScale: number, anchor: Pan): Pan {
  if (scale <= 0 || nextScale === scale) return pan
  const k = nextScale / scale
  return { x: anchor.x - (anchor.x - pan.x) * k, y: anchor.y - (anchor.y - pan.y) * k }
}

/**
 * 纯函数：把拖动位移**钳在图片边界内**（R40d，抓手）。
 *
 * 规则：可拖范围 = 放大后**超出视口的那部分的一半** ——
 *   · 没放大（scale=1，图片本来就装得下）⇒ 上下左右都拖不动（`max = 0`）；
 *   · 放大后最多拖到"图片边缘与视口边缘对齐"，不会把图拖出屏幕再也找不回来。
 *
 * ⚠️ 它**只用于"松手后的弹性回位"与缩放后的收敛**，不用于拖动过程 ——
 *   用户口径（R40e）：「抓手即使左右移动也可以跟随，但是松手后会自动弹性约束到中间」
 *   ⇒ 拖动中自由跟随，松手才把这里算出的目标值当成落点。
 */
export function clampPan(pan: Pan, scale: number, size: { w: number; h: number },
                         viewport: { w: number; h: number }): Pan {
  const maxX = Math.max(0, (size.w * scale - viewport.w) / 2)
  const maxY = Math.max(0, (size.h * scale - viewport.h) / 2)
  // `+ 0`：把 `-0` 归一成 `0`（否则 `data-viewer-pan` 会写成 "-0,0"，看着像坏了；
  // 单测里 `toEqual` 用 Object.is，-0 与 0 也不相等）
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)) + 0,
    y: Math.min(maxY, Math.max(-maxY, pan.y)) + 0,
  }
}

/** 松手回位用的落点：先钳制，再把"没放大"的情况一并归零 */
export function settleTarget(pan: Pan, scale: number, size: { w: number; h: number },
                             viewport: { w: number; h: number }): Pan {
  if (scale <= ZOOM_MIN + 0.001) return { x: 0, y: 0 }
  return clampPan(pan, scale, size, viewport)
}

/**
 * P6-4：帖子详情中的独立图片查看器。
 * - 浮于详情窗口之上（body portal + z-[200] > dialog z-50），交互完全自持：
 *   根层显式 pointer-events-auto（详情窗 modal 会把 body 置为 pointer-events:none，
 *   不恢复则点击穿透到其下 overlay 先关详情窗）+ onPointerDown 阻断冒泡
 *   （屏蔽 radix pointerdownOutside）
 * - 遮罩只盖详情窗口本身（按 [data-slot=dialog-content] 实测矩形定位），
 *   不给整屏加黑纱
 * - 关闭有退场动画（is-exiting 类驱动 200ms，再真正卸载）
 * - 上一张 / 下一张（循环，左右键同效）；底部点状序号点击跳转
 * - **滚轮缩放**（R40c）：`transform: scale()` + 以指针为锚点，范围 [1, 4]
 * - 控件为黑色玻璃浮钮；关闭钮同构圆钮
 */
export default function ImageViewer({ images, index, onIndexChange, onClose }: Props) {
  const count = images.length
  const img = images[index]
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | undefined>(undefined)
  const [veilRect, setVeilRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  /** 缩放倍数与拖动位移（R40c/R40e）；切图时由 `key` 重建 ⇒ 自动复位 */
  const [scale, setScale] = useState(ZOOM_MIN)
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 })
  /** 动画模式：拖动中**不要过渡**（否则跟手发飘）；松手回位要**弹性**；滚轮缩放短过渡 */
  const [anim, setAnim] = useState<'none' | 'zoom' | 'settle'>('none')
  const dragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** 刚拖过：用来吞掉紧随其后的 click（否则一松手就把查看器关了） */
  const draggedRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const settleTimer = useRef<number | null>(null)
  useEffect(() => () => { if (settleTimer.current != null) window.clearTimeout(settleTimer.current) }, [])

  /**
   * 滚轮缩放（R40e 重写）：**origin 恒定居中**，用位移补偿 ⇒ 指针下的点钉住、
   * 缩小时自然收敛回中间（不再有"缩小就闪到别处"）。
   */
  const onWheelZoom = (e: React.WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const next = nextZoom(scale, e.deltaY)
    if (next === scale) return
    const box = e.currentTarget.getBoundingClientRect()
    // 指针相对**容器中心**的偏移（origin 就是中心）
    const anchor = {
      x: e.clientX - (box.left + box.width / 2),
      y: e.clientY - (box.top + box.height / 2),
    }
    const raw = zoomPan(pan, scale, next, anchor)
    const img = bodyRef.current?.querySelector('img')
    const ir = img?.getBoundingClientRect()
    const size = ir && scale > 0
      ? { w: ir.width / scale, h: ir.height / scale }
      : { w: box.width, h: box.height }
    setAnim('zoom')
    setScale(next)
    setPan(settleTarget(raw, next, size, { w: window.innerWidth, h: window.innerHeight }))
  }

  /** 抓手拖动（R40e）：**拖动中自由跟随**（不夹取），松手才弹性回到约束位置 */
  const canPan = scale > ZOOM_MIN + 0.001
  const onPointerDown = (e: React.PointerEvent) => {
    if (!canPan || closing) return
    e.stopPropagation()
    dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y }
    draggedRef.current = false
    setDragging(true)
    setAnim('none')
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    e.stopPropagation()
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 3) draggedRef.current = true
    setPan({ x: d.ox + dx, y: d.oy + dy })     // 自由跟随：这里**不夹取**
  }
  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    // 松手：弹性回位到约束范围内（拖出边界的部分"收回去"，而不是硬切）
    const img = bodyRef.current?.querySelector('img')
    const ir = img?.getBoundingClientRect()
    const box = e.currentTarget.getBoundingClientRect()
    const size = ir && scale > 0
      ? { w: ir.width / scale, h: ir.height / scale }
      : { w: box.width, h: box.height }
    const target = settleTarget(pan, scale, size, { w: window.innerWidth, h: window.innerHeight })
    setAnim('settle')
    setPan(target)
    if (settleTimer.current != null) window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => setAnim('none'), 320)
  }

  const go = (d: number) => {
    if (closing) return
    onIndexChange((index + d + count) % count)
  }
  const requestClose = () => {
    if (closing) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(onClose, EXIT_MS)
  }

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), [])

  useEffect(() => {
    // capture 阶段拦截：Esc 只关查看器，不连带关掉背后的详情窗口
    const onKey = (e: KeyboardEvent) => {
      if (closing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        requestClose()
      } else if (count > 1 && e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        go(-1)
      } else if (count > 1 && e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        go(1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // ⚠️ 已知走查项（2026-09-13 eslint 基线）：`go`/`requestClose` 是父级传入的**行内箭头**，
    // 每次渲染都是新引用 —— 加进依赖会让 keydown 监听每渲染重挂。当前靠
    // `index/count/closing/onClose/onIndexChange` 这几个"真实变化量"兜住（灯箱是短命浮层，
    // 打开期间父级很少重渲染）。**没有实测过陈旧闭包**，所以本批只登记、不改行为；
    // 若要根治，正确做法是把父级这两个回调包 `useCallback`，而不是往依赖里塞裸函数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, count, closing, onClose, onIndexChange])

  // 遮罩只盖详情窗口：按详情窗 content 的实测矩形定位（打开时量一次 + 窗口 resize 复测）
  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector('[data-slot="dialog-content"]')
      if (!el) {
        setVeilRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      setVeilRect({ left: r.left, top: r.top, width: r.width, height: r.height })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  if (!img) return null

  const glassBtn =
    'flex items-center justify-center rounded-full border border-white/25 bg-black/60 text-white backdrop-blur transition-colors hover:bg-black/85 hover:text-white'

  return createPortal(
    // pointer-events-auto：必填——背后的 radix 详情窗（modal）会把
    // document.body 置为 pointer-events:none（disableOutsidePointerEvents），
    // 查看器 portal 到 body、属于「窗外节点」，会连带继承 none 变成点击穿透：
    // 命中落到其下 z-50 的详情窗 overlay（own dismissable surface）→ 先关详情窗。
    // 显式 auto 恢复本层可点击，onPointerDown 再阻断冒泡屏蔽 pointerdownOutside。
    <div
      className={'pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center p-4' + (closing ? ' image-viewer-closing' : '')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={requestClose}
    >
      {/* 遮罩：只盖详情窗口（矩形实测，圆角随详情窗） */}
      {veilRect && (
        <div
          className="image-viewer-veil absolute rounded-lg bg-[rgba(15,23,42,0.32)]"
          style={{ left: veilRect.left, top: veilRect.top, width: veilRect.width, height: veilRect.height }}
        />
      )}

      {/* 关闭：黑色玻璃圆钮（与前后切换同构），不影响背后详情窗 */}
      <button
        aria-label="关闭图片查看"
        onClick={(e) => {
          e.stopPropagation()
          requestClose()
        }}
        className={`${glassBtn} absolute right-5 top-5 size-10`}
      >
        <X className="size-5" strokeWidth={2.25} />
      </button>

      {/* 上一张 / 下一张（单图隐藏） */}
      {count > 1 && (
        <>
          <button
            aria-label="上一张"
            onClick={(e) => {
              e.stopPropagation()
              go(-1)
            }}
            className={`${glassBtn} absolute left-4 top-1/2 size-11 -translate-y-1/2`}
          >
            <ChevronLeft className="size-6" />
          </button>
          <button
            aria-label="下一张"
            onClick={(e) => {
              e.stopPropagation()
              go(1)
            }}
            className={`${glassBtn} absolute right-4 top-1/2 size-11 -translate-y-1/2`}
          >
            <ChevronRight className="size-6" />
          </button>
        </>
      )}

      {/* 主体：无外框背景，图片直接浮于详情窗口上方。
          R40c（用户 2026-09-19）：「为帖子详情弹窗中可以打开的图片查看器新增图片缩放功能，
          用滚轮控制放大和缩小」——
          · 只动 `transform: scale()`（不走 width/height：那会每帧重排，且大图重排很贵）；
          · 以**指针位置**为锚点缩放（`transform-origin` 跟着指针走），放大后想看哪就看哪；
          · 范围 `[1, 4]`：1 = 适应窗口（默认），不允许缩到比适应窗口更小（那没有意义）；
          · 切图/关闭自动复位（`key` 变化即重建 ⇒ scale 回到 1）。 */}
      <div
        key={`${img.url}-${index}`}
        ref={bodyRef}
        className="image-viewer-img flex max-h-full max-w-full items-center justify-center"
        data-viewer-scale={scale.toFixed(2)}
        data-viewer-pan={`${Math.round(pan.x)},${Math.round(pan.y)}`}
        data-viewer-grab={canPan ? (dragging ? 'grabbing' : 'grab') : 'none'}
        data-viewer-anim={anim}
        onWheel={onWheelZoom}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(e) => {
          e.stopPropagation()
          // 拖动结束时不要顺带把查看器关了（用户只是想挪一下图）
          if (draggedRef.current) {
            draggedRef.current = false
            return
          }
        }}
        style={{ cursor: canPan ? (dragging ? 'grabbing' : 'grab') : 'default' }}
      >
        <ViewerImg src={img.url} alt={img.url} zoom={scale} pan={pan} anim={anim} />
      </div>

      {/* 底部点状序号（单图隐藏） */}
      {count > 1 && (
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2">
          {images.map((im, i) => (
            <button
              key={`${im.url}-${i}`}
              aria-label={`第 ${i + 1} 张`}
              onClick={(e) => {
                e.stopPropagation()
                if (!closing) onIndexChange(i)
              }}
              className={`h-2 w-2 rounded-full transition-all duration-200 ${
                i === index ? 'scale-125 bg-white' : 'bg-white/40 hover:bg-white/75'
              }`}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
