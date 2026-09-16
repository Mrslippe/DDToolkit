import { useEffect } from 'react'
import { checkForUpdate, isDesktopShell } from '../utils/shellBridge'

/**
 * 启动后**静默**查一次更新（R23b，devlog/114）。
 *
 * 用户口径（2026-09-16）：**启动后静默查一次 + 关于页手动**。
 *
 * 四条克制：
 * - **延迟 15 秒**再查：启动那几秒要留给后端就绪与首屏渲染，别抢带宽；
 * - **失败只写 console**：连不上 github 在国内是常态，为它弹提示只会让人烦；
 *   手动点「检查更新」时才会把失败原因显示出来；
 * - 发现新版本时**只发一条状态岛瞬时消息**（复用现成通道），真正的下载/安装留在关于页
 *   —— 更新是"用户决定"的事，不该自己动手；
 * - **便携版照常查**（知道有新版本有用），只是关于页不给自我更新入口。
 */
const DELAY_MS = 15000

export function useUpdateCheck(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isDesktopShell()) return
    let alive = true
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const info = await checkForUpdate()
          if (!alive || !info) return
          window.dispatchEvent(new CustomEvent('ddtoolkit:pill-message', {
            detail: { text: `发现新版本 v${info.version} —— 设置 → 关于 可查看并更新` },
          }))
        } catch (e) {
          // 静默：国内连不上 github 是常态；只有用户主动检查时才需要看到原因
          console.warn('[ddtoolkit] 启动时检查更新失败（已忽略）:', e)
        }
      })()
    }, DELAY_MS)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [enabled])
}
