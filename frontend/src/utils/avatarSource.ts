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
  return resolveAvatarSources(vtuber, accounts).src
}

/** 头像的**两个地址**：`src` = 要显示的那张（远端优先），`local` = 它在**本地**的副本（A0）。 */
export interface AvatarSources {
  src?: string
  /** 本地副本（`static/` 相对路径，调用方用 `resolveAsset` 拼）；没有就是 undefined */
  local?: string
}

/**
 * A0（devlog/255）：头像的**远端 + 本地**两个来源，一次算出来。
 *
 * 为什么要 `local`：`vtubers.avatar` 存的是**远端 URL 原文**，而远端会死 ——
 * 实测 2026-09-29：V#16 那张微博头像的签名 `Expires` 已过期 21 小时，
 * 当时**只靠 `/img-proxy` 的磁盘缓存续命**（缓存一清就破图）。
 * `local` 由后端派生（`VTuberOut.avatar_local`：账本行的 `avatar_path`，退一步用账号的），
 * 传给 `ProxyImage` 的 `fallbackSrc` 就多一级回落：直连 → 代理 → **本地** → 占位。
 *
 * ⚠️ `src` 与 `local` 的**取值口径不同**，别互相替换：
 * `src` 是"要显示哪张脸"（自定义 → 平台缓存 → …），`local` 只是"那张脸的本地副本在哪"。
 */
export function resolveAvatarSources(
  vtuber: VTuber | null | undefined,
  accounts: Account[] = [],
): AvatarSources {
  const custom = (vtuber?.avatar ?? '').trim()
  if (custom) {
    // 选了哪张就显示哪张；它的本地副本由后端给出（账本/账号两条路）
    const local = (vtuber?.avatar_local ?? '').trim()
    return { src: custom, local: local || undefined }
  }
  const bili = accounts.find((a) => a.platform === 'bilibili')
  const first = accounts[0]
  const src = (
    resolveAsset(bili?.avatar_path) ??
    resolveAsset(first?.avatar_path) ??
    bili?.avatar_url ??
    first?.avatar_url ??
    undefined
  )
  // 没自定义时 `src` 本身就是本地缓存（那条链优先本地）⇒ 不需要额外的 local
  return { src }
}
