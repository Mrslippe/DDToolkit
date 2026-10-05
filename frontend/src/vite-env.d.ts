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
  /**
   * `1` = 挂载**通知样式调测页**（`dev/NoticeLab.tsx`，2026-10-05）。
   *
   * 为什么要有这个开关：`npm run tauri dev` 起的应用窗口加载的是固定的 `devUrl`，
   * **加不了查询串**，而"我想看所有通知样式"这件事正是要在那个窗口里做
   * （样式、动效、`prefers-reduced-motion` 都在那里才是真的）。
   * 用法：`frontend/.env.local` 里写 `VITE_NOTICE_LAB=1`（该文件已被 git 忽略），刷新窗口即可。
   */
  readonly VITE_NOTICE_LAB?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
