import { useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
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
}

/**
 * 混合图片方案（devlog/015，shadcn 迁移版）：
 * 1. 默认直连 CDN（https 化 + no-referrer）—— 性能最优
 * 2. onError 自动重试后端代理 /img-proxy（带磁盘缓存）—— 兜底
 * 3. 代理也失败 → 渲染占位块，不再出现破图
 * 大图查看统一由 ImageViewer（P6-4 独立灯箱）承担，此处不再内置预览
 */
export default function SmartImage({ src, alt, className, style, width, height }: Props) {
  const direct = src ? normalizeImageUrl(src) : undefined
  const proxy = direct ? imgProxyUrl(direct) : undefined
  // 微博图床(sinaimg/wbcdn)防盗链对应用自身来源一律 403：直连注定失败，
  // 初始 stage 直接走代理（img-proxy 已按主机带 weibo.com Referer，可正常拉取）
  const needProxyFromStart =
    !!direct &&
    (direct.includes('sinaimg.cn') || direct.includes('wbcdn.cn'))
  const [stage, setStage] = useState<Stage>(needProxyFromStart ? 'proxy' : 'direct')
  const current = stage === 'direct' ? direct : stage === 'proxy' ? proxy : undefined

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
    <img
      src={current}
      alt={alt}
      className={className}
      style={{
        width,
        height,
        ...style,
      }}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => {
        if (stage === 'direct') setStage('proxy')
        else setStage('failed')
      }}
    />
  )
}
