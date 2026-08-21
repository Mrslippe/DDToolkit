import { Layout, Typography } from 'antd'
import { Route, Routes } from 'react-router-dom'
import VtuberListPage from './pages/VtuberListPage'
import PostsPage from './pages/PostsPage'
import ErrorBoundary from './components/ErrorBoundary'

const { Header, Content } = Layout

export default function App() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center' }}>
        <Typography.Title level={4} style={{ color: '#fff', margin: 0 }}>
          Better DD Toolkit · VTuber 帖子查看
        </Typography.Title>
      </Header>
      <Content style={{ padding: 24, maxWidth: 1280, width: '100%', margin: '0 auto' }}>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<VtuberListPage />} />
            <Route path="/vtubers/:id" element={<PostsPage />} />
            <Route path="*" element={<VtuberListPage />} />
          </Routes>
        </ErrorBoundary>
      </Content>
    </Layout>
  )
}
