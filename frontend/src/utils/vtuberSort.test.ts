// @vitest-environment jsdom
/**
 * 左栏排序六档（需求 5，`devlog/414`）。纯函数，逐个键钉。
 *
 * ⚠️ 两条最容易犯的错，各有一条判据盯着：
 * ① **原地排**（`Array.sort` 改的是调用方那个数组 ⇒ React state 被改，切一次筛选顺序就永久变了）；
 * ② **键打平时顺序摇摆**（`devlog/378` 那类"打平就换位"）⇒ 每一档都必须以 `id` 兜底。
 */
import { describe, expect, it } from 'vitest'

import type { VTuber } from '../api/types'
import {
  loadVtuberSortKey, saveVtuberSortKey, sortVtubers, VTUBER_SORT_KEY, VTUBER_SORT_KEYS,
  VTUBER_SORT_LABEL,
} from './vtuberSort'

/** 造一条够用的 V（只填排序读得到的字段；其余交给断言的类型转换）。 */
function v(id: number, name: string,
         extra: { sort_order?: number; updated_at?: string | null;
                  followers?: number; live?: number } = {}): VTuber {
  const accounts = extra.followers === undefined && extra.live === undefined ? [] : [{
    platform: 'bilibili',
    followers_count: extra.followers ?? 0,
    live_status: extra.live ?? 0,
  }]
  return {
    id, name, accounts,
    sort_order: extra.sort_order ?? 0,
    updated_at: extra.updated_at ?? null,
  } as unknown as VTuber
}

const ids = (list: VTuber[]) => list.map((x) => x.id)

describe('vtuberSort：六档', () => {
  it('每档都有中文标签（筛选浮窗直接读它），且档数就是六', () => {
    expect(VTUBER_SORT_KEYS).toHaveLength(6)
    for (const k of VTUBER_SORT_KEYS) expect(VTUBER_SORT_LABEL[k]).toBeTruthy()
  })

  it('`custom`：**后端给的顺序原样**（拖出来的顺序），且不改调用方那个数组', () => {
    const list = [v(30, '丙', { sort_order: 0 }), v(10, '甲', { sort_order: 1 })]
    const out = sortVtubers(list, 'custom')
    expect(ids(out), 'custom 就是"别动它"').toEqual([30, 10])
    expect(ids(list), '⚠️ 不许把调用方的数组排掉（那会改掉 React state）').toEqual([30, 10])
    expect(out).not.toBe(list)
  })

  it('`default`：导入顺序 = **id 升序** —— 不是 sort_order（有"自定义"就得留一条回得去的路）', () => {
    const list = [v(30, '丙', { sort_order: 0 }), v(10, '甲', { sort_order: 5 })]
    expect(ids(sortVtubers(list, 'default'))).toEqual([10, 30])
  })

  it('`name`：中文**按拼音**（不是码点序）—— 「阿」在「波」前', () => {
    // 码点：波 U+6CE2 < 阿 U+963F，所以码点序会给出 [波, 阿]；拼音序必须是 [阿, 波]
    const list = [v(1, '波波'), v(2, '阿梓')]
    expect(ids(sortVtubers(list, 'name'))).toEqual([2, 1])
  })

  it('`followers`：降序；**没有 B 站账号的排最后**（不是当成 0 粉混进中间）', () => {
    const list = [v(1, '无账号'), v(2, '小', { followers: 100 }), v(3, '大', { followers: 9000 })]
    expect(ids(sortVtubers(list, 'followers'))).toEqual([3, 2, 1])
  })

  it('`updated`：新的在前；没有时间的排最后', () => {
    const list = [
      v(1, '没时间'),
      v(2, '旧', { updated_at: '2026-01-01T00:00:00Z' }),
      v(3, '新', { updated_at: '2026-10-01T00:00:00Z' }),
    ]
    expect(ids(sortVtubers(list, 'updated'))).toEqual([3, 2, 1])
  })

  it('`live`：开播中的最前；同为开播中再按粉丝数', () => {
    const list = [
      v(1, '离线大粉', { followers: 9999 }),
      v(2, '播着小粉', { followers: 10, live: 1 }),
      v(3, '播着大粉', { followers: 500, live: 1 }),
    ]
    expect(ids(sortVtubers(list, 'live'))).toEqual([3, 2, 1])
  })

  it('⚠️ 键打平 ⇒ 以 `id` 兜底（顺序不许随 sort 实现摇摆）', () => {
    // 三条完全打平（同名同粉同时间）
    const list = [v(7, '同名', { followers: 1 }), v(3, '同名', { followers: 1 }),
                  v(5, '同名', { followers: 1 })]
    for (const k of VTUBER_SORT_KEYS) {
      if (k === 'custom') continue        // custom 的定义就是"别动它"，见下一条
      expect(ids(sortVtubers(list, k)), `档 ${k} 打平时必须稳定`).toEqual([3, 5, 7])
    }
    // ⚠️ `custom` **不参与**兜底：打平也一样保持传进来的顺序（它表达的是用户拖出来的次序）
    expect(ids(sortVtubers(list, 'custom'))).toEqual([7, 3, 5])
  })

  it('未知档位退回 `custom`（偏好里存了老版本的值时要能用，不是白屏）', () => {
    const list = [v(30, '丙'), v(10, '甲')]
    expect(ids(sortVtubers(list, 'nope' as never))).toEqual([30, 10])
  })
})

describe('vtuberSort：偏好的存取', () => {
  it('没存过 ⇒ `custom`；存过就往返；坏值 ⇒ `custom`（不抛）', () => {
    localStorage.removeItem(VTUBER_SORT_KEY)
    expect(loadVtuberSortKey()).toBe('custom')

    saveVtuberSortKey('followers')
    expect(localStorage.getItem(VTUBER_SORT_KEY)).toBe('followers')
    expect(loadVtuberSortKey()).toBe('followers')

    localStorage.setItem(VTUBER_SORT_KEY, '老版本才认识的档')
    expect(loadVtuberSortKey(), '坏值要退回默认，不能把界面带崩').toBe('custom')
    localStorage.removeItem(VTUBER_SORT_KEY)
  })
})
