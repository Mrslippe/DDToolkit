import { useState } from 'react'
import { useNavigate, useLocation, matchPath } from 'react-router-dom'
import { FileText, Focus, Settings } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import AppSettingsDialog from './AppSettingsDialog'
import { exitSolo, useSolo } from '../utils/soloMode'
import './../styles/layout.css'

/**
 * 最左侧工具栏（源自 Pixso 导出 Frame4172；导出稿已删，内容见 `docs/frontend/UI-MAP.md` A2）：
 * 深蓝灰 #4b5a6f 通栏单元格；未选中整钮 opacity .6，选中实底 #647489 全亮。
 *
 * 2026-09-08（用户）：**移除未接线的占位图标**（用户 / 日历 / 刷新 / 设置）——
 * 只保留已接真实行为的「帖子浏览」；后续功能落地时再加回，避免点了没反应的假入口。
 * 2026-09-15（R14a，devlog/091）：底端加回**齿轮**——设置界面真的落地了，
 * 所以才允许它出现（口径：占位图标不许有，已接线的入口必须有）。
 * 2026-10-07（需求 6，devlog/429）：齿轮**上方**加「单推」——用户指定的位置
 * （「放在最左侧工具栏底部，设置图标上方」）。它是**切换钮**：进去一次、再点一次退出。
 */
export default function IconRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const solo = useSolo()

  // 帖子入口高亮：当前应用唯一界面即「侧栏+内容主栏」，路由恒匹配；
  // 未来新增页面时此判断自动收窄
  const postsActive =
    matchPath('/', location.pathname) !== null ||
    matchPath('/vtubers/:id', location.pathname) !== null

  /** 这枚按钮现在**只负责退出**（进入 = 左栏首位连点 10 次，见 `VtuberSidebar`）。 */
  const toggleSolo = () => {
    const prev = exitSolo()
    navigate(prev?.prevRoute ?? '/')
  }

  const soloTitle = '退出单推（回到进入前的位置）'

  return (
    <nav className="icon-rail">
      <div className="icon-rail-group">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`icon-rail-btn${postsActive ? ' active' : ''}`}
              aria-label="帖子浏览"
              /* 单推时 `/` 没有内容（只有"选一个 V"的空态）⇒ 直接去单推那个 V，
                 免得点了被下面的重定向弹回来（看着像"按钮坏了"） */
              onClick={() => navigate(solo ? `/vtubers/${solo.id}` : '/')}
            >
              <FileText className="h-[18px] w-[14px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">帖子浏览</TooltipContent>
        </Tooltip>
      </div>

      {/* 底端：设置（R14a）。放在 rail 底部而不是顶部，是为了让"打开设置"与
          "切换内容视图"在位置上就分开 —— 前者是低频、全局的动作。
          单推钮紧挨齿轮上方（用户指定），同属"低频、全局"。
          ⚠️ **只在单推模式下渲染**（需求 1，2026-10-08 用户口径，`devlog/450`）：
          **进入**单推改成"拖到左栏首位 + 3 秒内连点 10 次"（见 `VtuberSidebar`），
          这枚按钮从此**只负责退出**；正常模式下它不该出现在工具栏上。 */}
      <div className="icon-rail-group icon-rail-bottom">
        {solo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="icon-rail-btn active"
                aria-label="退出单推"
                aria-pressed
                data-testid="solo-toggle"
                onClick={toggleSolo}
              >
                <Focus className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{soloTitle}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="icon-rail-btn"
              aria-label="设置"
              data-testid="app-settings-gear"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">设置</TooltipContent>
        </Tooltip>
      </div>

      <AppSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </nav>
  )
}
