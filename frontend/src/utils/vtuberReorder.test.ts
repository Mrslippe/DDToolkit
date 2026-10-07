// @vitest-environment jsdom
/**
 * 拖动重排的纯逻辑（需求 4，`devlog/415`）。
 *
 * ⚠️ 这里最要紧的一条是 `applyVisibleOrder` 的"**没拖到的原地不动**" ——
 * 它与服务端 `VTuberRepo.reorder` 是同一套语义，两边算得不一样的话，
 * 落库完成再拉一次列表会让顺序**当场跳一下**（而这一跳只在"带筛选拖"时出现）。
 */
import { describe, expect, it } from 'vitest'

import { applyVisibleOrder, DRAG_CANCEL_PX, DRAG_HOLD_MS, moveItem } from './vtuberReorder'

const items = (...ids: number[]) => ids.map((id) => ({ id, name: `V${id}` }))
const ids = (list: { id: number }[]) => list.map((x) => x.id)

describe('拖动重排：纯逻辑', () => {
  it('`moveItem`：往后挪、往前挪都对，且**不改调用方那个数组**', () => {
    const list = items(1, 2, 3, 4)
    expect(ids(moveItem(list, 0, 2)), '第 0 个挪到第 2 位').toEqual([2, 3, 1, 4])
    expect(ids(moveItem(list, 3, 1)), '第 3 个挪到第 1 位').toEqual([1, 4, 2, 3])
    expect(ids(list), '⚠️ 不许原地排（那会改掉 React state）').toEqual([1, 2, 3, 4])
    expect(moveItem(list, 0, 2)).not.toBe(list)
  })

  it('`moveItem`：越界 / 原地不动 ⇒ 原样返回副本（指针掠过列表之外不是错误）', () => {
    const list = items(1, 2, 3)
    for (const [from, to] of [[-1, 1], [0, 9], [3, 0], [1, 1]] as const) {
      const out = moveItem(list, from, to)
      expect(ids(out), `${from}→${to}`).toEqual([1, 2, 3])
      expect(out).not.toBe(list)
    }
  })

  it('★ `applyVisibleOrder`：**没出现在新顺序里的条目原地不动**（= 带筛选拖动的口径）', () => {
    const all = items(11, 22, 33, 44, 55)
    // 用户只看得见 22/33/44（筛掉了 11 与 55），把它们拖成 44,22,33
    const out = applyVisibleOrder(all, [44, 22, 33])
    expect(ids(out), '11 与 55 必须留在原位（第 0 与第 4）').toEqual([11, 44, 22, 33, 55])
    expect(ids(all), '不许改调用方那个').toEqual([11, 22, 33, 44, 55])
  })

  it('`applyVisibleOrder`：给全量时就是整体重排', () => {
    const all = items(1, 2, 3)
    expect(ids(applyVisibleOrder(all, [3, 1, 2]))).toEqual([3, 1, 2])
  })

  it('`applyVisibleOrder`：陌生 id 静默跳过（并发新增/删除的竞态不该把界面搞崩）', () => {
    const all = items(1, 2, 3)
    // 999 不认识 ⇒ 只剩 [3, 1] 参与；它们占的槽是 0 与 2 ⇒ 3→0、1→2，中间的 2 没被碰到
    expect(ids(applyVisibleOrder(all, [3, 999, 1]))).toEqual([3, 2, 1])
    expect(ids(applyVisibleOrder(all, [])), '空顺序 = 什么都不动').toEqual([1, 2, 3])
    expect(ids(applyVisibleOrder(all, [999]))).toEqual([1, 2, 3])
  })

  it('两个常量是"按住"与"取消"的口径，别被随手调成 0', () => {
    expect(DRAG_HOLD_MS, '0 会让"点一下选中"当场变成拖动').toBeGreaterThanOrEqual(200)
    expect(DRAG_CANCEL_PX).toBeGreaterThan(0)
  })
})
