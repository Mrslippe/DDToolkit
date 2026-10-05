import { useEffect } from 'react'
import { api } from '../api/api'
import { EVENTS, emit } from '../utils/appEvents'

/**
 * 磁盘快满时提醒一次（R22-B，devlog/104）。
 *
 * 用户口径（2026-09-16）：**状态岛提醒一次 + 关于页显示**，阈值默认 5GB、不做成设置项。
 *
 * 三条克制：
 * - L3（`devlog/343`）：改走 `noticeAlert` ⇒ 进**通知面板**的「最近」分组（有相对时间、
 *   能回看），不再是胶囊上闪一下就没；关**关于页**那条常驻提示照旧（`aps-storage` 的
 *   「空间偏紧」红字），所以这条通知过期也不等于用户再也查不到；
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
        emit(EVENTS.noticeAlert, {
          id: 'local-low-space',
          source: '磁盘',
          text: `磁盘可用空间不足 ${gb}GB（数据目录已占 ${usedMb}MB）`
            + '—— 设置 → 关于 可查看占用并清理',
        })
      } catch {
        /* 静默：拿不到存储信息时不该弹任何东西 */
      }
    })()
    return () => { alive = false }
  }, [enabled])
}
