import { useEffect, useState } from 'react'
import { api } from '../api/api'
import { setTrayStatus } from '../utils/shellBridge'
import { trayStatusText, type TrayRateLimit } from '../utils/trayStatus'
import { useShellHidden } from './useShellHidden'

/**
 * 把「风控冷却」同步到**托盘**（R29，devlog/129）。
 *
 * 背景：冷却已经做进了顶栏状态岛，但**窗口收进托盘后没人看界面** ——
 * 用户既不知道被限流、也不知道还要等多久。壳那边有现成落点（托盘 tooltip + 菜单项
 * `status`），本 hook 只负责"什么时候把哪句话送过去"：
 *
 * - **可见时**：直接用界面已有的 `fetch-status`（`visibleRateLimit`，2s 级轮询）⇒ 与状态岛同步；
 * - **隐藏时**：顶栏那条 2s 轮询已经被 `useShellHidden` 停掉（R18 的停表口径），
 *   所以这里起一个 **60s 心跳**，只为了托盘上那行字不过期。
 *
 * ⚠️ **隐藏时刻意不立刻打第一发**：隐藏那一刻界面刚同步过（≤2s 旧），而 R18 的停表判据
 * （探针 `--tray-suspend`）就看"隐藏后这段时间里有没有请求"—— 第一节拍放在 60s 后，
 * 判据与体验两不误。这条口径写进 `ARCHITECTURE.md` §3.10。
 */
const HIDDEN_HEARTBEAT_MS = 60_000

export function useTrayStatus(visibleRateLimit: TrayRateLimit | null | undefined): void {
  const hidden = useShellHidden()
  const [polled, setPolled] = useState<TrayRateLimit | null>(null)

  useEffect(() => {
    if (!hidden) return
    let alive = true
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const st = await api.getFetchStatus()
          if (alive) setPolled(st?.rate_limit ?? null)
        } catch {
          /* 静默：托盘文案是提示，拿不到就维持上一句 */
        }
      })()
    }, HIDDEN_HEARTBEAT_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
      setPolled(null)          // 回可见后交给界面那条轮询，别留旧值
    }
  }, [hidden])

  const text = hidden ? trayStatusText(polled) : trayStatusText(visibleRateLimit)
  useEffect(() => {
    void setTrayStatus(text)
  }, [text])
}
