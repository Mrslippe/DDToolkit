/**
 * 启动期一次性标记（后端 `/healthz` 的 `first_run` 落到前端）。
 *
 * 用途：首次启动时 TopBar 自动弹出登录浮窗（用户 2026-09-08 需求）。
 * 不落 localStorage——数据目录里的 `.first-run-done` 才是唯一事实来源，
 * 前端只在本次会话内传递。
 */
let firstRun = false

export function markFirstRun(): void {
  firstRun = true
}

export function isFirstRun(): boolean {
  return firstRun
}
