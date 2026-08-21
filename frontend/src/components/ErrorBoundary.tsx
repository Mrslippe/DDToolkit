import { Component, type ReactNode } from 'react'
import { Alert, Button } from 'antd'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** 全局错误边界：渲染期异常给出可读提示，避免整页白屏 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('页面渲染异常:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 48, maxWidth: 720, margin: '0 auto' }}>
          <Alert
            type="error"
            showIcon
            message="页面渲染出错"
            description={
              <div>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.error.message}</pre>
                <Button
                  type="primary"
                  size="small"
                  onClick={() => {
                    this.setState({ error: null })
                    window.location.reload()
                  }}
                >
                  重新加载
                </Button>
              </div>
            }
          />
        </div>
      )
    }
    return this.props.children
  }
}
