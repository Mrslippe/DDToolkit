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

  it('★ 背景视频层：`cover` 铺满 + **首帧就绪前透明**（`data-ready="0"`）', () => {
    // 少 `object-fit: cover` ⇒ 视频按原始尺寸贴在左上角；少那条 `[data-ready='0']{opacity:0}`
    // ⇒ 首帧出来之前先闪一帧黑（图明明已经在下面了）。
    const rule = css.slice(css.indexOf('.hero-backdrop-video {'))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toMatch(/object-fit:\s*cover/)
    expect(css, '就绪前的透明必须由属性选择器压住').toContain(".hero-backdrop-video[data-ready='0']")
    const dim = css.slice(css.indexOf(".hero-backdrop-video[data-ready='0']"))
    expect(dim.slice(0, dim.indexOf('}'))).toMatch(/opacity:\s*0/)
  })

  /**
   * ⚠️ **原来这里有一条判据**："有视频在全屏时背景层整个撤掉"（`devlog/381`）。
   *
   * 它随 B2 定案一起删掉了（2026-10-07，`devlog/409`）：那条规则的理由是
   * "全屏给合成器留一个干净的不透明表面"，而拆变量测下来**窗口底色/图层次数与丢帧无关**
   * （`devlog/402`/`404`，元凶是硬件视频解码）。⇒ 规则与判据一起还原，
   * 全屏时背景层回到"留在合成树里、被全屏黑底挡住"的原状。
   * 别把它当成"漏了"再补回来 —— 全貌见 `devlog/406` 的还原清单。
   */
})
