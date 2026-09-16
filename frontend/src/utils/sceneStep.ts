/**
 * 场景机的「一步决策」（纯函数，devlog/133）。
 *
 * 为什么单独一个文件：`hooks/useSceneTransition` 要 React 渲染环境才跑得起来，
 * 而本仓 vitest 跑在 **node 环境**（无 jsdom / 无 testing-library）——
 * 「连点不重播退场」这条规则必须有单测钉住，所以把**判断**与**执行**拆开：
 * 判断在这里（纯函数、可穷举），执行留在 hook（setState / 定时器）。
 *
 * ## 规则（顺序即优先级）
 *
 * 1. **连点：退场已经为别的目标播过**（`exiting && !exitingIsForTarget`）⇒ 新目标不再等第二轮，
 *    直接 `commit` —— 用户连点时想要的是「快去那边」，不是再看一遍淡出；旧内容已经（或正在）
 *    淡出过，直接落地**不会**闪出「正在加载」。
 *    ⚠️ 两条例外，都会退化成"等"：① 换 V 而数据还没预取好 ⇒ `wait-prefetch`
 *    （提交没有数据的场景才是真的闪帧）；② 退场是**为当前目标**播的 ⇒ 继续等它自己的定时器
 *    （见下条，这条不是连点）；
 * 2. 目标没变：在退场 ⇒ 重新挂上退场定时器；否则 `idle`；
 * 3. 目标变了：换 V 且未就绪 ⇒ `wait-prefetch`（旧内容可见冻结）；其余 ⇒ `exit`（退场后提交）。
 *
 * ## `exitingIsForTarget` 为什么必须单独传（这是第一版的 bug）
 *
 * 「退场中」≠「连点」。把 `exiting` 一路当连点判，会踩到一个隐蔽的自递归：
 * 退场是**状态**，`setScene(exiting:true)` 会让 effect 自己再跑一遍 ——
 * 那一遍的目标没变、退场态却是刚置上的，于是"退场中 ⇒ 立刻提交"当场把退场**整个跳过**
 * （探针实测：单次切换从 210ms 掉到 15ms，退场动画一帧都没播）。
 * 所以要能区分"为**当前目标**播的那轮退场"（继续等）与"为**别的目标**播的退场"（连点，跳）。
 */

/** 场景机的下一步动作 */
export type SceneStep =
  /** 无需动作 */
  | { kind: 'idle' }
  /** 立刻提交（连点跳过重播退场） */
  | { kind: 'commit' }
  /** 等预取完成再重入门控；旧内容保持可见冻结 */
  | { kind: 'wait-prefetch' }
  /** 退场 `waitMs` 后提交 */
  | { kind: 'exit'; waitMs: number }

export interface SceneStepArgs {
  /** 目标账号 ≠ 已提交账号 */
  accChanged: boolean
  /** 目标视图 ≠ 已提交视图 */
  viewChanged: boolean
  /** 此刻正处于退场态（`view-body` 挂着 `.scene-exit`） */
  exiting: boolean
  /** 这轮退场是**为当前目标**播的（hook 用 ref 记着它属于谁） */
  exitingIsForTarget: boolean
  /** 目标账号的数据是否已预取就绪（只在 `accChanged` 时有意义） */
  ready: boolean
  /** 退场时长，见 `useSceneTransition.EXIT_MS` */
  exitMs: number
}

export function planSceneStep({
  accChanged, viewChanged, exiting, exitingIsForTarget, ready, exitMs,
}: SceneStepArgs): SceneStep {
  // ① 连点：退场是为别的目标播的 ⇒ 新目标立刻落地
  if (exiting && !exitingIsForTarget) {
    return accChanged && !ready ? { kind: 'wait-prefetch' } : { kind: 'commit' }
  }
  // ② 目标没变：退场还在跑（或刚置上）⇒ 重新挂定时器，别把退场掐了
  if (!accChanged && !viewChanged) {
    return exiting ? { kind: 'exit', waitMs: exitMs } : { kind: 'idle' }
  }
  // ③ 目标变了：数据没就绪就先等，否则退场后提交
  if (accChanged && !ready) return { kind: 'wait-prefetch' }
  return { kind: 'exit', waitMs: exitMs }
}
