/**
 * 取景预览框的 **CSS 契约**（node 环境：jsdom 里 `import.meta.url` 不是 file:，读不了仓库里的 CSS ——
 * 同 `components/common/BackdropCrossfade.css.test.ts`）。
 *
 * 为什么这几条要用 CSS 判：**它们是纯样式，组件测试看不见**。
 * `width: 100%`（用户 2026-10-07 明确要求"取景框放大到宽度填充满"）改回写死的 132px、
 * 或者取景三件套被挪到外层，jsdom 里全都照样绿 —— 而真机上要么窄回去、要么 1px 描边变 2px。
 *
 * ⚠️ 一律用**行首锚定**正则取规则体：`css.includes('width: 100%')` 会被别处的同一句话满足
 * （第一版就是这么假绿过的，见 `devlog/414`/`416`）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(HERE, '../styles/posts.css'), 'utf8')

/** 取某条**选择器**（行首锚定）的规则体；取不到就当场报出来（改名的症状）。 */
function ruleBody(selector: string): string {
  const re = new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm')
  const m = re.exec(css)
  expect(m, `posts.css 里找不到规则 ${selector}（改名了？）`).toBeTruthy()
  return css.slice(m!.index, css.indexOf('}', m!.index))
}

describe('取景预览框：CSS 契约', () => {
  it('★ 预览框**占满整幅宽**（用户要求），且高度由比例推、不再是写死的 132×74', () => {
    const body = ruleBody('.vd-bg-preview')
    expect(body, '要填满宽度').toMatch(/width:\s*100%/)
    expect(body, '高度跟着宽度走').toMatch(/aspect-ratio:\s*16\s*\/\s*9/)
    expect(body, '⚠️ 别再退回缩略图尺寸').not.toMatch(/width:\s*132px/)
    expect(body, '⚠️ 更不许写死高度').not.toMatch(/[^-]height:\s*74px/)
  })

  it('取景三件套的**落点在内层**（挂外层会把 1px 描边放大成 2px）', () => {
    expect(ruleBody('.vd-bg-focus')).toMatch(/position:\s*absolute/)
    expect(ruleBody('.vd-bg-focus'), '内层必须铺满整框').toMatch(/inset:\s*0/)
    expect(ruleBody('.vd-bg-preview'), '溢出要在外层裁掉').toMatch(/overflow:\s*hidden/)
    expect(ruleBody('.vd-bg-preview'), '内层与框内控件要有定位包含块').toMatch(/position:\s*relative/)
  })

  it('框内控件都挂 `position: absolute`（重置钮在框里、读数与引导不会挡指针）', () => {
    for (const sel of ['.vd-focus-reset', '.vd-focus-zoom', '.vd-focus-hint']) {
      expect(ruleBody(sel), `${sel} 该是框内绝对定位`).toMatch(/position:\s*absolute/)
      expect(ruleBody(sel), `${sel} 要压在图上面`).toMatch(/z-index:\s*[12]|pointer-events:\s*none/)
    }
    // 拖拽手势只在**可操作**的那一态给：没背景图（"头像铺底"）时不该出现抓手
    expect(ruleBody('.vd-bg-preview.is-fit'), '触屏/触控板拖拽不许被当成滚动').toMatch(/touch-action:\s*none/)
  })

  it('背景区是竖排（预览在上、按钮在下）', () => {
    expect(ruleBody('.vd-bg-col')).toMatch(/flex-direction:\s*column/)
  })
})
