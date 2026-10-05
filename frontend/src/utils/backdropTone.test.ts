// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BAND_BOTTOM,
  BAND_TOP,
  DARK_MAX,
  VEIL_ALPHA_MID,
  measureBackdropTone,
  toneFromBitmap,
} from './backdropTone'

/**
 * 背景明暗 → 深/浅字（2026-10-05，`devlog/355`）。
 *
 * 用户：「（card 视图红框里的）元素的颜色随着底图颜色来变化以提升醒目度，
 * 因为当前灰字在深色背景下还是不清楚」。
 *
 * 这里钉的是**判定**那一层（纯函数）；DOM/canvas 那层只负责喂位图，
 * 由探针在真机上跑一次真图（`ui_probe` 的 cards 段会真的调 `measureBackdropTone`）。
 */

/** 造一块 w×h 的纯色位图（RGBA） */
function solid(w: number, h: number, r: number, g: number, b: number) {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i += 1) {
    px[i * 4] = r
    px[i * 4 + 1] = g
    px[i * 4 + 2] = b
    px[i * 4 + 3] = 255
  }
  return px
}

describe('背景明暗 → 字色档位', () => {
  it('深底 ⇒ `dark`（= 该用浅字）', () => {
    const out = toneFromBitmap(solid(8, 8, 18, 20, 34), 8, 8)!
    expect(out.tone).toBe('dark')
    expect(out.luminance).toBeLessThan(DARK_MAX)
  })

  it('浅底 ⇒ `light`（保持现在的深字）', () => {
    const out = toneFromBitmap(solid(8, 8, 245, 245, 248), 8, 8)!
    expect(out.tone).toBe('light')
    expect(out.luminance).toBeGreaterThan(DARK_MAX)
  })

  it('亮度是**合成纱罩之后**的（不是原图亮度）', () => {
    // 纯黑图：合成后应当正好等于纱罩自身的白度（1×a + 0）
    const out = toneFromBitmap(solid(4, 4, 0, 0, 0), 4, 4)!
    expect(out.luminance).toBeCloseTo(VEIL_ALPHA_MID, 5)
    // 纯白图：合成后仍是 1
    expect(toneFromBitmap(solid(4, 4, 255, 255, 255), 4, 4)!.luminance).toBeCloseTo(1, 5)
  })

  it('只看**中间那条横带**（上下再极端也不影响判定）', () => {
    // 上 1/3 纯黑、下 1/3 纯白、中间灰：若按整图平均会偏向中灰但也有差；
    // 关键判据：把上下两条换成别的颜色，结果必须**一模一样**。
    const w = 12
    const h = 12
    const make = (topColor: number[], bottomColor: number[]) => {
      const px = new Uint8ClampedArray(w * h * 4)
      const bandTop = Math.floor(h * BAND_TOP)
      const bandBottom = Math.ceil(h * BAND_BOTTOM)
      for (let y = 0; y < h; y += 1) {
        const c = y < bandTop ? topColor : y >= bandBottom ? bottomColor : [128, 128, 128]
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4
          px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255
        }
      }
      return px
    }
    const a = toneFromBitmap(make([0, 0, 0], [255, 255, 255]), w, h)!
    const b = toneFromBitmap(make([255, 0, 0], [0, 255, 0]), w, h)!
    expect(a.luminance).toBeCloseTo(b.luminance, 6)
  })

  it('量不到就返回 null（不猜）', () => {
    expect(toneFromBitmap(new Uint8ClampedArray(0), 0, 0)).toBeNull()
    expect(toneFromBitmap(new Uint8ClampedArray(4), 8, 8)).toBeNull()   // 数据比声明的尺寸短
  })
})

/**
 * DOM 那层（canvas）在 jsdom 里没有；用**打桩的 Image/canvas** 钉"接线对不对"。
 *
 * ⚠️ 这条**证明不了**浏览器里的真实行为（真 CORS、真解码）—— 探针也验不了（它跑在虚拟时间下，
 * 图片永远不加载）。所以这里只钉三件不靠浏览器的事：
 * ① 必须带 `crossOrigin='anonymous'`（不带 ⇒ 跨源画布被污染 ⇒ 永远量不到）；
 * ② 加载失败 / 拿不到 2d 上下文 ⇒ `null`（不抛、不猜）；
 * ③ 量到之后**恰好**按 `toneFromBitmap` 的口径给结果。
 */
describe('canvas 接线（打桩）', () => {
  const stubImage = (opts: { fail?: boolean } = {}) => {
    const created: { crossOrigin?: string } = {}
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      crossOrigin: string | null = null
      set src(_v: string) {
        created.crossOrigin = this.crossOrigin ?? undefined
        queueMicrotask(() => (opts.fail ? this.onerror?.() : this.onload?.()))
      }
    }
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image)
    return created
  }

  const stubCanvas = (pixels: number[] | null) => {
    const draw = vi.fn()
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return document.createElementNS('http://www.w3.org/1999/xhtml', tag)
      return {
        width: 0,
        height: 0,
        getContext: () => (pixels ? {
          drawImage: draw,
          getImageData: () => ({ data: new Uint8ClampedArray(pixels) }),
        } : null),
      } as unknown as HTMLCanvasElement
    }) as typeof document.createElement)
    return draw
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('带 crossOrigin 拉图 + 量出结果（深色）', async () => {
    const created = stubImage()
    // ⚠️ 打桩的位图必须是**取样小图那么大**（32×18）：给一小块会被 `toneFromBitmap`
    //    按"数据比声明的尺寸短"判成 null（第一版就这么写的，症状是 out=null）
    stubCanvas(Array.from(solid(32, 18, 16, 18, 30)))
    const out = await measureBackdropTone('http://127.0.0.1:9/static/custom_bg/x.png')
    expect(created.crossOrigin).toBe('anonymous')
    expect(out?.tone).toBe('dark')
  })

  it('加载失败 ⇒ null', async () => {
    stubImage({ fail: true })
    stubCanvas(Array.from(solid(32, 18, 0, 0, 0)))
    expect(await measureBackdropTone('http://x/y.png')).toBeNull()
  })

  it('拿不到 2d 上下文 ⇒ null', async () => {
    stubImage()
    stubCanvas(null)
    expect(await measureBackdropTone('http://x/y.png')).toBeNull()
  })
})
