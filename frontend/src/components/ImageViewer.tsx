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
      <div className="flex flex-col items-center gap-2 px-6 text-white/50">
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
 * - 与详情窗口完全独立（portal 到 body，z 高于 dialog），叠加/关闭互不干扰
 * - 上一张 / 下一张（循环，左右键同效）；底部点状序号点击跳转
 * - 关闭钮重绘为圆环描边玻璃钮；主体无外框背景，图片直接浮于遮罩上
 * - 直接浮于遮罩，去掉外层卡片/圆角/边框等一切外框背景
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

  const navBtn =
    'flex size-11 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white/90 backdrop-blur transition-colors hover:bg-white/25 hover:text-white'

  return createPortal(
    <div
      className="image-viewer fixed inset-0 z-[200] flex items-center justify-center bg-black/85"
      onClick={onClose}
    >
      {/* 关闭：重绘为圆环描边玻璃钮 */}
      <button
        aria-label="关闭图片查看"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="absolute right-5 top-5 flex size-10 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white/90 backdrop-blur transition-colors hover:bg-white/25 hover:text-white"
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
            className={`${navBtn} absolute left-4 top-1/2 -translate-y-1/2`}
          >
            <ChevronLeft className="size-6" />
          </button>
          <button
            aria-label="下一张"
            onClick={(e) => {
              e.stopPropagation()
              go(1)
            }}
            className={`${navBtn} absolute right-4 top-1/2 -translate-y-1/2`}
          >
            <ChevronRight className="size-6" />
          </button>
        </>
      )}

      {/* 主体：无外框背景，图片直接浮于遮罩 */}
      <div
        className="flex max-h-full max-w-full items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <ViewerImg key={`${img.url}-${index}`} src={img.url} alt={img.url} />
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
                i === index ? 'scale-125 bg-white' : 'bg-white/30 hover:bg-white/60'
              }`}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
