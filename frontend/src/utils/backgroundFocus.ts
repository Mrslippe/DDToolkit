/**
 * 背景取景（需求 7，2026-10-07，`devlog/418`）：把库里那串 JSON 变成一个 CSS `transform`。
 *
 * ## 为什么用 `transform` 而不是 `background-position`
 *
 * 背景层是 `.hero-backdrop`（`background-size: cover` + `background-position: center`）。
 * 用 `background-position` 平移**得先让图比容器大**，而"大多少"取决于**图片宽高比**与容器宽高比 ——
 * CSS 里拿不到（`cover` 没法乘一个倍数）。`transform` 不用知道这些，而且平移范围**天然被缩放倍数卡住**：
 *
 * ```
 * 元素宽 W、缩放 s ⇒ 溢出总量 (s-1)·W、左右各一半 ⇒ 平移上限 (s-1)/2·W
 * 取 x∈[0,1]（0.5 = 居中）⇒ translateX = (0.5-x)·(s-1)·100%   ← 恰好在边界上
 * ```
 *
 * ⇒ **永远露不出边**（用户要的是"取景"，不是"把图挪开让底色露出来"）。
 *
 * ## 方向口径（V1b-2 定案，`devlog/419`）
 *
 * `x`/`y` = **取景点在图片上的归一化位置**，**与 CSS `object-position` 同向**：
 * `x=0` 看到图片左边缘、`x=1` 看到右边缘（`y` 同理，0 = 上边缘）。
 * 所以公式里的符号是 **`(0.5-x)`**：`x` 越大 ⇒ 图**往左**推 ⇒ 露出的正是右半张。
 *
 * 验算（s=2、x=1、`transform-origin` 默认 center）：缩放后图占 [-W/2, 3W/2]，
 * `dx = -50%` ⇒ 挪成 [-W, W] ⇒ 窗口 [0,W] 里看到的正是缩放图的右半 = 原图右半 ✓。
 *
 * ⚠️ V1b-1 写的是 `(x-0.5)`（**反的**）：那一批只有"存/取/套用"，没有交互，
 *    符号没人能证伪；V1b-2 一上手拖拽就露馅（往右拖反而看到左半张）。
 *
 * ## 口径
 *
 * - `x`/`y` 是 **0..1 的比例**（不是像素）：窗口尺寸/DPR 变了取景不该跟着跑（与库里的口径一致）；
 * - `scale` 是 **1..3 的倍数**，1 = 原样铺（`transform` 整个不生成，DOM 保持干净）；
 * - ⚠️ **坏 JSON 必须退回"原样铺"**（`null`），不许白屏 —— 这一格是能被手工改坏的
 *   （`VTuberOut.background_focus` 给的是 JSON 原文，见 `app/schemas/vtuber.py`）。
 */
export interface BackgroundFocus {
  x: number
  y: number
  scale: number
}

/** 居中、不缩放 —— 也就是"没有取景"。 */
export const FOCUS_CENTER: BackgroundFocus = { x: 0.5, y: 0.5, scale: 1 }
/** 与后端 `BackgroundFocusIn` 的三个边界一致（越界在那个入口就被 422 挡住了）。 */
export const FOCUS_MIN_SCALE = 1
export const FOCUS_MAX_SCALE = 3

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** 夹进合法域（拖到界外时用；**不抛** —— 交互里夹住比报错合适）。 */
export function clampFocus(f: BackgroundFocus): BackgroundFocus {
  return {
    x: clamp01(f.x),
    y: clamp01(f.y),
    scale: Math.min(FOCUS_MAX_SCALE, Math.max(FOCUS_MIN_SCALE, f.scale)),
  }
}

/** 读库里的 JSON 原文。**任何异常一律 `null`**（= 原样铺），绝不抛。 */
export function parseBackgroundFocus(raw: string | null | undefined): BackgroundFocus | null {
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Partial<BackgroundFocus>
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null
    // ⚠️ 这里**不把"等价于居中"的值折成 null**：x/y 是用户存下来的意图
    //    （scale=1 时它看不出效果，但等他调大缩放就该还在那儿）。折成 null 会把这个意图吃掉。
    //    "看不出效果就不生成 transform"是 `focusTransform` 的事。
    return clampFocus({
      x: num(d.x, FOCUS_CENTER.x),
      y: num(d.y, FOCUS_CENTER.y),
      scale: num(d.scale, FOCUS_CENTER.scale),
    })
  } catch {
    return null
  }
}

/** 写回库里的形状（与后端 `json.dumps({"x","y","scale"})` 一致）。 */
export function serializeBackgroundFocus(f: BackgroundFocus): string {
  const c = clampFocus(f)
  return JSON.stringify({ x: c.x, y: c.y, scale: c.scale })
}

/**
 * 取景对应的 `transform`。
 *
 * ⚠️ **看不出效果的取景返回 `undefined`**（连属性都不生成）：`scale === 1` 时本来就**没有溢出**
 * ⇒ `dx`/`dy` 恒为 0 ⇒ 一个恒等变换除了让 DOM 多一个属性之外什么都不做。
 * （注意"居中 + 放大"**不是**这种情况：那时 `translate` 确实是 0，但 `scale` 本身有效果。）
 *
 * ⚠️ 顺序是 `translate(...) scale(...)`：**先缩放、后平移**。反过来会先平移再放大，
 * 位移被一起放大 ⇒ 同样的 `x` 在不同 `scale` 下跑到不同的地方（拖到哪儿就不对了）。
 */
export function focusTransform(f: BackgroundFocus | null): string | undefined {
  if (!f) return undefined
  const c = clampFocus(f)
  if (c.scale === 1) return undefined
  const dx = (0.5 - c.x) * (c.scale - 1) * 100
  const dy = (0.5 - c.y) * (c.scale - 1) * 100
  return `translate(${dx}%, ${dy}%) scale(${c.scale})`
}
