/**
 * 背景层的 **CSS ↔ 组件常量** 契约（node 环境：jsdom 里 `import.meta.url` 不是 file:，
 * 读不了仓库里的 CSS —— 同 `utils/sceneStep.test.ts` 那条"退场动画必须短于提交定时器"）。
 *
 * 为什么必须绑在一起：`is-prev` 的淡出时长写在 CSS 里，而**摘掉旧层**的计时器写在组件里
 * （`BACKDROP_FADE_MS`）。CSS 比组件长 ⇒ 旧层在动画跑完前被摘掉（淡出被腰斩，看起来是"闪一下"）；
 * CSS 比组件短 ⇒ 旧层多留一会儿（透明层压在新层上，虽然看不见，但会一直在 DOM 里堆）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BACKDROP_FADE_MS } from './BackdropCrossfade'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(HERE, '../../styles/posts.css'), 'utf8')

describe('背景层：CSS 契约', () => {
  it('`is-prev` 的淡出时长与 BACKDROP_FADE_MS 同值', () => {
    const rule = css.slice(css.indexOf('.hero-backdrop.is-prev'))
    const ms = Number(/backdrop-out (\d+)ms/.exec(rule)?.[1])
    expect(ms, 'posts.css 里没读到 backdrop-out 的时长（规则改名了？）').toBe(BACKDROP_FADE_MS)
  })

  it('不透明度只有一处真源（`--backdrop-opacity`），淡出关键帧读的就是它', () => {
    // 写死两份的症状：自定义背景（1）在淡出时**先跳到 0.18 再淡出** —— 一次肉眼可见的变暗。
    expect(css).toContain('--backdrop-opacity: 0.18')
    expect(css).toContain('--backdrop-opacity: 1')
    const frames = css.slice(css.indexOf('@keyframes backdrop-out'))
    expect(frames).toContain('var(--backdrop-opacity)')
  })

  it('有视频在全屏时背景层整个撤掉（`devlog/381`：给全屏留一个干净的不透明表面）', () => {
    // 配套壳侧的 `set_surface_opaque`：那颗属性让 WebView2 不再走 alpha 合成，这条保证
    // 没有别的图层陪着一起画。⚠️ 类挂在 `<html>` 上（组件进/出全屏时增删 `data-video-fs`）。
    const rule = css.slice(css.indexOf('html[data-video-fs]'))
    expect(rule.slice(0, 120), '要有一条把 .hero-backdrop 撤掉的规则')
      .toMatch(/html\[data-video-fs\]\s+\.hero-backdrop\s*\{[^}]*display:\s*none/)
  })
})
