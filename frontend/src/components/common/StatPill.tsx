import pillBilibili from '../../assets/pills/bilibili.png'
import pillWeibo from '../../assets/pills/weibo.png'
import { formatCount } from '../../utils/format'

/** 平台药丸图像底：按平台映射 docs/design/pills 资产；未知平台回退粉/珊瑚色底 */
const PILL_BG: Record<string, string> = {
  bilibili: pillBilibili,
  weibo: pillWeibo,
}

interface Props {
  /** 平台标识（bilibili / weibo …）：命中则用图像底，未命中走粉/珊瑚交替 */
  platform?: string
  /** 粉丝数（万/亿 缩写，数字 ≤4 位） */
  value: number | null | undefined
  /** 无图像底时的粉/珊瑚交替序号（展示页按集内顺序传入） */
  index?: number
  title?: string
  /** P8-B：点击（打开账号主页）；拖拽重排由父级容器统一处理 */
  onClick?: () => void
  /** P8-B：拖拽中（视觉反馈：半透明 + 抬起） */
  dragging?: boolean
  /** P8-B：容器用来定位落点（data 属性的值） */
  dataIndex?: number
  onPointerDown?: (e: React.PointerEvent) => void
}

/**
 * 平台粉丝药丸（191×37 图像底 / 色底，docs/UI-MAP.md §C5 信息层）。
 * 数值右对齐、数字 ≤4 位、图像底补 text-shadow 保可读（用户 2026-09-05 定案）。
 * P8-B：可点击（打开账号主页）+ 可长按拖动重排（父级容器驱动）。
 */
export default function StatPill({
  platform,
  value,
  index = 0,
  title,
  onClick,
  dragging = false,
  dataIndex,
  onPointerDown,
}: Props) {
  const bg = platform ? PILL_BG[platform] : undefined
  const tone = bg ? ' image' : index % 2 === 0 ? ' pink' : ' coral'
  const clickable = typeof onClick === 'function'
  return (
    <div
      className={`stat-pill${tone}${clickable ? ' is-link' : ''}${dragging ? ' is-dragging' : ''}`}
      style={bg ? { backgroundImage: `url(${bg})` } : undefined}
      title={title ?? (platform ? `${platform} 粉丝数` : undefined)}
      data-pill-index={dataIndex}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
    >
      <span className="pill-value">{formatCount(value)}</span>
    </div>
  )
}
