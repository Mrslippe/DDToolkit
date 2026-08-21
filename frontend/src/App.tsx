import { useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import TopBar from './components/TopBar'
import IconRail from './components/IconRail'
import VtuberSidebar from './components/VtuberSidebar'
import EmptyState from './pages/EmptyState'
import PostsPage from './pages/PostsPage'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/layout.css'

const isTauri = '__TAURI_INTERNALS__' in window

/** 桌面端：最大化时给 html 挂 window-maximized 类，壳层圆角随之取消 */
function useMaximizedClass() {
  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    let unlisten: (() => void) | undefined

    const update = () => {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        if (disposed) return
        void getCurrentWindow()
          .isMaximized()
          .then((max) =>
            document.documentElement.classList.toggle('window-maximized', max),
          )
      })
    }

    update()
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (disposed) return
      void getCurrentWindow()
        .onResized(update)
        .then((u) => {
          unlisten = u
        })
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}

/**
 * 应用壳布局（参照设计稿 Frame1672）：
 * 顶栏常驻；左起依次为工具图标栏、VTuber 列表栏（均常驻）；
 * 右栏由路由驱动 —— `/` 空置界面，`/vtubers/:id` 帖子面板。
 */
export default function App() {
  useMaximizedClass()
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
