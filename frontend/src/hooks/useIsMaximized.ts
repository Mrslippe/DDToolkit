import { useEffect, useState } from 'react'

const isTauri = '__TAURI_INTERNALS__' in window

/**
 * 桌面端最大化状态跟踪：onResized 触发时重查 isMaximized。
 * 原 App.tsx（挂 html.window-maximized 类）与 TopBar.tsx（切换 还原/最大化 图标）
 * 各实现一份、各注册一个 onResized 监听；抽为共享 hook 后两处复用。
 */
export function useIsMaximized(): boolean {
  const [isMax, setIsMax] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    let unlisten: (() => void) | undefined

    const update = () => {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        if (disposed) return
        void getCurrentWindow().isMaximized().then(setIsMax)
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

  return isMax
}