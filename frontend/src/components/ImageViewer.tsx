import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react'
import { imgProxyUrl } from '../api/api'
import { normalizeImageUrl } from '../utils/format'

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

type Stage = 'direct' | 'proxy' | 'failed'

/** 单张大图：直连 → 代理 → 失败占位（与 SmartImage 同策略，key=src 逐张重置状态） */
function ViewerImg({ src, alt }: { src: string; alt?: string }) {
  const direct = normalizeImageUrl(src)
  const proxy = direct ? imgProxyUrl(direct) : undefined
  const [stage, setStage] = useState<Stage>(
    direct && (direct.includes('sinaimg.cn') || direct.includes('wbcdn.cn')) ? 'proxy' : 'direct',
  )
  const current = stage === 'direct' ? direct : stage === 'proxy' ? proxy : undefined

  if (stage === 'failed' || !current) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 text-muted-foreground">
        <ImageOff className="size-10" />
        <span className="text-sm">图片加载失败</span>
      </div>
    )
  }

  return (
    <img
      src={current}
      alt={alt}
      referrerPolicy="no-referrer"
      className="max-h-[84vh] max-w-[92vw] select-none object-contain"
      draggable={false}
      onError={() => setStage(stage === 'direct' ? 'proxy' : 'failed')}
    />
  )
}

/**
 * P6-4：帖子详情中的独立图片查看器。
 * - 浮于详情窗口之上（body portal + z-[200] > dialog z-50），交互完全自持：
 *   根层显式 pointer-events-auto（详情窗 modal 会把 body 置为 pointer-events:none，
 *   不恢复则点击穿透到其下 overlay 先关详情窗）+ onPointerDown 阻断冒泡
 *   （屏蔽 radix pointerdownOutside）
 * - 无黑色遮罩：图片直接浮于详情窗口上方，不与详情窗背景叠加变黑
 * - 上一张 / 下一张（循环，左右键同效）；底部点状序号点击跳转
 * - 控件为白玻璃浮钮（发丝边），在亮/暗背景上均可读；关闭钮同构圆钮
 */
export default function ImageViewer({ images, index, onIndexChange, onClose }: Props) {
  const count = images.length
  const img = images[index]
  const go = (d: number) => onIndexChange((index + d + count) % count)

  useEffect(() => {
    // capture 阶段拦截：Esc 只关查看器，不连带关掉背后的详情窗口
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
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
  }, [index, count, onClose, onIndexChange])

  if (!img) return null

  const glassBtn =
    'flex items-center justify-center rounded-full border border-border bg-white/85 text-muted-foreground backdrop-blur transition-colors hover:bg-white hover:text-foreground'

  return createPortal(
    // pointer-events-auto：必填——背后的 radix 详情窗（modal）会把
    // document.body 置为 pointer-events:none（disableOutsidePointerEvents），
    // 查看器 portal 到 body、属于「窗外节点」，会连带继承 none 变成点击穿透：
    // 命中落到其下 z-50 的详情窗 overlay（own dismissable surface）→ 先关详情窗。
    // 显式 auto 恢复本层可点击，onPointerDown 再阻断冒泡屏蔽 pointerdownOutside。
    <div
      className="pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center p-4"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClose}
    >
      {/* 关闭：白玻璃圆钮（与前后切换同构），不影响背后详情窗 */}
      <button
        aria-label="关闭图片查看"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
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

      {/* 主体：无外框背景、无遮罩，图片直接浮于详情窗口上方 */}
      <div
        key={`${img.url}-${index}`}
        className="image-viewer-img flex max-h-full max-w-full items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <ViewerImg src={img.url} alt={img.url} />
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
                onIndexChange(i)
              }}
              className={`h-2 w-2 rounded-full transition-all duration-200 ${
                i === index ? 'scale-125 bg-primary' : 'bg-border hover:bg-muted-foreground'
              }`}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
