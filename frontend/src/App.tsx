import { Route, Routes } from 'react-router-dom'
import TopBar from './components/TopBar'
import IconRail from './components/IconRail'
import VtuberSidebar from './components/VtuberSidebar'
import EmptyState from './pages/EmptyState'
import PostsPage from './pages/PostsPage'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/layout.css'

/**
 * 应用壳布局（参照设计稿 Frame1672）：
 * 顶栏常驻；左起依次为工具图标栏、VTuber 列表栏（均常驻）；
 * 右栏由路由驱动 —— `/` 空置界面，`/vtubers/:id` 帖子面板。
 */
export default function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <IconRail />
        <VtuberSidebar />
        <main className="app-main">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<EmptyState />} />
              <Route path="/vtubers/:id" element={<PostsPage />} />
              <Route path="*" element={<EmptyState />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
