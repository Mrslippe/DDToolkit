/**
 * 档案视图的手势与动效口径（R37-P4b，规格 `docs/design-archive-cards.md` §5）。
 *
 * 为什么把这些**从组件里抠出来**：手感是这一批最容易"看着能忍、其实不对"的东西
 * （跟手差 40px 也像在拖、缩放没回到 1 也看不出来），做成纯函数才能用单测钉住。
 * 组件只负责把事件喂进来、把相位画出来。
 *
 * 用户口径（2026-09-18）：「编辑布局时的动画也制作成**移动手机小组件**的类似动画，
 * 例如**长按选中时弹跳缩放**、**其他卡片退避时的移动也有动画表现**、
 * **放置时也有落下缩放**等等」。
 */

/** 长按判定阈值（ms）—— **与 Hero 平台药丸的长按重排同值**：全站只教用户一个数字。 */
export const LONG_PRESS_MS = 350

/** 防抖阈值（px）：没超过它就算"手抖"，不当拖动（否则点一下就会挪卡片）。 */
export const DRAG_SLOP_PX = 6

/** 落位过渡（ms）+ 判定余量：探针等 `SETTLE_MS` 之后才判定"已经落定"。 */
export const SETTLE_MS = 220
export const SETTLE_GRACE_MS = 260

/** 卡片在一次手势里的相位（挂在 `data-card-phase` 上，探针按它判） */
export type CardPhase = 'idle' | 'pressing' | 'lifted' | 'settling'

/** 手势事件（按下 / 长按成立 / 移动 / 抬手 / 取消 / 落位完成） */
export type GestureEvent = 'down' | 'hold' | 'drag' | 'up' | 'cancel' | 'settled'

/**
 * 相位机。**只有这五种跳跃是合法的**，其余一律保持原相位 ——
 * 让"迟到的定时器"（长按计时器在抬手之后才触发）变成无害，而不是把卡片重新拿起来。
 */
export function nextPhase(phase: CardPhase, ev: GestureEvent): CardPhase {
  switch (ev) {
    case 'down':
      return 'pressing'
    case 'hold':
      return phase === 'pressing' ? 'lifted' : phase     // 抬手后才到的定时器无效
    case 'drag':
      return phase                                     // 跟手期间不改相位
    case 'up':
      return phase === 'lifted' ? 'settling' : 'idle'
    case 'cancel':
      return 'idle'
    case 'settled':
      return phase === 'settling' ? 'idle' : phase
    default:
      return phase
  }
}

/** 长按是否成立（单独抽出来：阈值只有一份，探针与组件都用它） */
export function isLongPress(elapsedMs: number): boolean {
  return elapsedMs >= LONG_PRESS_MS
}

/** 位移是否够得上"拖动"（斜向也适用：`hypot` 而不是只看某一轴） */
export function isDrag(dxPx: number, dyPx: number): boolean {
  return Math.hypot(dxPx, dyPx) >= DRAG_SLOP_PX
}

/**
 * **内容坐标位移**（R37-P4d，规格 §5.7）：`D = P + S`
 * —— 指针位移（视口坐标）+ 滚动量。模型目标格位与跟手补偿**都只喂 D**。
 *
 * 为什么：卡片的视口位置 = 内容位置 − scrollTop + transform。把 `D` 同时喂给
 * "模型格位"与"补偿"两处，`S` 在代入时正好抵消 ⇒ **卡片视口位置 ≡ 起点 + 指针位移**，
 * 与滚了多少无关 ⇒ 滚动过程中不可能漂、不可能跳（"不错位"是数学结论，不是调参结果）。
 * 漏掉 `S` 就会滞后/超前**恰好一个滚动量**。
 */
export function contentDelta(
  pointerDx: number, pointerDy: number, scrollDx = 0, scrollDy = 0,
): { x: number; y: number } {
  return { x: pointerDx + scrollDx, y: pointerDy + scrollDy }
}

/**
 * 跟手位移（规格 §5.1 的核心算式）：**卡片视觉位置 = 内容坐标位移 − 卡片所在格子的位移**。
 *
 * 拖动期间卡片仍住在自己的格子里（渲染结构不动），而格子会一格一格地换位；
 * 减去格子自身的位移，屏幕上就正好是"跟着手走"。取整到整像素是为了**文字不糊**：
 * 分数像素的 transform 会被合成器重采样，拖起来整张卡的字都是虚的。
 *
 * `scrollDx/scrollDy` 是 R37-P4d 加的（自动滚动时非 0）—— 见 `contentDelta` 的说明。
 */
export function liftOffset(
  pointerDx: number, pointerDy: number, cellDx: number, cellDy: number,
  scrollDx = 0, scrollDy = 0,
): { x: number; y: number } {
  return {
    x: Math.round(pointerDx + scrollDx - cellDx),
    y: Math.round(pointerDy + scrollDy - cellDy),
  }
}

export interface MotionPlan {
  /** 按下时的即时反馈缩放（1 = 不缩放） */
  pressScale: number
  /** 拾起时的缩放（一次性小过冲由 CSS 曲线给，这里只给终值） */
  liftScale: number
  /** 落位过渡时长（ms；0 = 直接到位，没有滑行） */
  settleMs: number
}

/**
 * 动效策略（reduced-motion 的**口径**，由 CSS 之外再写一份的原因见下）：
 *
 * `prefers-reduced-motion: reduce` 下**去掉缩放**（那是装饰），
 * **但保留 1:1 跟手** —— 跟手是输入反馈，不是动画；把它一起关掉等于"拖动失灵"，
 * 那不是"减少动效"，是把功能拿走了。落位也不滑行（直接到位）。
 *
 * 这份策略与 CSS 里的 `@media` 块**必须一致**：CSS 管阴影/过渡，这里管内联的 transform 终值。
 * 之所以不在 CSS 里一并做掉：内联 `transform: scale(1.055)` 的优先级高于媒体查询里的规则
 * （内联永远赢），所以"减少动效"必须在**写内联样式的那一侧**生效 —— 这份函数就是那一侧。
 */
export function motionPlan(reduced: boolean): MotionPlan {
  return reduced
    ? { pressScale: 1, liftScale: 1, settleMs: 0 }
    : { pressScale: 0.985, liftScale: 1.055, settleMs: SETTLE_MS }
}

/** 相位 → 卡片上的内联 transform（探针量与用户看到的是同一个来源） */
export function phaseTransform(phase: CardPhase, x: number, y: number,
                               plan: MotionPlan): string | undefined {
  switch (phase) {
    case 'pressing':
      return plan.pressScale === 1 ? undefined : `scale(${plan.pressScale})`
    case 'lifted':
      return `translate3d(${x}px, ${y}px, 0) scale(${plan.liftScale})`
    case 'settling':
    case 'idle':
    default:
      return undefined                                  // 交给 CSS 过渡回 none
  }
}
