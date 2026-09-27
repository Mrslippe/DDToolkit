/**
 * **选定账号**的身份机（M4，批次 12 第四刀，devlog/222；认人口径 2026-09-27 统一，devlog/224）。
 *
 * 它守着一条贯穿全页的不变量：**账号的身份是 `platform:platform_uid`，不是对象引用**。
 *
 * - `accountKey` 是依赖去重的稳定代理 —— `fetch-idle` 回填会换**新对象**（新快照），
 *   而 key 不变 ⇒ 统计/帖子/筛选重置那些 effect 不该重跑；
 * - 所以"合并增量快照"这条更新**未命中时必须原样返回旧引用**（`Object.is` 级别），
 *   否则每次广播都会让 accountKey 的消费者白跑一轮；
 * - 而"抓取回填要换新对象"是**对的**：头部直接读 `selectedAccount`，保留旧引用就会
 *   一直显示抓取前的空快照（2026-09-05 实修）。
 *
 * ## 「认人」的口径（2026-09-27 用户拍板：**统一按 `platform_uid`**）
 *
 * | 调用点 | 认人键 | 没选过时 |
 * |---|---|---|
 * | E7 抓取回填（`getVtuber`） | `platform_uid` | 选第一个 |
 * | 设置保存（`onSaved`） | `platform_uid` | 选第一个 |
 * | `account-progress` 增量 | ——（按 uid 合并） | 保持 `null` |
 *
 * 统一前的历史差异（**已消除**，别再引回来）：设置保存那条曾经按本库自增 `id` 认人、
 * 且"没选过就不选"。两者只在两种边角下不同 —— 账号行**删掉后重建**（新 `id`、同 `uid`）
 * 与行的 **`uid` 被就地改写**（同 `id`、新 `uid`）。拍板理由：`uid` 是**平台侧的身份**、
 * 也是 `accountKey` 用的键；`id` 只是本库行号，语义上不该当身份。
 *
 * ## ⚠️ 「可用账号」的定义也在这里（同一天顺手修掉的缺陷）
 *
 * `Account.platform_uid` 在库里是 `nullable=False` **但空串合法**（`uq_account_platform_uid`
 * ⇒ 每个平台最多一行这种占位行）。谁选中了它，`accountKey` 就会变成 `"bilibili:"`、
 * 请求带着空 uid 发出去。所以：
 * - `usableAccounts()` 是**唯一**的过滤口径；
 * - `reconcile()` **内部再过滤一次**（防御：传未过滤的列表进来也不会选中脏行）。
 *
 * ## 记账不在这里
 *
 * E7 那条 effect 还要写场景机的记账 `vtuberLoadedRef`（"这个 V 这一轮已落地过"），
 * 那是**场景机的账**，留在页面里 —— 本 hook 只管"选的是哪个账号"。
 */
import { useCallback, useState } from 'react'

import type { Account, AccountSnapshot } from '../api/types'
import { mergeAccountSnapshots } from '../utils/accountSnapshots'

/** 账号的**稳定身份**：`platform:platform_uid`（跨抓取回填不变，见文件头） */
export const accountKeyOf = (a: Account | null): string | null =>
  a ? `${a.platform}:${a.platform_uid}` : null

/** **可用账号**的唯一口径：有 `platform_uid` 的才算（空串占位行会被滤掉）。
 *  调用方要"有没有账号可选"这个判断时用它（例如 E7 的「该 VTuber 没有可用账号」）。 */
export const usableAccounts = (list: Account[]): Account[] =>
  list.filter((a) => a.platform_uid)

export function useSelectedAccount() {
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null)

  /** 稳定代理：所有"按账号"的 effect 依赖它，而不是对象引用 */
  const accountKey = accountKeyOf(selectedAccount)

  /** **对账**（E7 抓取回填 / 设置保存**共用同一条**）：把选定账号对到 `list` 上 ——
   *  同 `platform_uid` 换**新对象**（拿新快照），没匹配到退回第一个，没选过就选第一个。
   *  ⚠️ 内部先过 `usableAccounts`：脏行（空 uid）永远不会被选中。
   *  ⚠️ 空列表是**防御分支**（调用方另有「该 VTuber 没有可用账号」的提示），
   *  这里保持不动而不是选 `undefined`。
   *  ⚠️ 三个 updater 都用 `useCallback([])` 钉成稳定引用：调用方要把它们放进
   *  effect 依赖数组（否则 `exhaustive-deps` 会报，而它无法证明 hook 返回值稳定）——
   *  稳定的好处是那些 effect 不会因为"每次渲染新函数"而反复重跑/重新订阅。 */
  const reconcile = useCallback((list: Account[]) => setSelectedAccount((prev) => {
    const usable = usableAccounts(list)
    if (usable.length === 0) return prev
    const hit = prev && usable.find((a) => a.platform_uid === prev.platform_uid)
    return hit || usable[0]
  }), [])

  /** **增量快照**（`ddtoolkit:account-progress`）：命中就换新对象，**未命中必须保持原引用**
   *  —— `mergeAccountSnapshots` 未命中返回 `null`，这里回退到 `prev`。 */
  const applySnapshots = useCallback((updates: AccountSnapshot[]) => setSelectedAccount((prev) => (
    prev ? (mergeAccountSnapshots(prev, updates) ?? prev) : prev
  )), [])

  return {
    selectedAccount, setSelectedAccount, accountKey,
    reconcile, applySnapshots,
  }
}
