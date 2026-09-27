/**
 * **选定账号**的身份机（M4，批次 12 第四刀，devlog/222）。
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
 * ## ⚠️ 「认人」有三套口径，全部**逐字保留**（统一是产品决定，不在重构里做）
 *
 * | 调用点 | 认人键 | 没选过时 | 为什么是这样 |
 * |---|---|---|---|
 * | E7 抓取回填（`getVtuber`） | `platform_uid` | **选第一个** | 首开必须有账号可看 |
 * | 设置保存（`onSaved`） | `id` | **保持不选** | 历史写法：`prev ? … : prev` |
 * | `account-progress` 增量 | ——（合并） | 保持 `null` | 没选中就没有可合并的对象 |
 *
 * 前两套按理是同一件事（把选定账号对账到新的账号列表上），却用了不同的键 ——
 * **这次不统一**：两者在"账号被删后重建 / uid 被重新绑定"这两种边角下结果不同，
 * 统一属于改行为。已记进 `TODO.md`（待定口径）。
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

export function useSelectedAccount() {
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null)

  /** 稳定代理：所有"按账号"的 effect 依赖它，而不是对象引用 */
  const accountKey = accountKeyOf(selectedAccount)

  /** **E7 抓取回填**：把选定账号对账到 `list` 上 —— 同 `platform_uid` 换**新对象**
   *  （拿新快照），没匹配到退回第一个，没选过就选第一个。
   *  ⚠️ 空列表是**防御分支**（调用方另有「该 VTuber 没有可用账号」的提示），
   *  这里保持不动而不是选 `undefined`。
   *  ⚠️ **三个 updater 都用 `useCallback([])` 钉成稳定引用**：调用方要把它们放进
   *  effect 依赖数组（否则 `exhaustive-deps` 会报，而它无法证明 hook 返回值稳定）——
   *  稳定的好处是那些 effect 不会因为"每次渲染新函数"而反复重跑/重新订阅。 */
  const reconcileByUid = useCallback((list: Account[]) => setSelectedAccount((prev) => {
    if (list.length === 0) return prev
    const hit = prev && list.find((a) => a.platform_uid === prev.platform_uid)
    return hit || list[0]
  }), [])

  /** **设置保存后**：同一件事，但历史口径是按 `id` 认人、且**没选过就不选**
   *  （见文件头那张表 —— 与上一条的差异是刻意保留的）。 */
  const reconcileById = useCallback((list: Account[]) => setSelectedAccount((prev) => {
    if (!prev || list.length === 0) return prev
    return list.find((a) => a.id === prev.id) ?? list[0]
  }), [])

  /** **增量快照**（`ddtoolkit:account-progress`）：命中就换新对象，**未命中必须保持原引用**
   *  —— `mergeAccountSnapshots` 未命中返回 `null`，这里回退到 `prev`。 */
  const applySnapshots = useCallback((updates: AccountSnapshot[]) => setSelectedAccount((prev) => (
    prev ? (mergeAccountSnapshots(prev, updates) ?? prev) : prev
  )), [])

  return {
    selectedAccount, setSelectedAccount, accountKey,
    reconcileByUid, reconcileById, applySnapshots,
  }
}
