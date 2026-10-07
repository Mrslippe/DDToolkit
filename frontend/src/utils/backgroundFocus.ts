/**
 * 背景取景（需求 7）：把库里那串 JSON 变成一组 CSS 属性。
 *
 * ## 口径（2026-10-07 用户看完 `docs/design/background-fit/resize-drift.html` 后定：选 C）
 *
 * `x`/`y` = **图片锚点**：图片上 `(x, y)` 那一点，落在取景框的同一比例位置。
 * 与 CSS `object-position` / `background-position` **完全同向**：`x=0` 看左边缘、`x=1` 看右边缘
 * （`y` 同理，0 = 上边缘）。`scale` 是 1..3 的倍数，1 = 原样铺。
 *
 * ## 三件套必须一起出现（`focusStyle` 就是为此而存在）
 *
 * ```
 * background-size: cover          ← CSS 里写死（铺满，永不露底色）
 * background-position: x% y%      ← 锚点：决定"盖上哪一块"
 * transform: scale(s)             ← 缩放
 * transform-origin: x% y%         ← ⚠️ 支点必须与锚点同源，否则一放大锚点就漂
 * ```
 *
 * 为什么这样"对齐守恒"（把元素盒设成 `[0,W]×[0,H]`，`cover` 倍数 `k`，图片原始宽 `iw`，
 * 图片坐标 `u` 处的像素在**未缩放**时画在 `x·(W − k·iw) + k·u`）：
 *
 * ```
 * screen_x(u) = x·W + s·k·(u − x·iw)
 * ⇒ 取 u = x·iw（锚点本身）⇒ screen_x = x·W
 * ```
 *
 * ⇒ **锚点永远落在取景框的第 `x` 列，与窗口宽度无关、与缩放倍数也无关**。
 * 这正是「窗口拉宽时人物会变大、但你钉的那条线不动」——`cover` 的放大是几何必然，
 * 而锚点守恒是我们能给的保证（对比：旧口径存的是"溢出量的百分之几"，而溢出量本身随宽高比变，
 * 所以同一组数字换宽度就落到别处。见 `devlog/420`）。
 *
 * 两条附带的好性质（都用例钉着）：
 * - `x`/`y ∈ [0,1]` ⇒ **任何 `scale ≥ 1` 都不露边**：`x=0` 时支点就在图片左缘、放大后左缘仍在框内；
 * - `scale = 1` 时**取景依然有效**（纵/横哪条轴有溢出就能挪哪条）——旧口径下 `scale=1` 是个死值，
 *   当初还得靠"拖动时自动抬到 120%"绕过（`devlog/419`），现在那个权宜之计已经不需要了。
 *
 * ⚠️ 坏 JSON 必须退回"原样铺"（`null` ⇒ 一个属性都不生成），不许白屏 ——
 *    这一格是能被手工改坏的（`VTuberOut.background_focus` 给的是 JSON 原文，见 `app/schemas/vtuber.py`）。
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

/** `focusStyle` 的产物：**要么三件套齐全、要么一个都没有**（部分应用 = 锚点在放大后漂）。 */
export interface FocusStyle {
  backgroundPosition?: string
  transform?: string
  transformOrigin?: string
}

/** 同样的三件套，给**替换元素**（`<video>` / `<img>`）用：锚点走 `object-position`。 */
export interface FocusObjectStyle {
  objectPosition?: string
  transform?: string
  transformOrigin?: string
}

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
    //    （scale=1 时它照样管用 —— 见文件头"两条附带的好性质"）。折成 null 会把这个意图吃掉。
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
 * 百分比串：**限两位小数** —— 拖一下就是 `28.57142857142857%`，内联样式里既难看、
 * 判据里也得跟着写一长串浮点（库里那份不受影响，只有喂给 CSS 的这一份被收敛）。
 */
function pctStr(v: number): string {
  return `${Math.round(v * 10000) / 100}%`
}

/** 取景的公共部分：锚点串 + 缩放（`scale=1` 时为 `null` ⇒ 连变换都不生成）。 */
function parts(f: BackgroundFocus | null): { pos: string; scale: number | null } | null {
  if (!f) return null
  const c = clampFocus(f)
  const pos = `${pctStr(c.x)} ${pctStr(c.y)}`
  return { pos, scale: c.scale === FOCUS_MIN_SCALE ? null : c.scale }
}

/** 取景的 CSS 三件套（**背景图**：锚点走 `background-position`）。`null` ⇒ 空对象。 */
export function focusStyle(f: BackgroundFocus | null): FocusStyle {
  const p = parts(f)
  if (!p) return {}
  // ⚠️ 位置**照给**：`scale=1` 时纵向（或横向）往往还有溢出，取景是有用的
  if (p.scale === null) return { backgroundPosition: p.pos }
  return { backgroundPosition: p.pos, transform: `scale(${p.scale})`, transformOrigin: p.pos }
}

/**
 * 取景的 CSS 三件套（**替换元素**：`<video>` / `<img>`，锚点走 `object-position`）。
 *
 * 与 `focusStyle` 的几何**完全同构**：`object-fit: cover` + `object-position: x% y%` 与
 * `background-size: cover` + `background-position: x% y%` 是同一套"把内容的 x% 对齐到盒子的 x%"语义，
 * 再绕同一个 `transform-origin` 缩放 ⇒ 锚点守恒那套推导原样成立（见文件头）。
 *
 * ⚠️ 别拿 `focusStyle` 去喂 `<video>`：`background-position` 对替换内容**一点作用都没有**
 * （视频没有背景图），症状是"取景只在图片上生效、视频永远居中"。
 */
export function focusObjectStyle(f: BackgroundFocus | null): FocusObjectStyle {
  const p = parts(f)
  if (!p) return {}
  if (p.scale === null) return { objectPosition: p.pos }
  return { objectPosition: p.pos, transform: `scale(${p.scale})`, transformOrigin: p.pos }
}

/**
 * `cover` 的缩放倍数：图片（原始 `nat`）要铺满 `box` 需要放大多少。
 * 取景的**渲染**不需要它（`cover` / 百分比全是 CSS 自己算的）；
 * 只有**拖拽**需要 —— 拖 100px 到底该把锚点挪多少，取决于溢出量。
 */
export function coverScale(nat: { w: number; h: number }, box: { w: number; h: number }): number {
  if (nat.w <= 0 || nat.h <= 0) return 1
  return Math.max(box.w / nat.w, box.h / nat.h)
}

/**
 * 拖拽换算：屏幕上挪 `dPx` 像素 ⇒ 锚点该挪多少。
 *
 * 推导（见文件头）：`screen_x(u) = x·W + s·k·(u − x·iw)` ⇒ `d(screen_x)/dx = W − s·k·iw`
 * ⇒ `Δx = dPx / (W − s·k·iw)`。分母就是**负的溢出量**，所以往右拖（`dPx > 0`）得到负的 `Δx`
 * ⇒ 图跟着指针往右走 ✓。
 *
 * ⚠️ 分母趋零（这条轴正好铺满、没余量可挪）时返回 0：不挪比"挪出一个巨大跳变"好 ——
 *    竖图铺在宽面板里，横向本来就没有可挪的余地，这是**正确**的结果而不是失灵。
 */
export function panDelta(dPx: number, boxPx: number, imgPx: number, scale: number): number {
  const denom = boxPx - scale * imgPx
  if (!Number.isFinite(denom) || Math.abs(denom) < 1) return 0
  return dPx / denom
}
