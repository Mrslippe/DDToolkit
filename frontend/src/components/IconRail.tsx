import { useState } from 'react'
import { useNavigate, useLocation, matchPath } from 'react-router-dom'
import { BarChart3, FileText, Focus, Plus, Settings } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import AppSettingsDialog from './AppSettingsDialog'
import ModulePickerDialog from './ModulePickerDialog'
import { exitSolo, useSolo } from '../utils/soloMode'
import { usePrefs } from '../hooks/usePrefs'
import { APP_MODULES, enabledModules } from '../utils/modules'
import { requestViewChange } from '../utils/viewTransition'
import './../styles/layout.css'

/**
 * 最左侧工具栏（源自 Pixso 导出 Frame4172；导出稿已删，内容见 `docs/frontend/UI-MAP.md` A2）：
 * 深蓝灰 #4b5a6f 通栏单元格；未选中整钮 opacity .6，选中实底 #647489 全亮。
 *
 * 2026-09-08（用户）：**移除未接线的占位图标**（用户 / 日历 / 刷新 / 设置）——
 * 只保留已接真实行为的「帖子浏览」；后续功能落地时再加回，避免点了没反应的假入口。
 *
 * 2026-10-18（用户）：**上半组底部加一枚「+」**，点开弹窗勾选要显示的模块；
 * 确认后模块按钮出现在上半组里，点它进模块。模块清单在 `utils/modules.ts` ——
 * **不在这里写死**，那正是以前只有三个硬编码入口的原因。
 * 「+」**常驻**（这是唯一的添加入口，藏起来就又变成"找不到"）。
 */

/** 模块 key → 图标。新增模块时在这里补一行（缺了会给默认图标）。 */
const MODULE_ICONS: Record<string, typeof BarChart3> = {
  fan_workbench: BarChart3,
}

export default function IconRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const solo = useSolo()
  /* `usePrefs` 每次调用各拉一次偏好；这里那一次很便宜（`GET /settings/prefs`），
     换来的是"开关一改、入口立刻出现/消失"，不用重启。 */
  const prefs = usePrefs()
  const modules = enabledModules(prefs.values)

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

  /** 确认添加/移除：一次写回全部模块的开关。失败时**不关窗**，把原因留在弹窗里。 */
  const applyModules = async (next: Record<string, string>) => {
    setPickerError(null)
    try {
      const changed = Object.keys(next).filter((k) => (prefs.values[k] ?? 'off') !== next[k])
      for (const key of changed) {
        await prefs.setPref(key, next[key])
      }
    } catch (e) {
      setPickerError(`保存失败：${(e as Error).message}`)
      throw e
    }
  }

  return (
    <nav className="icon-rail">
      <div className="icon-rail-group">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`icon-rail-btn${postsActive ? ' active' : ''}`}
              aria-label="帖子浏览"
              data-testid="rail-posts"
              /* 单推时 `/` 没有内容（只有"选一个 V"的空态）⇒ 直接去单推那个 V，
                 免得点了被下面的重定向弹回来（看着像"按钮坏了"） */
              onClick={() => requestViewChange(() => navigate(solo ? `/vtubers/${solo.id}` : '/'))}
            >
              <FileText className="h-[18px] w-[14px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">帖子浏览</TooltipContent>
        </Tooltip>

        {/* 已添加的模块（顺序同注册表） */}
        {modules.map((m) => {
          const Icon = MODULE_ICONS[m.key] ?? BarChart3
          const active = matchPath(m.route, location.pathname) !== null
            || location.pathname.startsWith(`${m.route}/`)
          return (
            <Tooltip key={m.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={`icon-rail-btn${active ? ' active' : ''}`}
                  aria-label={m.label}
                  data-testid={`rail-module-${m.key}`}
                  onClick={() => requestViewChange(() => navigate(m.route))}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{m.label}</TooltipContent>
            </Tooltip>
          )
        })}

        {/* 上半组的**最下方**：添加模块（用户指定位置）。常驻。 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="icon-rail-btn"
              aria-label="添加模块"
              data-testid="rail-add-module"
              onClick={() => { setPickerError(null); setPickerOpen(true) }}
            >
              <Plus className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">添加模块</TooltipContent>
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
      <ModulePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        values={prefs.values}
        onConfirm={applyModules}
        error={pickerError}
      />
    </nav>
  )
}

export { APP_MODULES }
