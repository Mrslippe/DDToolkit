// @vitest-environment jsdom
/**
 * 右栏背景层的**不闪白**契约（2026-10-06 用户实测，devlog/378）。
 *
 * 症状：换 V 时 "背景从 100% 到 0 再到 100%"，中间能看见明显白闪。成因是原先的单层写法
 * （`key={backdropSrc}` + `animation: backdrop-in`）：旧层**当场卸载**、新层从 0 淡入
 * ⇒ 那一帧底下只剩面板底色。
 *
 * 所以这里守的是三条：
 * ① 换图的那一刻，**旧层仍然在、并且还没开始淡出**（`is-prev` 是新图 load 之后才挂的）；
 * ② 交换之后两层同时在（新在下、旧在上淡出）⇒ 任何时刻都有一层不透明；
 * ③ 新图**加载失败**时保持现状（显示旧图），绝不提前把旧层换掉。
 *
 * ⚠️ jsdom 不会真的加载图片，所以这里替换 `window.Image` 为可控桩：测试自己决定
 * 什么时候触发 `onload`/`onerror` —— 这正是"预加载之后才交换"这条时序的判据。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BACKDROP_FADE_MS, BackdropCrossfade } from './BackdropCrossfade'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

/** 可控的 Image 桩：记下每个 src，测试手动触发 onload / onerror。 */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private _src = ''
  static pending: FakeImage[] = []
  set src(v: string) { this._src = v; FakeImage.pending.push(this) }
  get src() { return this._src }
}

let host: HTMLDivElement
let root: Root

const layers = () => Array.from(document.querySelectorAll<HTMLElement>('[data-backdrop]'))
const byKind = (kind: string) => layers().filter((el) => el.dataset.backdrop === kind)

async function render(src: string | null, custom = false) {
  await act(async () => { root.render(<BackdropCrossfade src={src} custom={custom} />) })
}

/** 最后一个（= 最新一次）预加载。⚠️ 不用 `Array.at()`：本仓的 TS lib target 不含 ES2022。 */
const lastPending = () => FakeImage.pending[FakeImage.pending.length - 1]

/** 让最新一次预加载"成功"。 */
async function loadLatest() {
  const img = lastPending()
  await act(async () => { img.onload?.() })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  FakeImage.pending = []
  vi.stubGlobal('Image', FakeImage)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('背景层：换图不闪白', () => {
  it('第一层不做淡入（直接不透明），也没有"正在淡出"的层', async () => {
    await render('https://x/a.jpg')
    expect(layers()).toHaveLength(1)
    expect(byKind('first')).toHaveLength(1)
    expect(byKind('prev')).toHaveLength(0)
  })

  it('**新图加载完之前不动旧层**（这是"没有白闪"的那一半）', async () => {
    await render('https://x/a.jpg')
    await render('https://x/b.jpg')          // 触发了预加载，但还没 load
    expect(lastPending()!.src).toBe('https://x/b.jpg')
    expect(layers(), '旧层必须还在、且不该开始淡出').toHaveLength(1)
    expect(byKind('prev'), '加载完成前不许挂 is-prev').toHaveLength(0)
  })

  it('加载完成 ⇒ 新层垫在下面、旧层在上淡出（两层同时在）', async () => {
    await render('https://x/a.jpg')
    await render('https://x/b.jpg')
    await loadLatest()

    expect(layers()).toHaveLength(2)
    const prev = byKind('prev')
    const cur = byKind('cur')
    expect(prev).toHaveLength(1)
    expect(cur).toHaveLength(1)
    expect(prev[0].className, '淡出层要挂 is-prev（CSS 靠它 z-index:1 + backdrop-out）')
      .toContain('is-prev')
    expect(cur[0].className).not.toContain('is-prev')
    expect(cur[0].style.backgroundImage).toContain('b.jpg')
  })

  it('淡出结束（250ms）后旧层被摘掉，只剩当前层', async () => {
    vi.useFakeTimers()
    await render('https://x/a.jpg')
    await render('https://x/b.jpg')
    await loadLatest()
    expect(layers()).toHaveLength(2)

    await act(async () => { vi.advanceTimersByTime(BACKDROP_FADE_MS + 10) })
    expect(layers()).toHaveLength(1)
    expect(byKind('cur')).toHaveLength(1)
  })

  it('新图**加载失败** ⇒ 什么都不换（宁可显示旧图，也不闪一下白）', async () => {
    await render('https://x/a.jpg')
    await render('https://x/b.jpg')
    await act(async () => { lastPending()!.onerror?.() })

    expect(layers()).toHaveLength(1)
    expect(byKind('first')).toHaveLength(1)
    expect(document.body.innerHTML).toContain('a.jpg')
    expect(document.body.innerHTML).not.toContain('b.jpg')
  })

  it('快速连点换 V ⇒ 只留最后一张（中间那些不闪、也不堆积）', async () => {
    await render('https://x/a.jpg')
    await render('https://x/b.jpg')
    await render('https://x/c.jpg')          // b 还没 load 就被 c 取代
    await loadLatest()
    expect(layers()).toHaveLength(2)         // a（淡出中）+ c
    expect(byKind('cur')[0].style.backgroundImage).toContain('c.jpg')
  })

  it('★ 取景是**三件套**：位置 + 缩放 + 支点一起挂，支点与位置同源（devlog/420）', async () => {
    await act(async () => {
      root.render(<BackdropCrossfade src="https://x/a.jpg" custom focus={{ x: 0.3, y: 0.35, scale: 2 }} />)
    })
    const el = byKind('first')[0]
    // ⚠️ 少了 transformOrigin ⇒ 缩放绕中心走，锚点当场漂 —— 所以这一条必须在这里也钉住
    expect(el.style.backgroundPosition).toBe('30% 35%')
    expect(el.style.transform).toBe('scale(2)')
    expect(el.style.transformOrigin).toBe(el.style.backgroundPosition)
  })

  it('★ 正在淡出的那一层**跟自己的取景**（换 V 的 250ms 里旧图不许被新 V 的取景变换一下）', async () => {
    await act(async () => {
      root.render(<BackdropCrossfade src="https://x/a.jpg" custom focus={{ x: 0.1, y: 0.1, scale: 1 }} />)
    })
    await act(async () => {
      root.render(<BackdropCrossfade src="https://x/b.jpg" custom focus={{ x: 0.9, y: 0.9, scale: 3 }} />)
    })
    await loadLatest()
    const prev = byKind('prev')[0]
    const cur = byKind('cur')[0]
    expect(prev.style.backgroundPosition, '旧层还是旧取景').toBe('10% 10%')
    expect(prev.style.transform, '旧层不该被放大 3 倍').toBe('')
    expect(cur.style.backgroundPosition).toBe('90% 90%')
    expect(cur.style.transform).toBe('scale(3)')
  })

  // ── 需求 9：背景视频（devlog/424）────────────────────────────────────
  const video = () => document.querySelector<HTMLVideoElement>('.hero-backdrop-video')
  const loadVideo = async (el: HTMLElement | null) => {
    await act(async () => { el?.dispatchEvent(new Event('canplay')) })
  }

  it('★ 视频盖在同一层的图上，**首帧就绪之前整层透明**（图就是它的 poster，不许闪黑）', async () => {
    await act(async () => {
      root.render(<BackdropCrossfade src="https://x/a.jpg" custom videoSrc="/v/a.mp4" />)
    })
    const v = video()!
    expect(v, '视频要渲染出来（否则永远等不到 canplay）').toBeTruthy()
    expect(v.getAttribute('src')).toBe('/v/a.mp4')
    expect(v.dataset.ready, '还没 canplay ⇒ 透明，先看图').toBe('0')
    expect(byKind('first')[0].style.backgroundImage, '图仍在（它就是 poster 与兜底）')
      .toContain('a.jpg')
    // ⚠️ 自动播放必须同时 muted：Chromium 会拦掉"有声的 autoplay"
    expect(v.muted, 'autoplay 的前提是 muted').toBe(true)
    expect(v.loop).toBe(true)
    expect(v.autoplay).toBe(true)
    await loadVideo(v)
    expect(video()!.dataset.ready, 'canplay 之后才显出来').toBe('1')
  })

  it('★ 取景对视频同样生效，且走的是 `object-position` 那一套（不是 background-position）', async () => {
    await act(async () => {
      root.render(
        <BackdropCrossfade src="https://x/a.jpg" custom focus={{ x: 0.3, y: 0.35, scale: 2 }}
                           videoSrc="/v/a.mp4" />,
      )
    })
    const st = video()!.style
    expect(st.objectPosition).toBe('30% 35%')
    expect(st.transform).toBe('scale(2)')
    expect(st.transformOrigin, '支点与锚点同源').toBe('30% 35%')
    // 图层自己那份走 background-position —— 两者都在，别互相顶掉
    expect(byKind('first')[0].style.backgroundPosition).toBe('30% 35%')
  })

  it('★ 播不了 ⇒ 视频撤掉、**图还在**（收下"存得进、播不了"的文件也不至于变黑）', async () => {
    await act(async () => {
      root.render(<BackdropCrossfade src="https://x/a.jpg" custom videoSrc="/v/bad.mp4" />)
    })
    await act(async () => { video()!.dispatchEvent(new Event('error')) })
    expect(video(), '出错的视频元素要撤掉').toBeNull()
    expect(byKind('first')[0].style.backgroundImage, '背景层照旧是那张图').toContain('a.jpg')
  })

  it('★ 正在淡出的那一层放**自己那一段视频**（换 V 时旧背景不许被换成新 V 的）', async () => {
    await act(async () => {
      root.render(<BackdropCrossfade src="https://x/a.jpg" custom videoSrc="/v/a.mp4" />)
    })
    await act(async () => {
      root.render(<BackdropCrossfade src="https://x/b.jpg" custom videoSrc="/v/b.mp4" />)
    })
    await loadLatest()
    const prevV = byKind('prev')[0].querySelector<HTMLVideoElement>('.hero-backdrop-video')
    const curV = byKind('cur')[0].querySelector<HTMLVideoElement>('.hero-backdrop-video')
    expect(prevV!.getAttribute('src')).toBe('/v/a.mp4')
    expect(curV!.getAttribute('src'), '当前层换成新的').toBe('/v/b.mp4')
  })

  it('没有视频时**一个 `<video>` 都不渲染**（图片背景照常）', async () => {
    await act(async () => {
      root.render(<BackdropCrossfade src="https://x/a.jpg" custom />)
    })
    expect(video()).toBeNull()
  })
})
