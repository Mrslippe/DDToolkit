import { useEffect } from 'react'
import { api } from '../api/api'

/**
 * 磁盘快满时提醒一次（R22-B，devlog/104）。
 *
 * 用户口径（2026-09-16）：**状态岛提醒一次 + 关于页显示**，阈值默认 5GB、不做成设置项。
 *
 * 三条克制：
 * - 复用现成的瞬时消息通道（`ddtoolkit:pill-message` → 状态岛的 `messageNotice`），
 *   **不新造通知类型** —— 磁盘满不是"新的一类信息"；
 * - **同一台机器 3 天内只提一次**：这是个持续状态，每次启动都喊一遍只会让人讨厌；
 * - 拿不到数据就静默 —— 这条提醒本身不值得打扰任何人。
 */
const WARNED_KEY = 'ddtoolkit.low-space-warned-at'
const AGAIN_MS = 3 * 24 * 3600 * 1000

export function useLowSpaceNotice(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      try {
        const st = await api.getStorage()
        if (!alive || !st.low_space) return
        const last = Number(localStorage.getItem(WARNED_KEY) || 0)
        if (Number.isFinite(last) && Date.now() - last < AGAIN_MS) return
        localStorage.setItem(WARNED_KEY, String(Date.now()))
        const gb = Math.round(st.low_space_threshold_bytes / 1073741824)
        const usedMb = Math.round(st.total_bytes / 1048576)
        window.dispatchEvent(new CustomEvent('ddtoolkit:pill-message', {
          detail: {
            text: `磁盘可用空间不足 ${gb}GB（数据目录已占 ${usedMb}MB）`
              + '—— 设置 → 关于 可查看占用并清理',
          },
        }))
      } catch {
        /* 静默：拿不到存储信息时不该弹任何东西 */
      }
    })()
    return () => { alive = false }
  }, [enabled])
}
