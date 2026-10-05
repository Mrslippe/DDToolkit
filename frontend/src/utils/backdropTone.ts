/**
 * 背景图亮度 → 「该配深字还是浅字」（2026-10-05，`devlog/355`）。
 *
 * ## 来由
 *
 * 用户（附截图，圈出「未开播」标签与签名那一行）：
 * 「可以让 card 视图中的红框圈出来的元素的颜色随着底图颜色来变化以提升醒目度，
 *  因为当前灰字在深色背景下还是不清楚」。这两处原本是**固定灰字**（`rgba(94,94,94,.76)`），
 * 压在用户自己上传的背景图上，深色图里就糊了。
 *
 * ## ⚠️ 为什么量在**前端**（而不是后端）
 *
 * 第一版写在后端（PIL 打开文件算平均亮度），跑测试才发现**这个项目根本没有 Pillow**
 * （上传校验只认文件头 magic，见 `services/vtuber_background.py`）—— 为一个纯观感特性
 * 引一个大依赖不划算。而浏览器本来就**必须解码这张图**（它就是背景），canvas 顺手就量了；
 * 后端 CORS 是放开的（`main.py` 的 `CORS_ORIGINS`），`crossOrigin="anonymous"` 下画布
 * 不会被污染，`getImageData` 读得到。
 *
 * ## 口径（与后端那版完全一致，换的只是"在哪算"）
 *
 * - **只对自定义背景算**：没上传背景时铺的是头像，而头像是 `opacity: .18` 叠在白底面板上
 *   ⇒ 实际那一带**几乎是白的**，固定深字一直读得清。若拿头像原图去量，深色头像会被判成
 *   "深底 ⇒ 用白字"，而屏幕上其实是白底 ⇒ **反向做错**。所以头像态一律 `null`（保持原样）。
 * - **采样"中间那条横带"**（纵向 35%–65%）：英雄区（名字/签名/标签）在竖直中间，
 *   用户眼睛看到的是那一带；整图平均会被上下的暗角或亮天空带偏。
 *   ⚠️ 近似：背景是 `background-size: cover`（有裁切），不追求像素级对应，两档粗判够用。
 * - **要和纱罩一起算**：字压在"图 + 白纱罩"上。纱罩中段的**有效白度 ≈ 0.35**
 *   （`posts.css` 的 `.hero-backdrop.custom::after`，2026-10-05 降过一半）——
 *   `L_eff = L·(1−a) + a`。**这两处是同一件事的两半**：改 CSS 的 alpha 记得回来改这里。
 * - **量不到就不猜**：加载失败 / 画布被污染 / 环境没有 canvas ⇒ `null`，界面保持现在的字色。
 */

/** 纱罩在文字那一带的**有效白度**（白纱叠白底，取中段）。
 *
 *  ⚠️ 它现在有**两重身份**：
 *  ① 物理口径：CSS 那层白纱（`.hero-backdrop.custom::after`）中段的实际白度 —— 写它是为了
 *     让"合成后的亮度"对得上眼睛看到的东西；
 *  ② **调档旋钮**：2026-10-05 用户把它从 `0.35` 调到 `0.25` —— 调低 ⇒ 合成亮度更低 ⇒
 *     更容易判成"深底 ⇒ 用亮字"。也就是**这个数比实际纱罩白度更小一点，是故意的**
 *     （用户实测：有的图被判成亮底，而灰字压在图上仍然看不清）。
 *  再调就改这一个数；改 CSS 的纱罩 alpha 时也回来看看它。 */
export const VEIL_ALPHA_MID = 0.25
/** 合成后亮度低于它 = 这一带算"深底" ⇒ 用亮字。
 *  （0.5 是中间值；取 0.55 让判"深"的余量更大 —— 两档的**可读性余量不对称**：
 *   白字压在偏亮的杂块上比黑字压在偏暗的杂块上更容易糊，所以宁可多判"深"。） */
export const DARK_MAX = 0.55
/** 采样带（纵向比例）：英雄区（名字/签名/标签）所在的中段 */
export const BAND_TOP = 0.35
export const BAND_BOTTOM = 0.65

export type InkTone = 'dark' | 'light'

export interface ToneReading {
  /** `dark` = **这一带是深色的** ⇒ 三处（名字 / 开播胶囊 / 签名）统一用**亮字**；
   *  `light` = 浅色的 ⇒ 三处统一用**暗字**（由 `posts.css` 的 `.hero[data-ink=…]` 落地） */
  tone: InkTone
  /** 合成纱罩之后的亮度（0..1）——调阈值/旋钮时看它 */
  luminance: number
}

/** sRGB 加权亮度（不做线性化：这是"看起来多亮"的常用近似，我们只要两档粗判） */
function luminanceOf(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * **纯函数**：从一小块位图算两档（可单测 —— 判据都在这里，DOM 那层只是喂数据）。
 *
 * `pixels` 是 RGBA 平铺（canvas `getImageData().data` 的形状），`w`/`h` 是这块小图的尺寸；
 * 只取纵向 `[BAND_TOP, BAND_BOTTOM)` 那几行。空 / 尺寸不合法 ⇒ `null`（不猜）。
 */
export function toneFromBitmap(
  pixels: Uint8ClampedArray | number[],
  w: number,
  h: number,
): ToneReading | null {
  if (!w || !h || pixels.length < w * h * 4) return null
  const top = Math.max(0, Math.floor(h * BAND_TOP))
  const bottom = Math.min(h, Math.max(top + 1, Math.ceil(h * BAND_BOTTOM)))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      r += pixels[i]
      g += pixels[i + 1]
      b += pixels[i + 2]
      n += 1
    }
  }
  if (!n) return null
  const lum = luminanceOf(r / n, g / n, b / n)
  const effective = lum * (1 - VEIL_ALPHA_MID) + VEIL_ALPHA_MID
  return { tone: effective < DARK_MAX ? 'dark' : 'light', luminance: effective }
}

/** 取样小图的尺寸（够算平均亮度；越小越快，且天然做了降噪） */
const SAMPLE_W = 32
const SAMPLE_H = 18

/**
 * 量一张背景图的明暗 → `ToneReading`；量不到返回 `null`（调用方保持现在的字色）。
 *
 * ⚠️ `crossOrigin='anonymous'` **不能省**：图是后端跨源给的，不带它画布会被污染，
 * `getImageData` 直接抛（那就变成"永远量不到"）。后端 CORS 放开时这条才成立
 * —— 见 `app/main.py` 的 `CORS_ORIGINS`。
 */
export async function measureBackdropTone(url: string): Promise<ToneReading | null> {
  if (!url || typeof document === 'undefined') return null
  try {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const loaded = await new Promise<HTMLImageElement | null>((resolve) => {
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
    })
    if (!loaded) return null
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_W
    canvas.height = SAMPLE_H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(loaded, 0, 0, SAMPLE_W, SAMPLE_H)
    return toneFromBitmap(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data, SAMPLE_W, SAMPLE_H)
  } catch {
    // 画布被污染 / 解码失败 / 环境没有 canvas —— 一律"量不到"，界面照旧（不猜）
    return null
  }
}
