/**
 * 拖到边缘自动滚动（R37-P4d，规格 `docs/design-archive-cards.md` §5.7）—— 纯函数可单测。
 *
 * 用户口径（2026-09-19）：「抓着卡片**接近底部**的时候网格**自动向下拓展**，同时**自动向下翻页**，
 * 反之光标在顶部也一样；**拖动右下角改变大小**的时候同样适用 —— 与此同时**不要发生闪动和错位**」。
 *
 * ## 这一层只回答一个问题：这一帧该滚多快
 *
 * "下探"与"拓展"都是它的**结果**（规格 §5.7 的驱动方式）：`scrollTop` 涨 ⇒ 内容坐标位移
 * `D = P + S` 涨 ⇒ 模型下探 ⇒ 网格长高 ⇒ `scrollHeight` 变大 ⇒ 下一帧能滚更多。
 * 反过来做（先让模型下探再滚过去）必然闪 —— 网格按整行跳、滚动是连续的，两者会互相追。
 */

/** 触发区深度（上下各一条，px）：进入区即开始滚，越靠边越快 */
export const AUTO_SCROLL_ZONE_PX = 64

/** 最大速度（px/s）：贴边或指针移出容器时取它 */
export const AUTO_SCROLL_MAX_PX_S = 900

/**
 * 滚动跑道（px）：编辑态在画布底部留的余量，保证"永远还能往下滚"。
 *
 * 为什么必须有：内容短的时候 `scrollHeight == clientHeight` ⇒ 滚不动 ⇒ `S` 不涨 ⇒ 模型不动
 * ⇒ 网格不长 ⇒ 永远动不了（鸡生蛋）。240px ≈ 2.5 行：网格按整行跳、瞬时最多吃掉一行（96px），
 * 而平均消耗为 0（网格长高速度 ≡ 下探速度 ≡ 滚动速度）⇒ 跑道 ≥ 2 行就不会见底。
 */
export const AUTO_SCROLL_RUNWAY_PX = 240

export interface AutoScrollOptions {
  zonePx?: number
  maxPxPerSec?: number
}

/**
 * 指针纵坐标 → 期望滚动速度（px/s，**正 = 向下滚**）。
 *
 * 手感口径（规格 §5.7 的表）：
 * - 中间带（距两端都超过 `zonePx`）⇒ `0`（不动）；
 * - 进入下区 ⇒ 从 0 线性 ramp 到 `max`（区边缘 0、贴边 max）；
 * - **指针移出容器**（拖到窗口外）⇒ 该方向满速 —— 标准行为，不然拖出去就没反应了；
 * - **不设"停留延时"**：有延时会觉得卡住（进入即动、靠 ramp 控速）。
 */
export function autoScrollSpeed(
  pointerY: number, viewportTop: number, viewportBottom: number,
  opts: AutoScrollOptions = {},
): number {
  const zone = Math.max(1, opts.zonePx ?? AUTO_SCROLL_ZONE_PX)
  const max = opts.maxPxPerSec ?? AUTO_SCROLL_MAX_PX_S
  if (!(viewportBottom > viewportTop)) return 0        // 还没量到容器尺寸
  if (pointerY >= viewportBottom) return max           // 贴下缘 / 拖出容器下方
  if (pointerY <= viewportTop) return -max             // 贴上缘 / 拖出容器上方
  const fromBottom = viewportBottom - pointerY
  if (fromBottom < zone) return Math.round(max * (1 - fromBottom / zone))
  const fromTop = pointerY - viewportTop
  if (fromTop < zone) return -Math.round(max * (1 - fromTop / zone))
  return 0
}

/** 这一帧该滚到哪里（夹在 `[0, maxScrollTop]`）—— 与 `autoScrollSpeed` 分开，便于单测边界 */
export function nextScrollTop(
  scrollTop: number, speedPxPerSec: number, dtMs: number, maxScrollTop: number,
): number {
  if (!speedPxPerSec || dtMs <= 0) return scrollTop
  const next = scrollTop + (speedPxPerSec * dtMs) / 1000
  return Math.min(Math.max(next, 0), Math.max(0, maxScrollTop))
}
