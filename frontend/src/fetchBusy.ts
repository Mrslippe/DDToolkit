import { useSyncExternalStore } from 'react'

/**
 * 全局抓取忙状态共享 store（TopBar 轮询 fetch-status 时写入）。
 *
 * 语义自 2026-09-10 起收敛为 **「有手动任务在跑」**（后端 `manual_running`，
 * 与手动端点的 409 判据同源）：自动节拍（动态流每轮 ~80s、账号流按到期扫）**不算忙**
 * ——后端会受理手动任务并抢占自动档，前端若据此禁用按钮，用户在轮询期间会点不动
 * 任何按钮却看不出原因。
 */
let busy = false
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

/** 由 TopBar 每次轮询写入（`status.manual_running`） */
export function setFetchBusy(manualRunning: boolean): void {
  if (busy !== manualRunning) {
    busy = manualRunning
    notify()
  }
}

export function getFetchBusy(): boolean {
  return busy
}

/** 订阅忙状态：有**手动**抓取任务运行中（含等自动档让位的窗口）返回 true */
export function useFetchBusy(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getFetchBusy,
    getFetchBusy,
  )
}