/**
 * 卡片签名的**解析口径**（2026-09-13，devlog/074）。
 *
 * 用户口径（A3）：卡片签名 =
 * ① `vtubers.sign_override`（手改的覆盖，最高优先）
 * → ② `vtubers.sign_source_account_id` 指向的账号的签名（下拉选的那个平台）
 * → ③ 主账号（B 站优先）的签名（未设置来源时的默认，与旧行为一致）
 * → ④ 空（没有任何签名）。
 *
 * **不动任何 `accounts.sign`**：平台签名是平台的事实，只读；手改的内容进 override。
 * 抽成纯函数是因为这条链有三个容易写错的点（覆盖优先、来源缺失回落、空串归一化），
 * 且错了不会报错 —— 只会"卡片上的签名不是你以为的那个"。
 */
import type { Account, VTuber } from '../api/types'

export interface ResolvedSign {
  /** 生效的签名文本（未归一化前的展示值；空串 = 没有） */
  text: string
  /** 来源：override（手改覆盖）/ account（跟随某账号）/ none（都没有） */
  from: 'override' | 'account' | 'none'
  /** `account` 时是哪个账号（override/none 时为 null） */
  accountId: number | null
}

/** 主账号：B 站优先，其次首个有 uid 的账号（与卡片其它"整体事实"同口径） */
export function heroAccount(accounts: Account[]): Account | null {
  const withUid = accounts.filter((a) => a.platform_uid)
  return withUid.find((a) => a.platform === 'bilibili') ?? withUid[0] ?? null
}

export function resolveSign(vtuber: VTuber | null | undefined,
                            accounts: Account[]): ResolvedSign {
  const override = (vtuber?.sign_override ?? '').trim()
  if (override) return { text: override, from: 'override', accountId: null }
  const sourceId = vtuber?.sign_source_account_id ?? null
  const source = sourceId != null ? accounts.find((a) => a.id === sourceId) : null
  // 来源账号被删 / 没设来源 → 回落主账号（**不要**因为来源失效就显示空）
  const fallback = source ?? heroAccount(accounts)
  const text = (fallback?.sign ?? '').trim()
  if (!text) return { text: '', from: 'none', accountId: null }
  return { text, from: 'account', accountId: fallback?.id ?? null }
}
