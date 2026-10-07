import { useEffect, useState } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import TopBar from './components/TopBar'
import IconRail from './components/IconRail'
import { useSolo } from './utils/soloMode'
import { useSoloPeek } from './utils/soloPeek'
import VtuberSidebar from './components/VtuberSidebar'
import EmptyState from './pages/EmptyState'
import PostsPage from './pages/PostsPage'
import ErrorBoundary from './components/ErrorBoundary'
import LegalNotice from './components/LegalNotice'
import { api } from './api/api'
import type { AgreementState } from './api/types'
import { useIsMaximized } from './hooks/useIsMaximized'
import { clearShellState, loadShellState, shouldRestoreFromTray } from './utils/shellState'
import './styles/layout.css'
import './styles/status-island.css'

/**
 * 应用壳布局（参照设计稿 Frame1672）：
 * 顶栏常驻；左起依次为工具图标栏、VTuber 列表栏（均常驻）；
 * 右栏由路由驱动 —— `/` 空置界面，`/vtubers/:id` 帖子面板。
 * ErrorBoundary 包住整个壳层：TopBar/Sidebar 抛错也不会白屏。
 */
export default function App() {
  const isMax = useIsMaximized()
  const navigate = useNavigate()
  // 最大化时给 html 挂 window-maximized 类，壳层圆角随之取消
  useEffect(() => {
    document.documentElement.classList.toggle('window-maximized', isMax)
  }, [isMax])

  /**
   * 深休眠唤醒后回到离开的位置（R18，devlog/095）。
   *
   * 链路：隐藏 10 分钟后 Rust 销毁 WebView 释放内存 → 唤回时**重建窗口**并加载
   * `index.html?restored=1`（不是深链接：SPA 的深链接在资源协议下会 404）→
   * 这里读到标记后，把存下来的路由/视图**校验过**再恢复。
   *
   * 三处刻意的谨慎：① 只在带标记时恢复（正常启动仍从首页开始）；
   * ② 路径与视图都过 `sanitize*`（坏值一律当"没存过"）；③ 恢复后立刻清掉现场，
   * 免得下次正常启动又被"上一次的位置"劫持。
   */
  useEffect(() => {
    if (!shouldRestoreFromTray(window.location.search)) return
    const saved = loadShellState(Date.now())
    clearShellState()
    if (saved && saved.view) window.sessionStorage.setItem('ddtoolkit.restore-view', saved.view)
    if (saved) navigate(saved.route, { replace: true })
  }, [navigate])

  /**
   * **用户协议闸门**（2026-10-06，用户口径）：「第一次启动应用或者更新至这个版本时，都要阅读
   * 一个用户协议或者公告……阅读完同意才可以关闭窗口」。判定在后端（要同意的版本 = 应用版本，
   * 同意状态存 `app_meta`）—— 这里只做两件事：**启动时问一次**、**needed 就挡住整个应用**。
   *
   * ⚠️ 取不到时**不放行也不报错**：启动那几秒后端可能还没起来（壳会先显示揭幕幕），
   *    所以带一个**有上限的轮询**（最多 ~1 分钟）。宁可晚几秒弹，也不假装"读过协议了"。
   */
  const [agreement, setAgreement] = useState<AgreementState | null>(null)
  useEffect(() => {
    let alive = true
    let tries = 0
    let timer: number | undefined
    const ask = async () => {
      try {
        const got = await api.getAgreement()
        if (alive) setAgreement(got)
      } catch {
        tries += 1
        if (alive && tries < 12) timer = window.setTimeout(() => void ask(), 5000)
      }
    }
    void ask()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [])

  const solo = useSolo()
  /**
   * 单推的 hover 唤出（按**坐标**判定，`devlog/433`）。
   *
   * 前两版分别用 CSS `:hover` 与"指针落在哪个元素上"——都栽在同一件事上：
   * 唤出**会改变布局**（工具栏回来把内容推走）⇒ 指针下的元素跟着变 ⇒ 状态来回翻
   * （用户报的"界面元素快速闪动 + 卡顿"），而且左侧工具栏干脆唤不出来。
   * 现在 `mousemove` 只看 `clientX/clientY`：**与遮挡、层级、布局位移全都无关**，
   * 判定逻辑在 `utils/soloPeek.ts`（有单测）。唤出后那个区会"长大"到该栏自身的大小，
   * 免得指针一移进去就掉出薄条、栏又从手底下消失。
   */
  const peek = useSoloPeek(Boolean(solo))

  return (
    /* 单推模式的标记挂在这里：三段收起动画与 hover 唤出全走 CSS（`devlog/430`/`433`） */
    <div className="app-shell" data-solo={solo ? '1' : undefined}
         data-peek={solo ? peek : undefined}>
      {/* ⚠️ 两条**贴边窄带**：尺寸 = 被唤出的元素自身（顶栏高 / 工具栏宽），
          悬到它们所在的整片区域就唤出。唤出期间它们 `pointer-events: none` 让位（CSS 里）。 */}
      <ErrorBoundary>
        <TopBar />
        <div className="app-body">
          <IconRail />
          <VtuberSidebar />
          <main className="app-main">
            <Routes>
              <Route path="/" element={<EmptyState />} />
              <Route path="/vtubers/:id" element={<PostsPage />} />
              <Route path="*" element={<EmptyState />} />
            </Routes>
          </main>
        </div>
      </ErrorBoundary>
      {/* ⚠️ **闸门放在 ErrorBoundary 之外**：壳层炸了也要先能读到协议（它不该被别人的错误吞掉） */}
      {agreement?.needed && (
        <LegalNotice version={agreement.required}
                     appVersion={agreement.app_version}
                     onAccepted={() => setAgreement({ ...agreement, needed: false,
                                                      accepted: agreement.required })} />
      )}
    </div>
  )
}
