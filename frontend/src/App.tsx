import { useEffect } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import TopBar from './components/TopBar'
import IconRail from './components/IconRail'
import VtuberSidebar from './components/VtuberSidebar'
import EmptyState from './pages/EmptyState'
import PostsPage from './pages/PostsPage'
import ErrorBoundary from './components/ErrorBoundary'
import { useIsMaximized } from './hooks/useIsMaximized'
import { clearShellState, loadShellState, shouldRestoreFromTray } from './utils/shellState'
import './styles/layout.css'

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

  return (
    <div className="app-shell">
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
    </div>
  )
}