import { useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { normalizeImageUrl } from '../../utils/format'
import { initialImageSrc, needsProxyFromStart, proxiedImageSrc } from '../../utils/imageHost'

type Stage = 'direct' | 'proxy' | 'failed'

interface Props {
  src?: string | null
  alt?: string
  className?: string
  style?: React.CSSProperties
  /** 图片宽度（px），同时作为无 src 占位块尺寸 */
  width?: number
  height?: number
  /**
   * 无图 / 三次加载都失败时渲染的内容（默认灰色图标块）。
   * 传入后由调用方接管占位外观，例如场次封面用「渐变底 + 标题首字」。
   */
  fallback?: React.ReactNode
  /** fallback 的类名（缺省沿用 className） */
  fallbackClassName?: string
  /** 透传原生 draggable（灯箱大图置 false 防拖拽选中） */
  draggable?: boolean
}

/**
 * 混合图片方案（devlog/015，全站唯一图片元件）：
 * 1. 默认直连 CDN（https 化 + no-referrer）—— 性能最优；
 *    微博图床(sinaimg/wbcdn)防盗链对应用自身来源一律 403，直接起点走代理
 * 2. onError 自动重试后端代理 /img-proxy（带磁盘缓存）—— 兜底
 * 3. 代理也失败 → 渲染 fallback（默认占位块），不再出现破图
 * 大图查看统一由 ImageViewer（P6-4 独立灯箱）承担，此处不再内置预览。
 *
 * 2026-09 P0/P1 收敛：原 LiveCalendar 内部 CoverImage 已并入本组件（消除同状态机双实现，
 * 并补上其缺失的微博直连代理分支）；换图场景由调用方 key={src} 重置状态。
 *
 * R46（2026-09-28，devlog/249）：**头像也必须走本组件**（左栏此前是 radix `Avatar` 的裸
 * `<img>`，微博图床防盗链一律 403 ⇒ 右栏换了头像、左栏还灰着）。规则本身抽到
 * `utils/imageHost`（`initialImageSrc`），并由 `utils/avatarRender.test.ts` 钉住
 * "不许有第二个渲染器、不许有第二条代理规则"。
 */
export default function ProxyImage({
  src,
  alt,
  className,
  style,
  width,
  height,
  fallback,
  fallbackClassName,
  draggable,
}: Props) {
  const direct = src ? normalizeImageUrl(src) : undefined
  const proxy = proxiedImageSrc(src)
  // 微博图床(sinaimg/wbcdn)防盗链对应用自身来源一律 403：直连注定失败，
  // 初始 stage 直接走代理（img-proxy 已按主机带 weibo.com Referer，可正常拉取）。
  // ⚠️ "哪些主机要代理"的判断在 `utils/imageHost`（唯一落点，R46/devlog/249）——
  //    组件里**不许**再列一遍主机名，否则左右栏又会各走各的。
  const needProxyFromStart = needsProxyFromStart(direct)
  const [stage, setStage] = useState<Stage>(needProxyFromStart ? 'proxy' : 'direct')
  const current = stage === 'direct' ? direct : stage === 'proxy' ? proxy : undefined
  // 首帧**决定**要用的那个 src（与加载成败无关）—— 挂在输出节点上供探针读：
  // 虚拟时间下图片可能加载不成功而回落到 fallback（那时 `<img>` 已不在 DOM 里），
  // 但"左右栏对同一个 URL 做出的渲染决策是否一致"正是 R46 要断的东西。
  const renderSrc = initialImageSrc(src)

  if (!current) {
    if (fallback !== undefined) {
      return (
        <span className={fallbackClassName ?? className} style={style} data-render-src={renderSrc}>
          {fallback}
        </span>
      )
    }
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
      data-render-src={renderSrc}
      style={{
        width,
        height,
        ...style,
      }}
      referrerPolicy="no-referrer"
      loading="lazy"
      draggable={draggable}
      onError={() => {
        if (stage === 'direct') setStage('proxy')
        else setStage('failed')
      }}
    />
  )
}
