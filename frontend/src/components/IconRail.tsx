import { useNavigate, useLocation, matchPath } from 'react-router-dom'
import { FileText } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import './../styles/layout.css'

/**
 * 最左侧工具栏（严格按 docs/design/react-IconRail Frame4172）：
 * 深蓝灰 #4b5a6f 通栏单元格；未选中整钮 opacity .6，选中实底 #647489 全亮。
 *
 * 2026-09-08（用户）：**移除未接线的占位图标**（用户 / 日历 / 刷新 / 设置）——
 * 只保留已接真实行为的「帖子浏览」；后续功能落地时再加回，避免点了没反应的假入口。
 */
export default function IconRail() {
  const navigate = useNavigate()
  const location = useLocation()

  // 帖子入口高亮：当前应用唯一界面即「侧栏+内容主栏」，路由恒匹配；
  // 未来新增页面时此判断自动收窄
  const postsActive =
    matchPath('/', location.pathname) !== null ||
    matchPath('/vtubers/:id', location.pathname) !== null

  return (
    <nav className="icon-rail">
      <div className="icon-rail-group">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`icon-rail-btn${postsActive ? ' active' : ''}`}
              aria-label="帖子浏览"
              onClick={() => navigate('/')}
            >
              <FileText className="h-[18px] w-[14px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">帖子浏览</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
