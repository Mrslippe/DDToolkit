import type { Account, AccountSnapshot, VTuber } from '../api/types'

/**
 * 抓取完成快照的就地合并（与后端 `_push_account_snapshot`/`fetch-status.recent` 对齐）。
 * 侧栏与 PostsPage 右栏共用同一实现，保证「左栏直播中 / 右栏未开播」不会各读各的。
 */

/**
 * 账号的**稳定身份**：`platform:platform_uid` —— 与 `useSelectedAccount.accountKeyOf`
 * 逐字同一个口径（那边管"选的是哪个账号"，这里管"这条快照是谁的"）。
 */
export const snapshotKey = (platform: string, platformUid: string) =>
  `${platform}:${platformUid}`

/**
 * 把快照合并进单个账号（按 **`platform:platform_uid`** 匹配）；未命中返回 null
 * （调用方保留原引用）。
 *
 * ⚠️ **2026-10-10 修**（自审 F7，`devlog/461`）：原先只比 `platform_uid`，而 B 站 mid
 * 与微博 uid **都是纯数字串** —— 撞号时会把另一个平台那个人的昵称/签名/头像/直播状态
 * 并进这个账号，症状是左栏"直播中"、右栏"未开播"这种自相矛盾。
 * 真机当前没有撞号的账号（属口径隐患），但"等撞上再修"就是又一次静默串号。
 */
export function mergeAccountSnapshots(
  acc: Account,
  updates: AccountSnapshot[],
): Account | null {
  const hit = updates.find(
    (u) => u.platform_uid === acc.platform_uid && u.platform === acc.platform,
  )
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
