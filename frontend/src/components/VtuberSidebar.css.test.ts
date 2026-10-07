/**
 * 左栏"收起 + 常态隐藏的拉手"的 **CSS 契约**（需求 6，`devlog/429`；视觉版 `devlog/430`）。
 *
 * 为什么必须是 CSS 判据：**jsdom 没有布局也没有过渡** —— 把 `margin-left` 删掉、把拉手改成
 * `visibility: hidden`，组件用例照样全绿（`data-collapsed` 还在、按钮还在），
 * 而真机上要么"收起"没生效、要么**拉手再也点不开**（用户要的是"常态隐藏"而不是"消失"）。
 *
 * 2026-10-07 视觉版的两处口径变更（用户要求）：
 * ① 收起手法从 `width: 0` 换成**负外边距** —— 只有位移能**动画**（三段收起动画要用）；
 * ② 拉手**两种状态下都常态隐藏**（展开态不再常驻半透明）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(HERE, '../styles/layout.css'), 'utf8')

/** 取某条**选择器**（行首锚定）的规则体；⚠️ 别用 `includes`：注释里的同一句话会满足它。 */
function ruleBody(selector: string): string {
  const re = new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm')
  const m = re.exec(css)
  expect(m, `layout.css 里找不到规则 ${selector}（改名了？）`).toBeTruthy()
  return css.slice(m!.index, css.indexOf('}', m!.index))
}

describe('左栏：收起与拉手的 CSS 契约', () => {
  it('★ 收起 = **负外边距**（可动画），且子元素**一个都不藏**（列表原样留在 DOM 里）', () => {
    const body = ruleBody(".sidebar-shell[data-collapsed='1']")
    expect(body, '推出视口：只有位移能动画').toMatch(/margin-left:\s*calc\(-1\s*\*\s*var\(--sidebar-width\)\)/)
    expect(body, '⚠️ 别退回 width:0 —— 那样动不了').not.toMatch(/width:\s*0/)
    expect(body, '⚠️ 更不许 display:none（"v 列表不变化"）').not.toMatch(/display:\s*none/)
    // 没有任何"把子元素藏起来"的规则（老版本有一条 `> :not(.solo-rail-handle)`）
    expect(css, '子元素不许被藏').not.toContain(".sidebar-shell[data-collapsed='1'] > :not")
  })

  it('★ 拉手**两种状态下都常态隐藏**，但仍可命中（`opacity: 0`，不许 `visibility`/`pointer-events`）', () => {
    const body = ruleBody('.solo-rail-handle')
    expect(body, '常态隐藏').toMatch(/opacity:\s*0/)
    expect(body, '⚠️ 用 visibility/pointer-events 藏 = 再也点不开').not.toMatch(/visibility:/)
    expect(body).not.toMatch(/pointer-events:\s*none/)
    // 悬停/键盘聚焦要现身
    expect(css).toContain('.solo-rail-handle:hover')
    expect(css).toContain('.solo-rail-handle:focus-visible')
    // ⚠️ 展开态**不再**有常驻半透明（用户口径：两种状态都自动隐藏）
    expect(css, '展开态那条 "常驻半透明" 必须撤掉')
      .not.toContain(".sidebar-shell:not([data-collapsed='1']) .solo-rail-handle")
  })

  it('命中区向外扩一圈（15px 的隐形条扫不到就白搭）', () => {
    expect(ruleBody('.solo-rail-handle::after')).toMatch(/inset:\s*-/)
  })
})
