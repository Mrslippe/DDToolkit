/**
 * 左栏按住拖动重排的**纯逻辑**（需求 4，2026-10-07，`devlog/415`）。
 *
 * 拖拽这一层天生难测（要指针、要几何、要 `elementFromPoint`），所以把**算得出来的部分**
 * 全提到这里：能在可见列表里挪一格、能把"可见的那几条的新顺序"填回完整列表。
 * 组件那边只剩"读指针 → 算出目标下标 → 调这两个函数"，那部分由源码级接线判据盯着。
 *
 * ⚠️⚠️ **`applyVisibleOrder` 必须与服务端 `VTuberRepo.reorder` 是同一套语义**
 * （"把传进来的按新顺序**填回它们原本占的那些位置**"，不是"排在其后"）：
 * 客户端先乐观渲染、服务端随后落库 —— 两边算得不一样的话，落库完成再拉一次列表，
 * 顺序会**当场跳一下**（而这一跳只在"带着筛选拖"时才出现，极难归因）。
 */

/** 按住多久才算"拖"（`devlog/048` 平台徽章那套用的也是 350ms）。 */
export const DRAG_HOLD_MS = 350

/** 按住期间指针挪动超过这个距离就当作"不是拖"（滚动/框选）而取消。 */
export const DRAG_CANCEL_PX = 6

/**
 * 把 `list[from]` 挪到下标 `to`（**返回新数组**，不改调用方那个）。
 *
 * 越界的下标一律**原样返回副本**：拖拽期间指针可能掠过列表之外，那不是错误，
 * 也不该让列表跳一下。
 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const n = list.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return [...list]
  const out = [...list]
  const [moved] = out.splice(from, 1)
  out.splice(to, 0, moved)
  return out
}

/**
 * 把"可见的那几条的新顺序"（`orderIds`）**填回**完整列表 `all` 里它们原本占的位置。
 *
 * 没出现在 `orderIds` 里的条目**原地不动**（相对次序与绝对位置都不变）——
 * 这正是"带着筛选拖动"要的效果。与服务端同算法的理由是上面那段 ⚠️。
 *
 * `orderIds` 里若有 `all` 中不存在的 id（并发新增/删除时的竞态），**静默跳过**：
 * 拖拽落库失败会走"重拉列表"那条路，这里报错只会把界面搞崩。
 */
export function applyVisibleOrder<T extends { id: number }>(all: T[], orderIds: number[]): T[] {
  const byId = new Map(all.map((x) => [x.id, x]))
  const want = orderIds.filter((id) => byId.has(id))
  if (want.length === 0) return [...all]
  const wantSet = new Set(want)
  // `all` 里那些"在这次拖动范围内"的下标（位置集合 —— 拖动不改位置，只换内容）
  const slots = all.reduce<number[]>((acc, x, i) => (wantSet.has(x.id) ? [...acc, i] : acc), [])
  const out = [...all]
  for (let i = 0; i < slots.length; i += 1) {
    out[slots[i]] = byId.get(want[i]) as T
  }
  return out
}
