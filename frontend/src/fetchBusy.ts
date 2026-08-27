import { useSyncExternalStore } from 'react'

/**
 * 全局抓取忙状态共享 store（TopBar 轮询 fetch-status 时写入）。
 * 帖子/账号任一类抓取任务运行中 → useFetchBusy() 为 true，各处按钮据此禁用，
 * 避免点击后无反馈（后端 any_fetch_running 兜底拒绝）。
 */
let accountBusy = false
let postBusy = false
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

export function setFetchBusy(accountRunning: boolean, postRunning: boolean): void {
  if (accountBusy !== accountRunning || postBusy !== postRunning) {
    accountBusy = accountRunning
    postBusy = postRunning
    notify()
  }
}

export function getFetchBusy(): boolean {
  return accountBusy || postBusy
}

/** 订阅忙状态：任何抓取任务运行中返回 true */
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