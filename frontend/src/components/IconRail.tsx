import type { ReactNode } from 'react'
import { LayoutGrid } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import './../styles/layout.css'

interface RailItem {
  key: string
  icon: ReactNode
  title: string
}

/** 工具栏入口：后续新增功能时在此扩展 */
const RAIL_ITEMS: RailItem[] = [
  { key: 'posts', icon: <LayoutGrid className="size-[18px]" />, title: '帖子浏览' },
]

/**
 * 最左侧工具栏（设计稿 16_107）：功能入口图标列。
 * 当前仅一个占位图标，新功能加入时扩展 RAIL_ITEMS 并接入路由。
 */
export default function IconRail() {
  return (
    <nav className="icon-rail">
      {RAIL_ITEMS.map((item, i) => (
        <Tooltip key={item.key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`icon-rail-btn${i === 0 ? ' active' : ''}`}
              aria-label={item.title}
            >
              {item.icon}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{item.title}</TooltipContent>
        </Tooltip>
      ))}
    </nav>
  )
}
