/// <reference types="vite/client" />

interface Window {
  /** index.html 启动诊断：追加一条日志（异常/拒绝自动进入） */
  __bootLog?: (msg: string) => void
  /** 折叠诊断面板（React 就绪后调用，保留徽章待查） */
  __bootFold?: () => void
}

interface ImportMetaEnv {
  /** 后端直连地址（可选；缺省走 Vite 代理 /api） */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
