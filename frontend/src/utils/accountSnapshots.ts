import type { Account, AccountSnapshot, VTuber } from '../api/types'

/**
 * 抓取完成快照的就地合并（与后端 `_push_account_snapshot`/`fetch-status.recent` 对齐）。
 * 侧栏与 PostsPage 右栏共用同一实现，保证「左栏直播中 / 右栏未开播」不会各读各的。
 */

/** 把快照合并进单个账号（按 platform_uid 匹配）；未命中返回 null（调用方保留原引用） */
export function mergeAccountSnapshots(
  acc: Account,
  updates: AccountSnapshot[],
): Account | null {
  const hit = updates.find((u) => u.platform_uid === acc.platform_uid)
  if (!hit) return null
  return {
    ...acc,
    display_name: hit.display_name ?? acc.display_name,
    sign: hit.sign ?? acc.sign,
    followers_count: hit.followers_count ?? acc.followers_count,
    live_status: hit.live_status ?? acc.live_status,
    live_title: hit.live_title ?? acc.live_title,
    avatar_path: hit.avatar_path ?? acc.avatar_path,
  }
}

/** 把快照合并进 VTuber（逐账号匹配）；未命中任何账号返回原对象（引用不变） */
export function mergeVtuberSnapshots(v: VTuber, updates: AccountSnapshot[]): VTuber {
  let touched = false
  const accounts = v.accounts.map((a) => {
    const merged = mergeAccountSnapshots(a, updates)
    if (!merged) return a
    touched = true
    return merged
  })
  return touched ? { ...v, accounts } : v
}
