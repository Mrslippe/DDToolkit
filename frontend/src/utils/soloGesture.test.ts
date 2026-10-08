/**
 * 「连点进单推」手势的纯状态机（`devlog/450`）。
 *
 * 这一组判据就是"3 秒窗口"这句话的可执行版本，所以**每条边界都要点名**：
 * 刚好 3 秒、超 1 毫秒、时钟回拨、"每 2.9 秒点一次"这种最像误触的形态。
 */
import { describe, expect, it } from 'vitest'

import {
  SOLO_GESTURE_CLICKS,
  SOLO_GESTURE_WINDOW_MS,
  nextStreak,
  type ClickStreak,
} from './soloGesture'

/** 连点 `n` 次（每次 `stepMs`，第一次在 `t0`），返回每次的结果。 */
function clickMany(n: number, stepMs = 100, t0 = 1_000, clicks = SOLO_GESTURE_CLICKS,
                   windowMs = SOLO_GESTURE_WINDOW_MS) {
  let streak: ClickStreak | null = null
  const hits: boolean[] = []
  for (let i = 0; i < n; i++) {
    const r = nextStreak(streak, t0 + i * stepMs, clicks, windowMs)
    streak = r.streak
    hits.push(r.hit)
  }
  return hits
}

describe('连点进单推：3 秒窗口内的 10 次', () => {
  it('★ 头 9 次不命中、第 10 次命中（不是第 9 或第 11）', () => {
    const hits = clickMany(10)
    expect(hits.slice(0, 9).some(Boolean), '前 9 次一次都不许命中').toBe(false)
    expect(hits[9], '第 10 次命中').toBe(true)
    // 正对照：再多点一次**不**命中（命中后序列清零，重新从 1 数）
    expect(clickMany(11)[10]).toBe(false)
  })

  it('★ 距**第一次**刚好 3 秒 ⇒ 还算；超 1 毫秒 ⇒ 重新数（边界两侧各一条）', () => {
    // 头两次间隔 0，把"起点"钉在 t0；第 10 次落在 t0+3000（= 窗口内沿）
    let streak: ClickStreak | null = null
    for (let i = 0; i < 9; i++) streak = nextStreak(streak, 1_000, 10, 3_000).streak
    const atEdge = nextStreak(streak, 4_000, 10, 3_000)     // 距起点 3000ms
    expect(atEdge.hit, '刚好 3 秒：仍在窗口内').toBe(true)

    streak = null
    for (let i = 0; i < 9; i++) streak = nextStreak(streak, 1_000, 10, 3_000).streak
    const over = nextStreak(streak, 4_001, 10, 3_000)       // 距起点 3001ms
    expect(over.hit, '超 1 毫秒 ⇒ 不算，而且要从这次重新数').toBe(false)
    expect(over.streak, '重新开始 ⇒ 计数回到 1').toEqual({ count: 1, startedAt: 4_001 })
  })

  it('★「每 2.9 秒点一次」凑不满 —— 窗口量的是距**第一次**，不是距上一次', () => {
    // 10 次 × 2.9 秒：若按"距上一次"判就命中了，按"距第一次"则永远停在 1
    const hits = clickMany(10, 2_900)
    expect(hits.some(Boolean), '这正是要防的误触形态：断断续续点同一个 V').toBe(false)
  })

  it('间隔均匀的 10 次（每 100ms）落在窗口内 ⇒ 命中', () => {
    expect(clickMany(10, 100)[9]).toBe(true)
  })

  it('时钟回拨（now < startedAt）⇒ 当作新序列，不许凑数', () => {
    const first = nextStreak(null, 5_000)
    const back = nextStreak(first.streak, 4_000)
    expect(back.hit).toBe(false)
    expect(back.streak).toEqual({ count: 1, startedAt: 4_000 })
  })

  it('可调次数/窗口（旋钮是参数，不是写死的字面量）', () => {
    expect(clickMany(3, 10, 1_000, 3, 5_000)[2], '3 次、5 秒窗口').toBe(true)
  })
})
