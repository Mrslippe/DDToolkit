import type { VTuber } from '../api/types'

/**
 * 左栏列表的"就地更新"（R33 补，2026-09-19）。
 *
 * 为什么需要：左栏 `VtuberSidebar` **自己** `listVtubers()` 取一次列表，之后只跟抓取快照
 * 合并 —— 而「档案设置」里改签名/头像走的是 `PostsPage` 的那份 `vtuber` 状态。
 * 于是**当场改**完之后右栏（卡片）立刻变、左栏一直是旧的 ✗
 * （用户原话：「修改过的签名左栏没有及时同步，这个问题之前好像修复过了但是又出现了」——
 *   R33 修的是"渲染口径"（`resolveSign` 那条链），这次缺的是**通知通道**）。
 *
 * 通道用 window 事件而不是 prop：左栏不是 `PostsPage` 的子节点（两者都挂在 `App` 下），
 * prop 传递要穿两层；本仓已有 `ddtoolkit:pill-message` 这个同款先例。
 */
export const VTUBER_UPDATED_EVENT = 'ddtoolkit:vtuber-updated'

/**
 * 把一条更新后的 V 合并进列表（纯函数，可单测）。
 * - 按 `id` 命中：**只覆盖新对象里真实带上的字段**（`{...old, ...updated}`），
 *   这样快照类字段不会因为更新对象里没有而被抹掉；
 * - 顺序不变（左栏排序有自己的规则，不能因为一次更新就重排）；
 * - 没命中就原样返回（不新增 —— 新 V 走"重新拉列表"那条路）。
 */
export function applyVtuberUpdate(list: VTuber[], updated: VTuber | null | undefined): VTuber[] {
  if (!updated || typeof updated.id !== 'number') return list
  let hit = false
  const next = list.map((v) => {
    if (v.id !== updated.id) return v
    hit = true
    return { ...v, ...updated }
  })
  return hit ? next : list
}
