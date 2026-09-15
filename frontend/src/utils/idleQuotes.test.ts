import { afterEach, describe, expect, it } from 'vitest'
import {
  IDLE_CAROUSEL_ENABLED,
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
    const opts = { statusText: '状态', tickMs: 1000, enabled: true }
    expect(pickIdleText(0, opts)).toBe('状态')
    expect(pickIdleText(999, opts)).toBe('状态')
    expect(pickIdleText(1000, opts)).toBe(IDLE_QUOTES[0])
    expect(pickIdleText(1500, opts)).toBe(pickIdleText(1500, opts))   // 同刻同值
    expect(pickIdleText(2000, opts)).toBe(IDLE_QUOTES[1])
  })

  it('一轮走完回到状态文案（不越界）', () => {
    const n = idlePool('状态').length
    const opts = { statusText: '状态', tickMs: 1000, enabled: true }
    expect(pickIdleText(n * 1000, opts)).toBe('状态')
    expect(pickIdleText((n + 1) * 1000, opts)).toBe(IDLE_QUOTES[0])
  })

  it('关闭轮播（tickMs<=0）退回状态文案，而不是空白', () => {
    expect(pickIdleText(12345, { statusText: '状态', tickMs: 0, enabled: true })).toBe('状态')
    expect(pickIdleText(12345, { statusText: '状态', tickMs: -5, enabled: true })).toBe('状态')
  })

  it('间隔落在「不抢注意力 / 不显得卡住」之间（两侧代价见 IDLE_TICK_MS 注释）', () => {
    expect(IDLE_TICK_MS).toBeGreaterThanOrEqual(4_000)
    expect(IDLE_TICK_MS).toBeLessThanOrEqual(15_000)
  })
})

/**
 * **语录集暂时下线**（R19，devlog/096）。用户口径：「顶栏状态栏空置的时候轮播的语录集
 * 暂时下线，等之后库中真有了条目再上线」。
 *
 * 判错的两个方向都要防：
 * ① 下线没生效（顶栏还在转占位语录）→ 用户看到的还是"与库无关的话"；
 * ② 下线把实现也删了（哪天想上线却无处可上）→ 所以这里**用 `enabled: true` 覆盖**，
 *    把轮播逻辑照旧完整测一遍（关掉的是显示，不是实现），并钉住 `data-idle-carousel`
 *    这个"开关状态"的来源。
 */
describe('语录集下线（R19）', () => {
  it('默认下线：任何时刻都显示状态文案，不轮播', () => {
    expect(IDLE_CAROUSEL_ENABLED).toBe(false)
    const pool = idlePool('数据服务运行中')
    for (const t of [0, 6_000, 12_000, 60_000, 123_456]) {
      const p = pickIdle(t)                  // 不传 enabled → 走默认（下线）
      expect(p.text).toBe('数据服务运行中')
      expect(p.index).toBe(0)
      expect(p.size).toBe(pool.length)        // 池子照建（探针仍能看到池内容）
    }
  })

  it('实现没被删：显式打开仍能轮播（将来接真实条目时不用重写）', () => {
    const opts = { statusText: '状态', tickMs: 1000, enabled: true }
    expect(pickIdleText(1000, opts)).toBe(IDLE_QUOTES[0])
    expect(pickIdleText(2000, opts)).toBe(IDLE_QUOTES[1])
  })

  it('下线不影响扩展点：来源仍进池（探针的池内无进度词断言照旧有意义）', () => {
    const off = registerIdleProvider(() => ['热词：晚安'])
    expect(idlePool('状态')).toContain('热词：晚安')
    off()
    expect(idlePool('状态')).not.toContain('热词：晚安')
  })
})

/**
 * `pickIdle` 的形状是给**探针**用的：DOM 里挂着 index / size / pool 三个属性，
 * 脚本侧据此断言"取到的词出自池子、就是 index 那一格"。
 * 判错的代价：若 index/size/pool 三者不同源（比如 size 恒为 1、pool 是另一份拷贝），
 * 那几条断言会变成永远成立的空转 —— 页面绿着，轮播其实是坏的。
 *
 * ⚠️ R19 起轮播默认下线，所以这里统一用 `enabled: true` 覆盖 —— 测的是**机制**，
 * "当前关着"由上面那组「语录集下线」的用例单独钉。
 */
describe('索引 / 池长 / 池子内容（探针读 DOM 的那三个属性）', () => {
  it('index 指向的正是 text，size 是池长', () => {
    const pool = idlePool('状态')
    for (const t of [0, 1_000, 5_000, 7_000, 12_345]) {
      const p = pickIdle(t, { statusText: '状态', tickMs: 1000, enabled: true })
      expect(p.text).toBe(pool[p.index])
      expect(p.size).toBe(pool.length)
      expect(p.pool).toEqual(pool)     // 探针读的就是这个（`data-idle-pool`）
      expect(p.index).toBeGreaterThanOrEqual(0)
      expect(p.index).toBeLessThan(p.size)
    }
  })

  it('池子编号与 text/size 同源（探针的三条断言共用一份数据，不会互相矛盾）', () => {
    for (const t of [0, 3_333, 9_999, 61_000]) {
      const p = pickIdle(t, { statusText: '状态', tickMs: 1000, enabled: true })
      expect(p.pool[p.index]).toBe(p.text)
      expect(p.pool.length).toBe(p.size)
    }
  })

  it('时间往前走 → 索引严格前进（同 tick 内不动，跨 tick 加一）', () => {
    const opts = { statusText: '状态', tickMs: 1000, enabled: true }
    const n = idlePool('状态').length
    expect(pickIdle(1_400, opts).index).toBe(pickIdle(1_000, opts).index)   // 同格内不动
    expect(pickIdle(2_000, opts).index).toBe((pickIdle(1_000, opts).index + 1) % n)
  })

  it('索引按池长回卷，不会溢出（探针的 index<size 断言才有意义）', () => {
    const opts = { statusText: '状态', tickMs: 1000, enabled: true }
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
