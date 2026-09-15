import { invoke } from '@tauri-apps/api/core'
import { setShellHidden } from '../utils/shellLifecycle'
import { saveShellState, currentViewForState } from './shellState'

/**
 * 桌面外壳桥（R18，devlog/095）：把"隐藏到托盘 / 退出 / 深休眠后恢复"这三件事
 * 收成一个模块，**并且给浏览器/探针环境留可用的退化路径**。
 *
 * 为什么退化路径重要：这套逻辑的主体在 Rust（托盘、拦 CloseRequested、销毁 WebView），
 * 而 `ui_probe` 跑在**无头浏览器**里 —— 没有 Tauri、没有托盘。所以：
 * - 隐藏：浏览器里退化为"把前端切到挂起态"（`setShellHidden(true)`），
 *   于是"隐藏之后该不该继续轮询"这件事**照样能断言**；
 * - 恢复：探针用 dev 钩子直接调 `setShellHidden(false)`；
 * - 退出：浏览器里没有"退出应用"这回事，返回 false 让调用方知道没做成。
 */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 隐藏到托盘（先把"我在哪儿"存下来，供深休眠唤醒后恢复现场） */
export async function hideToTray(route: string): Promise<boolean> {
  // 存现场要**在隐藏之前**：Rust 侧可能过一会儿就把 WebView 销毁掉
  saveShellState(route, currentViewForState(), Date.now())
  setShellHidden(true)
  if (!isTauri) return false
  try {
    await invoke('hide_to_tray')
    return true
  } catch {
    setShellHidden(false)     // 隐藏失败就别装成隐藏了（否则界面永远不刷新）
    return false
  }
}

/** 真退出（Rust 侧会置 quitting 标志再退出，避免又被 CloseRequested 拦下） */
export async function quitApp(): Promise<boolean> {
  if (!isTauri) return false
  try {
    await invoke('quit_app')
    return true
  } catch {
    return false
  }
}

/** 供界面显示"当前是桌面端还是浏览器"（探针/开发时提示用） */
export function isDesktopShell(): boolean {
  return isTauri
}
