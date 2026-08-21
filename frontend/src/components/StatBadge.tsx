import type { ReactNode } from 'react'
import { formatCount } from '../utils/format'
import './../styles/posts.css'

interface Props {
  icon?: ReactNode
  value?: number | null
  label?: string
}

/** 统计徽章（设计稿 "29.2万" 圆角胶囊样式） */
export default function StatBadge({ icon, value, label }: Props) {
  if (value === undefined || value === null) return null
  return (
    <span className="stat-badge" title={label ? `${label} ${value}` : String(value)}>
      {icon}
      {formatCount(value)}
    </span>
  )
}
