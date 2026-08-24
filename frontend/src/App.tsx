import { useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import TopBar from './components/TopBar'
import IconRail from './components/IconRail'
import VtuberSidebar from './components/VtuberSidebar'
import EmptyState from './pages/EmptyState'
import PostsPage from './pages/PostsPage'
import ErrorBoundary from './components/ErrorBoundary'
import { useIsMaximized } from './hooks/useIsMaximized'
import './styles/layout.css'

/**
 * 应用壳布局（参照设计稿 Frame1672）：
 * 顶栏常驻；左起依次为工具图标栏、VTuber 列表栏（均常驻）；
 * 右栏由路由驱动 —— `/` 空置界面，`/vtubers/:id` 帖子面板。
 * ErrorBoundary 包住整个壳层：TopBar/Sidebar 抛错也不会白屏。
 */
export default function App() {
  const isMax = useIsMaximized()
  // 最大化时给 html 挂 window-maximized 类，壳层圆角随之取消
  useEffect(() => {
    document.documentElement.classList.toggle('window-maximized', isMax)
  }, [isMax])

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