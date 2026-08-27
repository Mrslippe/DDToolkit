import { useEffect, useState } from 'react'
import { Image as ImageIcon, X } from 'lucide-react'
import { imgProxyUrl } from '../api/api'
import { normalizeImageUrl } from '../utils/format'

type Stage = 'direct' | 'proxy' | 'failed'

interface Props {
  src?: string
  alt?: string
  className?: string
  style?: React.CSSProperties
  /** 图片宽度（px），同时作为无 src 占位块尺寸 */
  width?: number
  height?: number
  /** 点击图片是否打开灯箱预览（列表卡片封面应关闭，避免与外层点击冲突） */
  preview?: boolean
  /** 灯箱内直接走代理地址（防盗链最稳） */
  proxyPreview?: boolean
}

/**
 * 混合图片方案（devlog/015，shadcn 迁移版）：
 * 1. 默认直连 CDN（https 化 + no-referrer）—— 性能最优
 * 2. onError 自动重试后端代理 /img-proxy（带磁盘缓存）—— 兜底
 * 3. 代理也失败 → 渲染占位块，不再出现破图
 * 可选灯箱预览：点击全屏遮罩查看大图（Esc/点击空白关闭）
 */
export default function SmartImage({
  src,
  alt,
  className,
  style,
  width,
  height,
  preview = true,
  proxyPreview = true,
}: Props) {
  const [open, setOpen] = useState(false)

  const direct = src ? normalizeImageUrl(src) : undefined
  const proxy = direct ? imgProxyUrl(direct) : undefined
  // 微博图床(sinaimg/wbcdn)防盗链对应用自身来源一律 403：直连注定失败，
  // 初始 stage 直接走代理（img-proxy 已按主机带 weibo.com Referer，可正常拉取）
  const needProxyFromStart =
    !!direct &&
    (direct.includes('sinaimg.cn') || direct.includes('wbcdn.cn'))
  const [stage, setStage] = useState<Stage>(needProxyFromStart ? 'proxy' : 'direct')
  const current = stage === 'direct' ? direct : stage === 'proxy' ? proxy : undefined
  // 灯箱优先代理（防盗链），代理不可用回退直连
  const previewSrc = (proxyPreview && proxy) || direct

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!current) {
    return (
      <div
        className={className}
        style={{
          width: width ?? style?.width ?? 120,
          height: height ?? style?.height ?? 120,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f0f2f5',
          borderRadius: 6,
          color: '#aab2bd',
          ...style,
        }}
      >
        <ImageIcon style={{ fontSize: 24 }} />
      </div>
    )
  }

  return (
    <>
      <img
        src={current}
        alt={alt}
        className={className}
        style={{
          width,
          height,
          cursor: preview ? 'zoom-in' : undefined,
          ...style,
        }}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => {
          if (stage === 'direct') setStage('proxy')
          else setStage('failed')
        }}
        onClick={
          preview
            ? (e) => {
                e.stopPropagation()
                setOpen(true)
              }
            : undefined
        }
      />
      {open && previewSrc && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setOpen(false)}
        >
          <button
            aria-label="关闭预览"
            className="absolute right-4 top-4 rounded-md bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setOpen(false)}
          >
            <X className="size-5" />
          </button>
          <img
            src={previewSrc}
            alt={alt}
            referrerPolicy="no-referrer"
            className="max-h-[92vh] max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}
