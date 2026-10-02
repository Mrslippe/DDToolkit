/**
 * 帖子详情里的**视频块**（2026-10-02，devlog/281）。
 *
 * 口径：
 * - **不自动播放**（点才播，`preload="metadata"` 只取元数据）：避免声音/流量意外；
 * - **fallback 链**：平台的编码档在 WebView2 里不一定都能解（如 HEVC），`onError` 时沿
 *   `video.fallbacks` 换下一条；全失败才显示兜底；
 * - 兜底 = 「在浏览器打开」（复用 `openExternalFromHref`，走带主机白名单的 `open_external`）——
 *   播不了不等于没救，用户至少有一条路能看到内容。
 *
 * 单独成组件（而不是塞进 `PostDetailDrawer`）的原因：详情抽屉带 Radix + 覆盖式滚动条，
 * jsdom 下要补一堆浏览器 API；把播放逻辑独立出来，判据就能只测"换源/兜底"这件事。
 */
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'

import { openExternalFromHref } from '../utils/externalLinkGuard'

export interface PostVideoInfo {
  url: string
  fallbacks?: string[] | null
  width?: number | null
  height?: number | null
  duration_s?: number | null
}

interface Props {
  video: PostVideoInfo
  /** 封面（作为播放器的 poster；视频帖通常也有封面图） */
  poster?: string | null
  /** 原帖链接（兜底按钮用） */
  permalink?: string | null
}

export default function PostVideo({ video, poster, permalink }: Props) {
  const [idx, setIdx] = useState(0)
  const [dead, setDead] = useState(false)
  const sources = [video.url, ...(video.fallbacks ?? [])].filter(Boolean)
  const src = sources[idx]

  if (dead || !src) {
    return (
      <div className="pv-dead">
        <span>这个视频在当前环境里播不了</span>
        {permalink && (
          <button type="button" className="pv-open"
                  onClick={() => void openExternalFromHref(permalink)}>
            <ExternalLink className="size-3.5" /> 在浏览器打开
          </button>
        )}
      </div>
    )
  }

  return (
    <video
      className="pv-video"
      controls
      playsInline
      preload="metadata"
      poster={poster ?? undefined}
      src={src}
      onError={() => {
        // 换下一条备用流；链走完才认输（别把"这一档解不了"当成"视频坏了"）
        if (idx + 1 < sources.length) setIdx(idx + 1)
        else setDead(true)
      }}
    />
  )
}
