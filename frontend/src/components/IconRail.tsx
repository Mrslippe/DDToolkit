import { useNavigate, useLocation, matchPath } from 'react-router-dom'
import {
  CalendarDays,
  FileText,
  RotateCw,
  Settings,
  User,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { ReactNode } from 'react'
import './../styles/layout.css'

interface RailItem {
  key: string
  icon: ReactNode
  title: string
  /** true = 接真实行为；false = 占位（开发中） */
  wired?: boolean
}

/** 图标视觉尺寸随 50×50 紧凑栏等比缩放（原 79 栏 ×0.63 取整）；帖子居首位 */
const TOP_ITEMS: RailItem[] = [
  {
    key: 'posts',
    icon: <FileText className="h-[18px] w-[14px]" />,
    title: '帖子浏览',
    wired: true,
  },
  { key: 'user', icon: <User className="h-[20px] w-[18px]" />, title: '用户 · 开发中' },
  { key: 'calendar', icon: <CalendarDays className="size-[20px]" />, title: '日历 · 开发中' },
]

const BOTTOM_ITEMS: RailItem[] = [
  { key: 'refresh', icon: <RotateCw className="size-[19px]" />, title: '刷新 · 开发中' },
  { key: 'settings', icon: <Settings className="size-[22px]" />, title: '设置 · 开发中' },
]

/**
 * 最左侧工具栏（严格按 docs/design/react-IconRail Frame4172）：
 * 深蓝灰 #4b5a6f 通栏单元格 79×79；未选中整钮 opacity .6，
 * 选中实底 #647489 全亮。顶部功能组 + 底部工具组贴底。
 */
export default function IconRail() {
  const navigate = useNavigate()
  const location = useLocation()

  // 帖子入口高亮：当前应用唯一界面即「侧栏+内容主栏」，路由恒匹配；
  // 未来新增页面时此判断自动收窄
  const postsActive =
    matchPath('/', location.pathname) !== null ||
    matchPath('/vtubers/:id', location.pathname) !== null

  const renderItem = (item: RailItem) => (
    <Tooltip key={item.key}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`icon-rail-btn${item.key === 'posts' && postsActive ? ' active' : ''}`}
          aria-label={item.title}
          onClick={item.wired && item.key === 'posts' ? () => navigate('/') : undefined}
        >
          {item.icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{item.title}</TooltipContent>
    </Tooltip>
  )

  return (
    <nav className="icon-rail">
      <div className="icon-rail-group">{TOP_ITEMS.map(renderItem)}</div>
      <div className="icon-rail-spacer" />
      <div className="icon-rail-group">{BOTTOM_ITEMS.map(renderItem)}</div>
    </nav>
  )
}
