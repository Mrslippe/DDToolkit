/**
 * 手排顺序的纯逻辑（R51，devlog/228）—— 长按拖动用的，有单测。
 *
 * 为什么单独一个模块：拖动这类交互**错了界面上看不出来**才是常态 ——
 * 拖完位置对了，但提交给后端的 id 串错位一格（"拖了 A、存成 B"），
 * 刷新之后才发现顺序不对，而那时已经没人记得拖的是谁了。
 *
 * 两条规则：
 * - `moveItem`：把某个位置的元素挪到另一个位置（返回新数组，不改原数组）；
 * - `applyVisibleOrder`：**筛选/搜索开着**时也能拖 —— 只重排"看得见的那几个"，
 *   被筛掉的条目**留在原来的槽位**（不因为一次拖动就整体沉底）。
 */

/** 把 `list[from]` 挪到 `to`（下标越界时返回原样副本）。 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return [...list]
  }
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * 把"可见项的新顺序"写回全长列表：`visible` 是这一轮参与拖动的 id（**按拖动前的位置升序**），
 * `ordered` 是它们拖动后的新顺序。返回全长 id 列表。
 *
 * ⚠️ 长度不一致（例如拖动过程中列表刷新了）时**原样返回** `all`：
 * 宁可这一次不生效，也不要按错位的 id 去写库。
 */
export function applyVisibleOrder(all: number[], visible: number[], ordered: number[]): number[] {
  if (visible.length !== ordered.length || visible.length === 0) return [...all]
  const slots = all.map((id, idx) => (visible.includes(id) ? idx : -1)).filter((i) => i >= 0)
  if (slots.length !== ordered.length) return [...all]
  const next = [...all]
  slots.forEach((slot, i) => {
    next[slot] = ordered[i]
  })
  return next
}

/** 按 `order`（id 串）重排 `list`；`order` 里没有的条目按原相对顺序排在后面。 */
export function orderById<T extends { id: number }>(list: T[], order: number[] | null): T[] {
  if (!order || order.length === 0) return list
  const byId = new Map(list.map((x) => [x.id, x]))
  const out: T[] = []
  for (const id of order) {
    const hit = byId.get(id)
    if (hit) {
      out.push(hit)
      byId.delete(id)
    }
  }
  for (const x of list) {
    if (byId.has(x.id)) out.push(x)
  }
  return out
}
