/// <reference types="vite/client" />

interface Window {
  /** 启动期日志钩子（异常/拒绝/console.error 自动进入）：追加一条 */
  __bootLog?: (msg: string) => void
  /** 启动时间线原始行（问题报告据此附上"启动到出错之间发生了什么"） */
  __bootTrail?: () => string[]
  /** 收起问题报告面板（React 就绪后调用；面板默认本就收起，钩子留给调用方） */
  __bootFold?: () => void
}

interface ImportMetaEnv {
  /** 后端直连地址（可选；缺省走 Vite 代理 /api） */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
