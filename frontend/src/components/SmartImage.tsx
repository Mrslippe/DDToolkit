import { useState } from 'react'
import { Image, type ImageProps } from 'antd'
import { PictureOutlined } from '@ant-design/icons'
import { imgProxyUrl } from '../api/api'
import { normalizeImageUrl } from '../utils/format'

type Stage = 'direct' | 'proxy' | 'failed'

interface Props extends Omit<ImageProps, 'src'> {
  src?: string
  /** 直连失败后自动重试代理；proxyPreview=true 时点击预览直接走代理（防盗链最稳） */
  proxyPreview?: boolean
}

/**
 * 混合图片方案（devlog/015）：
 * 1. 默认直连 CDN（https 化 + no-referrer）—— 性能最优
 * 2. onError 自动重试后端代理 /img-proxy（带磁盘缓存）—— 兜底
 * 3. 代理也失败 → 渲染占位块，不再出现破图
 */
export default function SmartImage({ src, proxyPreview = true, ...rest }: Props) {
  const [stage, setStage] = useState<Stage>('direct')

  // 显式传入 preview=false 时禁用预览（避免与外层点击行为冲突，一操作一行为）
  const { preview: previewProp, ...imageProps } = rest
  const previewEnabled = previewProp !== false

  const direct = src ? normalizeImageUrl(src) : undefined
  const proxy = direct ? imgProxyUrl(direct) : undefined
  const current = stage === 'direct' ? direct : stage === 'proxy' ? proxy : undefined

  if (!current) {
    return (
      <div
        style={{
          width: imageProps.width ?? 120,
          height: imageProps.height ?? 120,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f0f2f5',
          borderRadius: 6,
          color: '#aab2bd',
        }}
      >
        <PictureOutlined style={{ fontSize: 24 }} />
      </div>
    )
  }

  return (
    <Image
      {...imageProps}
      src={current}
      referrerPolicy="no-referrer"
      preview={previewEnabled ? (proxyPreview ? { src: proxy } : undefined) : false}
      onError={() => {
        if (stage === 'direct') setStage('proxy')
        else setStage('failed')
      }}
    />
  )
}
