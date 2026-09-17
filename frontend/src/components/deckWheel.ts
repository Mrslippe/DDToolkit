/**
 * 牌堆滚轮决策（R40）—— **纯函数**，脱离 DOM 与时钟可测。
 *
 * 为什么要抽出来：滚轮的两条通道（离散格 / 连续流）与"手势分界"依赖**事件之间的时间差**，
 * 而探针跑在无头浏览器的**虚拟时间**下 —— 两次 `dispatchEvent` 之间时钟也会推进，
 * 150ms 静默分界根本复现不了（实测：8px 的连续流累积永远到不了阈值，判定成"每个事件都是新手势"）。
 * 本仓的分工是**纯逻辑进单测、集成进探针**，所以把决策抽到这里，用确定性时间戳测全部分支。
 *
 * 两条通道（用户 2026-09-19 拍板）：
 *   - **离散格**（鼠标滚轮，单次 |Δ| ≥ 40）：**每格一张**，快拨就连续翻；
 *   - **连续流**（触控板/触屏，单次 |Δ| < 40）：累积到阈值切一张，**同一次手势内不再切**
 *     （惯性尾巴不会一划飞到底）；手势分界 = 静默 150ms。
 * 两者共用一把**软锁 150ms**（只为防同一次爆发的重复触发，**不等于动画全长** —— 动画可被打断重定向），
 * 锁内离散格最多记 2 格欠账（不吞输入，也不让它追着跑）。
 */

export const WHEEL_NOISE = 4        // 小于它：触控板抖动，不算手势
export const WHEEL_NOTCH = 40       // ≥ 它：鼠标滚轮的一格
export const SMOOTH_STEP = 60       // 连续流累积到它才切
export const GESTURE_GAP_MS = 150   // 连续流的手势分界
export const LOCK_MS = 150          // 软锁
export const MAX_CREDIT = 2         // 锁内最多记几格欠账

export interface WheelState {
  /** 连续流累积量 */
  acc: number
  /** 本次连续流手势是否已切过 */
  smoothUsed: boolean
  /** 上一个滚轮事件的时间戳 */
  lastAt: number
  /** 软锁到期时间 */
  lockUntil: number
  /** 欠账（锁内攒下的格数，正 = 向下） */
  credit: number
}

export const initialWheelState = (): WheelState => ({
  acc: 0, smoothUsed: false, lastAt: 0, lockUntil: 0, credit: 0,
})

export type WheelAction =
  | { kind: 'none' }
  | { kind: 'step'; dir: 1 | -1 }
  | { kind: 'credit' }
  | { kind: 'release'; dir: 1 | -1 }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** 一个滚轮事件 → 动作 + 新状态（不改原对象） */
export function wheelAction(
  s: WheelState, deltaY: number, now: number,
): { action: WheelAction; state: WheelState } {
  if (Math.abs(deltaY) < WHEEL_NOISE) return { action: { kind: 'none' }, state: s }
  const dir: 1 | -1 = deltaY > 0 ? 1 : -1
  const notch = Math.abs(deltaY) >= WHEEL_NOTCH

  if (!notch) {
    // 连续流：静默够久算新手势
    const fresh = now - s.lastAt > GESTURE_GAP_MS
    const acc = (fresh ? 0 : s.acc) + deltaY
    const base: WheelState = { ...s, lastAt: now, acc, smoothUsed: fresh ? false : s.smoothUsed }
    if (base.smoothUsed) return { action: { kind: 'none' }, state: base }
    if (Math.abs(acc) < SMOOTH_STEP) return { action: { kind: 'none' }, state: base }
    return {
      action: { kind: 'step', dir },
      state: { ...base, acc: 0, smoothUsed: true, lockUntil: now + LOCK_MS },
    }
  }

  // 离散格
  if (now < s.lockUntil) {
    return {
      action: { kind: 'credit' },
      state: { ...s, lastAt: now, credit: clamp(s.credit + dir, -MAX_CREDIT, MAX_CREDIT) },
    }
  }
  return {
    action: { kind: 'step', dir },
    state: { ...s, lastAt: now, acc: 0, lockUntil: now + LOCK_MS },
  }
}

/**
 * 相位结束（动画放完）时消化一格欠账。
 * 返回 `release` 表示"还要再切一张"，`none` 表示欠账已清空。
 */
export function releaseAction(s: WheelState): { action: WheelAction; state: WheelState } {
  if (s.credit === 0) return { action: { kind: 'none' }, state: s }
  const dir: 1 | -1 = s.credit > 0 ? 1 : -1
  return {
    action: { kind: 'release', dir },
    state: { ...s, credit: s.credit - dir, lockUntil: performance.now() + LOCK_MS },
  }
}
