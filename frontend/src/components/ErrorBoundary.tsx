import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

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
        <div className="mx-auto max-w-[720px] p-12">
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-600"
          >
            <div className="flex items-center gap-2 font-medium">页面渲染出错</div>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-red-500/90">
              {this.state.error.message}
            </pre>
          </div>
          <div className="mt-4">
            <Button
              size="sm"
              onClick={() => {
                this.setState({ error: null })
                window.location.reload()
              }}
            >
              重新加载
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
