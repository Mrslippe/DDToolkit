/**
 * 「连点进单推」的手势（需求 1，2026-10-08 用户口径，`devlog/450`）。
 *
 * 口径：先把某个 V **拖到左栏首位**，然后在**那一条**上连点 10 次进单推；
 * 用户确认要**3 秒窗口**（防误触 —— 日常反复点开这个 V 不该进单推）。退出仍用工具栏那枚按钮。
 *
 * 为什么单独一个纯模块：计数与"窗口过了没有"是**时间语义**，用真时钟写进组件里就只剩
 * "看起来能跑"；这里把 `now` 作为参数注入 ⇒ 判据可以精确构造"刚好 3 秒""超 1 毫秒"这些边界。
 * 组件（`VtuberItem`）只负责把 `Date.now()` 喂进来，并按 `hit` 决定要不要进单推。
 */

/** 需要连点的次数（用户口径「连续点击十次」）。 */
export const SOLO_GESTURE_CLICKS = 10

/** 窗口：这 10 次必须落在**第一次点击起的 3 秒内**（用户口径，防误触）。 */
export const SOLO_GESTURE_WINDOW_MS = 3000

/** 一次连点序列的状态（`startedAt` 是**第一次**点击的时刻）。 */
export interface ClickStreak {
  count: number
  startedAt: number
}

export interface StreakResult {
  /** 下一个状态；`hit` 为真时是 `null`（这一轮结束了，下次从 1 重新数）。 */
  streak: ClickStreak | null
  /** 这一次点击是否凑满了 10 次。 */
  hit: boolean
}

/**
 * 记录一次点击，返回下一个状态与"是否命中"。
 *
 * 三条规则：
 * 1. 没有序列、或**距第一次点击已超窗**（含时钟回拨这种异常）⇒ 以这次点击**重新开始**；
 * 2. 否则累加；满 `clicks` 次 ⇒ `hit`，并把序列清掉；
 * 3. ⚠️ 窗口量的是"**距第一次**"，不是"距上一次" —— 否则"每 2.9 秒点一次"也能凑满 10 次，
 *    而那正是要防的误触形态（断断续续地点同一个 V）。
 */
export function nextStreak(
  prev: ClickStreak | null,
  now: number,
  clicks: number = SOLO_GESTURE_CLICKS,
  windowMs: number = SOLO_GESTURE_WINDOW_MS,
): StreakResult {
  const fresh = prev === null || now < prev.startedAt || now - prev.startedAt > windowMs
  if (fresh) return { streak: { count: 1, startedAt: now }, hit: false }
  const count = prev.count + 1
  if (count >= clicks) return { streak: null, hit: true }
  return { streak: { count, startedAt: prev.startedAt }, hit: false }
}
