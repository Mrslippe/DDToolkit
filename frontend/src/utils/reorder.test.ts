import { describe, expect, it } from 'vitest'

import { applyVisibleOrder, moveItem, orderById } from './reorder'

describe('moveItem', () => {
  it('把元素挪到目标位置（不修改原数组）', () => {
    const src = ['a', 'b', 'c', 'd']
    expect(moveItem(src, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(src).toEqual(['a', 'b', 'c', 'd'])
  })

  it('原地不动 / 越界时返回原样副本', () => {
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b'])
  })
})

describe('applyVisibleOrder', () => {
  it('只重排可见项，被筛掉的留在原来的槽位', () => {
    // 全长 1..5，当前筛出 [2,4]（位置 1 与 3）；把 4 拖到 2 前面
    expect(applyVisibleOrder([1, 2, 3, 4, 5], [2, 4], [4, 2])).toEqual([1, 4, 3, 2, 5])
  })

  it('长度对不上时原样返回（宁可这次不生效，也不按错位的 id 写库）', () => {
    expect(applyVisibleOrder([1, 2, 3], [1, 2], [2])).toEqual([1, 2, 3])
    expect(applyVisibleOrder([1, 2, 3], [], [])).toEqual([1, 2, 3])
  })
})

describe('orderById', () => {
  it('按 id 串重排；串里没有的按原相对顺序排后面', () => {
    const list = [{ id: 1 }, { id: 2 }, { id: 3 }]
    expect(orderById(list, [3, 1]).map((x) => x.id)).toEqual([3, 1, 2])
  })

  it('没有手排顺序时原样返回（服务端顺序）', () => {
    const list = [{ id: 1 }, { id: 2 }]
    expect(orderById(list, null)).toBe(list)
  })
})
