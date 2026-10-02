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
import { reportUserError } from '../utils/problemReport'

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
  const direct = [video.url, ...(video.fallbacks ?? [])].filter(Boolean)
  /**
   * 直连失败后走**本机代理**（`/video-proxy`，同源、不带 Referer）。
   *
   * 为什么需要这条兜底（2026-10-02 真机实测，devlog/281）：小红书 CDN 对**任何带 Referer
   * 的请求**回 **403**，而 WebView 加载媒体子资源必然带 Referer ⇒ 直连在某些宿主上必失败；
   * 代理由后端发请求（头由我们控制、不带 Referer），且同源 ⇒ CSP 的 `media-src 'self'` 放行。
   */
  const proxied = direct.map((u) => `/video-proxy?url=${encodeURIComponent(u)}`)
  const sources = [...direct, ...proxied]
  const src = sources[idx]

  if (dead || !src) {
    // 全部源都失败 —— 这时才值得惊动用户（前面每一步失败都是链的正常一环）
    reportUserError('视频播放', `全部播放源都失败（含本机代理）：${sources[0] ?? ''}`,
                    { kind: 'resource' })
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
    /**
     * `data-self-healing`：告诉全局错误陷阱（`bootDiag`）**这一块自己会恢复** ——
     * 直连被平台 CDN 拒（小红书见 Referer 就 403）是播放链的**正常一步**，不该被当成
     * "资源加载失败"报到用户面前（2026-10-03 实测：视频照常播，报告里却攒了 6 条 403）。
     * 真播不了时由上面那张兜底卡主动报一条。
     */
    <div className="pv-wrap" data-self-healing="1">
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
    </div>
  )
}
