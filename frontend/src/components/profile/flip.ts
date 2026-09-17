/**
 * 退避动画的几何（R37-P4c，规格 `docs/design-archive-cards.md` §5.2）。
 *
 * ## 为什么要 FLIP
 *
 * CSS Grid 的 `grid-column/grid-row` **不可过渡** —— 格子一变卡片就是"瞬移"。
 * FLIP 是标准的补偿做法：**F**irst（量旧位置）→ **L**ast（改完 DOM 量新位置）→
 * **I**nvert（先打上一个"抵消位移"的 transform，看着没动）→ **P**lay（下一帧撤掉它，
 * 带过渡 ⇒ 卡片从旧位置滑到新位置）。
 *
 * ## 为什么这几步要写成纯函数
 *
 * "退避看着顺不顺"没法靠肉眼举证，但**补偿量算错**是能算出来的：少减一个 `gap`、
 * 把行高当列宽、拿错参照系，都会得到"差一点点"的位移 —— 而那正是"看着有点怪"的来源。
 */

export interface CardPoint {
  x: number
  y: number
}

/** 小于这个位移不做动画（亚像素抖动不值得开一次过渡） */
export const FLIP_MIN_PX = 0.5

/** 位移越大给越多时间（规格 §3 第 3 条"时长由距离决定"）—— 超过一行（96px）用 slow 档 */
export const FLIP_ROW_PX = 96

/** FLIP 第一帧要打的补偿位移：从新位置"退回"旧位置的向量 */
export function flipDelta(from: CardPoint, to: CardPoint): CardPoint {
  return { x: from.x - to.x, y: from.y - to.y }
}

/** 值不值得为这张卡开一次过渡（位移够大） */
export function needsFlip(from: CardPoint, to: CardPoint): boolean {
  return Math.abs(from.x - to.x) >= FLIP_MIN_PX || Math.abs(from.y - to.y) >= FLIP_MIN_PX
}

/** 过渡时长（ms）：一行为 `--motion-base`(220)，跨 ≥2 行给 `--motion-slow`(320) */
export function flipDurationMs(dy: number): number {
  return Math.abs(dy) > FLIP_ROW_PX ? 320 : 220
}

/**
 * 两张卡的**位置**是否变了（只比位置、不比尺寸）。
 *
 * 尺寸变化（缩放）不走 FLIP：`scale` 会把内容压扁、`width/height` 动画会让内容重排，
 * 两条路都比"直接改尺寸"更难看 —— 缩放手柄本来就要求 1:1 跟手（规格 §5.4）。
 */
export function movedBetween(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): boolean {
  return from.x !== to.x || from.y !== to.y
}
