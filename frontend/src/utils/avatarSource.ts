/**
 * 头像的**解析口径**（2026-09-17，devlog/135）—— 卡片与左栏共用同一条链。
 *
 * ① `vtubers.avatar`：档案设置里「点哪个账号的头像就用哪个」选的**远端 URL**
 *    （它存的就是账号的 `avatar_url` 原文，所以**不过** `resolveAsset`）；
 * → ② 主账号/B 站账号的**本地缓存** `avatar_path`（离线兜底）；
 * → ③ 任一账号的本地缓存 `avatar_path`；
 * → ④ B 站账号的 `avatar_url`；⑤ 任一账号的 `avatar_url`；
 * → ⑥ `undefined`（交给 `AvatarFallback` 显示名字首字）。
 *
 * 为什么抽出来：左栏此前自己拼了一条"只看平台头像"的链
 * （`bili.avatar_path ?? bili.avatar_url`），于是用户在档案设置里换过头像之后
 * **卡片变了、左栏没变** —— 这类"两处各写一遍、慢慢漂开"的错不会报错，
 * 只会让人以为"设置没生效"。现在两处都调这一个函数（与签名用 `signSource.resolveSign` 同一个道理）。
 */
import { resolveAsset } from '../api/api'
import type { Account, VTuber } from '../api/types'

export function resolveAvatar(
  vtuber: VTuber | null | undefined,
  accounts: Account[] = [],
): string | undefined {
  const custom = (vtuber?.avatar ?? '').trim()
  if (custom) return custom
  const bili = accounts.find((a) => a.platform === 'bilibili')
  const first = accounts[0]
  return (
    resolveAsset(bili?.avatar_path) ??
    resolveAsset(first?.avatar_path) ??
    bili?.avatar_url ??
    first?.avatar_url ??
    undefined
  )
}
