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
})
