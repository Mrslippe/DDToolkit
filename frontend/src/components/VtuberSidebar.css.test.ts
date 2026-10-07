/**
 * 左栏"整栏收起 + 常态隐藏的拉手"的 **CSS 契约**（需求 6，`devlog/429`）。
 *
 * 为什么必须是 CSS 判据：**jsdom 没有布局** —— 把 `width: 0` 删掉、或者把拉手改成
 * `visibility: hidden`，组件用例照样全绿（`data-collapsed` 还在、按钮还在），
 * 而真机上要么"收起"没生效、要么**拉手再也点不开**（用户明确要的是"常态隐藏"而不是"消失"）。
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

describe('左栏：单推的 CSS 契约', () => {
  it('★ 收起 = **宽度收成 0**（不是 `display: none`：拉手是这一栏的子元素）', () => {
    const body = ruleBody(".sidebar-shell[data-collapsed='1']")
    expect(body).toMatch(/width:\s*0/)
    expect(body, '整栏都没了拉手也没了').not.toMatch(/display:\s*none/)
    // 子元素逐个藏起来（拉手除外）
    expect(ruleBody(".sidebar-shell[data-collapsed='1'] > :not(.solo-rail-handle)"))
      .toMatch(/display:\s*none/)
  })

  it('★ 拉手**常态隐藏但仍可命中**（`opacity: 0`，不许用 `visibility` / `pointer-events`）', () => {
    const body = ruleBody('.solo-rail-handle')
    expect(body, '常态隐藏').toMatch(/opacity:\s*0/)
    expect(body, '⚠️ 用 visibility/pointer-events 藏 = 再也点不开').not.toMatch(/visibility:/)
    expect(body).not.toMatch(/pointer-events:\s*none/)
    // 悬停/键盘聚焦要现身（否则只有鼠标碰巧扫到才知道有它）
    expect(css).toContain('.solo-rail-handle:hover')
    expect(css).toContain('.solo-rail-handle:focus-visible')
  })

  it('展开态拉手常驻半透明（否则"怎么收回去"没人找得到）', () => {
    const body = ruleBody(".sidebar-shell:not([data-collapsed='1']) .solo-rail-handle")
    expect(body).toMatch(/opacity:\s*0?\.\d+/)
  })
})
