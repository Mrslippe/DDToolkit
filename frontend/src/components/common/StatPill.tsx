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
}

/**
 * 平台粉丝药丸（191×37 图像底 / 色底，docs/UI-MAP.md §C5 信息层）。
 * 数值右对齐、数字 ≤4 位、图像底补 text-shadow 保可读（用户 2026-09-05 定案）。
 */
export default function StatPill({ platform, value, index = 0, title }: Props) {
  const bg = platform ? PILL_BG[platform] : undefined
  const tone = bg ? ' image' : index % 2 === 0 ? ' pink' : ' coral'
  return (
    <div
      className={`stat-pill${tone}`}
      style={bg ? { backgroundImage: `url(${bg})` } : undefined}
      title={title ?? (platform ? `${platform} 粉丝数` : undefined)}
    >
      <span className="pill-value">{formatCount(value)}</span>
    </div>
  )
}
