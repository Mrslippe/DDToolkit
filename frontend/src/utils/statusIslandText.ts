/**
 * 状态岛**文案切换**的状态机（R38 批 4「打断 / 重定向」）。
 *
 * ## 为什么抽成纯函数
 *
 * 与 `utils/sceneStep.ts` 同款理由：本仓 vitest 跑在 **node 环境**（无 jsdom / 无
 * testing-library），**hook 测不了** —— 而"连续换字**不重放、不排队**"必须有单测。
 * 所以把决策抽成纯函数，hook 只负责"按返回值设 state + 排定时器"。
 *
 * ## 它解决什么
 *
 * 原来 `.si-text` 挂 `key={text}` ⇒ 文案一变就**重挂载** ⇒ CSS `@keyframes` **从头重放**
 * （先 `opacity:0` 停 `--motion-lag`，再淡入）。连续换字时**每次都会闪一下**。
 *
 * 现在元素**保持挂载**，用 **transition** 驱动 ⇒ 换字走
 * 「旧文案撤 → 换字 → 新文案到位」（§4）。
 * **transition 的固有性质是"可重定向"** —— 中途再来新文案时它从**当前值**继续，
 * 而 keyframes 会重启。
 *
 * ## 为什么只有两相（没有单独的 `in`）
 *
 * 「离场比入场快」（§3 规则 2，80–100ms）**不需要额外的相** —— CSS 过渡用的是
 * **变化后**那一边的 `transition-duration`：进 `.is-out` 用 `out` 的（`--motion-instant` 90ms），
 * 回 `idle` 用基态的（`--motion-fast` 140ms）。所以 `idle ↔ out` 两相就够了，
 * 淡入就是"撤掉 `.is-out`"这一次过渡本身。
 */

/** 撤：§3 规则 2「撤离 80–100ms，且与容器回缩同时开始」⇒ 取 `--motion-instant`(90ms) */
export const TEXT_EXIT_MS = 90

/** `idle` 稳定（文案可见）· `out` 旧文案正在撤 */
export type TextPhase = 'idle' | 'out'

export interface TextState {
  /** **屏幕上真正渲染的**文案 —— `out` 阶段仍是**旧**的那一版（§4「旧文案先撤」） */
  readonly shown: string
  readonly phase: TextPhase
}

export interface TextStep {
  readonly state: TextState
  /** 该在多少 ms 后推进下一步；`null` = **不需要定时器**（含"打断，继续等原来那个"） */
  readonly scheduleMs: number | null
}

export const initialTextState = (text: string): TextState => ({ shown: text, phase: 'idle' })

/**
 * 一个事件 ⇒ 下一步。
 *
 * @param state      当前状态
 * @param incoming   **最新**想要的文案（可能与 `state.shown` 相同）
 * @param timerFired 本次调用是不是"定时器到点"（`false` = 文案变了 / 初次渲染）
 */
export function reduceText(state: TextState, incoming: string, timerFired: boolean): TextStep {
  if (state.phase === 'out') {
    // ⚠️ **打断语义**：撤的途中再来新文案 ⇒ 继续撤（不重排、不重启定时器）。
    // 定时器到点才换字，且换的是**当时最新**的 incoming。
    if (!timerFired) return { state, scheduleMs: null }
    return { state: { shown: incoming, phase: 'idle' }, scheduleMs: null }
  }
  // idle：只有真变了才动（相同文案不空跑）
  return state.shown === incoming
    ? { state, scheduleMs: null }
    : { state: { shown: state.shown, phase: 'out' }, scheduleMs: TEXT_EXIT_MS }
}

/** 给 CSS 用的阶段类名（`idle` 不加类） */
export function phaseClass(phase: TextPhase): string {
  return phase === 'idle' ? '' : ` is-${phase}`
}
