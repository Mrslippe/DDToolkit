import { afterEach, describe, expect, it } from 'vitest'
import {
  IDLE_QUOTES,
  IDLE_TICK_MS,
  clearIdleProviders,
  idlePool,
  pickIdle,
  pickIdleText,
  registerIdleProvider,
} from './idleQuotes'

/**
 * 空闲轮播（R12b，devlog/090）。
 * 判错的两个代价：① 轮播把"服务在不在跑"顶掉了；② 语录里混进 `_assert_topbar` 忌词，
 * 让"自动节拍不占顶栏"那条护栏永久红灯（那条断言查的是顶栏**文案**）。
 */
afterEach(() => clearIdleProviders())

describe('轮播池', () => {
  it('第 0 格是状态文案，语录跟在后面（状态不能被顶掉）', () => {
    const pool = idlePool('数据服务运行中')
    expect(pool[0]).toBe('数据服务运行中')
    expect(pool.slice(1)).toEqual([...IDLE_QUOTES])
  })

  it('语录去重且不留空条目', () => {
    registerIdleProvider(() => ['数据服务运行中', '', '   ', '自定义一条'])
    const pool = idlePool()
    expect(pool.filter((t) => t === '数据服务运行中')).toHaveLength(1)
    expect(pool).toContain('自定义一条')
    expect(pool.every((t) => t.trim() === t && t.length > 0)).toBe(true)
  })

  it('**语录里不许出现会被顶栏口径误判的词**（轮询 / 抓取中）', () => {
    for (const q of [...IDLE_QUOTES, '数据服务运行中']) {
      expect(q).not.toContain('轮询')
      expect(q).not.toContain('抓取中')
    }
  })

  it('**语录里不许出现竖线**（探针靠 `data-idle-pool` 用 `|` 分隔读池子）', () => {
    for (const q of [...IDLE_QUOTES, '数据服务运行中']) {
      expect(q).not.toContain('|')
    }
  })
})

describe('轮播推进（确定性）', () => {
  it('按 now/tickMs 取模；同一时刻稳定不闪', () => {
    const opts = { statusText: '状态', tickMs: 1000 }
    expect(pickIdleText(0, opts)).toBe('状态')
    expect(pickIdleText(999, opts)).toBe('状态')
    expect(pickIdleText(1000, opts)).toBe(IDLE_QUOTES[0])
    expect(pickIdleText(1500, opts)).toBe(pickIdleText(1500, opts))   // 同刻同值
    expect(pickIdleText(2000, opts)).toBe(IDLE_QUOTES[1])
  })

  it('一轮走完回到状态文案（不越界）', () => {
    const n = idlePool('状态').length
    expect(pickIdleText(n * 1000, { statusText: '状态', tickMs: 1000 })).toBe('状态')
    expect(pickIdleText((n + 1) * 1000, { statusText: '状态', tickMs: 1000 }))
      .toBe(IDLE_QUOTES[0])
  })

  it('关闭轮播（tickMs<=0）退回状态文案，而不是空白', () => {
    expect(pickIdleText(12345, { statusText: '状态', tickMs: 0 })).toBe('状态')
    expect(pickIdleText(12345, { statusText: '状态', tickMs: -5 })).toBe('状态')
  })

  it('间隔落在「不抢注意力 / 不显得卡住」之间（两侧代价见 IDLE_TICK_MS 注释）', () => {
    expect(IDLE_TICK_MS).toBeGreaterThanOrEqual(4_000)
    expect(IDLE_TICK_MS).toBeLessThanOrEqual(15_000)
  })
})

/**
 * `pickIdle` 的形状是给**探针**用的：DOM 里挂着 index / size / pool 三个属性，
 * 脚本侧据此断言"取到的词出自池子、就是 index 那一格、而且真的在往前走"。
 * 判错的代价：若 index/size/pool 三者不同源（比如 size 恒为 1、pool 是另一份拷贝），
 * 那几条断言会变成永远成立的空转 —— 页面绿着，轮播其实是坏的。
 */
describe('索引 / 池长 / 池子内容（探针读 DOM 的那三个属性）', () => {
  it('index 指向的正是 text，size 是池长', () => {
    const pool = idlePool('状态')
    for (const t of [0, 1_000, 5_000, 7_000, 12_345]) {
      const p = pickIdle(t, { statusText: '状态', tickMs: 1000 })
      expect(p.text).toBe(pool[p.index])
      expect(p.size).toBe(pool.length)
      expect(p.pool).toEqual(pool)     // 探针读的就是这个（`data-idle-pool`）
      expect(p.index).toBeGreaterThanOrEqual(0)
      expect(p.index).toBeLessThan(p.size)
    }
  })

  it('池子编号与 text/size 同源（探针的三条断言共用一份数据，不会互相矛盾）', () => {
    for (const t of [0, 3_333, 9_999, 61_000]) {
      const p = pickIdle(t, { statusText: '状态', tickMs: 1000 })
      expect(p.pool[p.index]).toBe(p.text)
      expect(p.pool.length).toBe(p.size)
    }
  })

  it('时间往前走 → 索引严格前进（同 tick 内不动，跨 tick 加一）', () => {
    const opts = { statusText: '状态', tickMs: 1000 }
    const n = idlePool('状态').length
    expect(pickIdle(1_400, opts).index).toBe(pickIdle(1_000, opts).index)   // 同格内不动
    expect(pickIdle(2_000, opts).index).toBe((pickIdle(1_000, opts).index + 1) % n)
  })

  it('索引按池长回卷，不会溢出（探针的 index<size 断言才有意义）', () => {
    const opts = { statusText: '状态', tickMs: 1000 }
    const n = idlePool('状态').length
    expect(pickIdle(n * 1000 * 7 + 500, opts).index).toBeLessThan(n)
  })

  it('关闭轮播时 index=0 且 size 照旧如实报告', () => {
    const p = pickIdle(12345, { statusText: '状态', tickMs: 0 })
    expect(p.index).toBe(0)
    expect(p.size).toBe(idlePool('状态').length)
  })
})

describe('扩展点', () => {
  it('注册的来源进入轮播池；注销后消失', () => {
    const off = registerIdleProvider(() => ['热词：晚安'])
    expect(idlePool()).toContain('热词：晚安')
    off()
    expect(idlePool()).not.toContain('热词：晚安')
  })

  it('来源抛错不影响顶栏（宁可不显示）', () => {
    registerIdleProvider(() => {
      throw new Error('provider 挂了')
    })
    const pool = idlePool()
    expect(pool).toContain('数据服务运行中')
    expect(pool.length).toBeGreaterThan(1)
  })
})
