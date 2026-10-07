/**
 * 左栏拖动态的**样式契约**（`devlog/416`）。读真 CSS，钉两条最容易悄悄退化的：
 *
 * ① **拿起的标识不许用 `opacity`**：整行变淡是"禁用"的语言，还会把头像和名字一起弄淡 ——
 *    左栏最吃的就是"一眼认头像"。第一版就是 `.55` 虚化，被用户否掉了。
 * ② **过渡必须同时挂在基础 `.vtuber-item` 上**：松手 = 摘掉 `.dragging`，
 *    而 CSS 的过渡取自**变化后**的计算样式 ⇒ 只写在 `.dragging` 里的话，
 *    回弹那一拍元素身上没有 transition，会"啪"地跳回去（"放大有动画、缩小没有"）。
 *    ⚠️ 这条是**纯静态看一眼看不出来**的那种错，所以值得一条判据。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(HERE, 'layout.css'), 'utf8')

/**
 * 抠出某个选择器的规则体。
 *
 * ⚠️ **必须锚到"行首 + 紧跟 `{`"这个语法位置，不能用 `css.indexOf(选择器)`**：
 * 文件里的**注释**也会提到选择器名（本文件第一版就是这么假绿的 ——
 * 基础规则上面那段注释里写了 `.vtuber-item.dragging`，于是 `indexOf` 命中注释、
 * 抠出来的是隔壁 `.vtuber-item:hover` 的规则体，三条判据全绿）。
 * 同 `devlog/414` 那次 `toContain` 撞注释，是同一个坑的第二次。
 */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^\\s*${esc}\\s*\\{`, 'm').exec(css)
  expect(m, `layout.css 里找不到规则 ${selector}（改名了？）`).toBeTruthy()
  const open = (m as RegExpExecArray).index + (m as RegExpExecArray)[0].length
  return css.slice(open, css.indexOf('}', open))
}

describe('左栏拖动态：样式契约', () => {
  it('★ 拿起的标识是**投影 + 放大**，且**不许用 `opacity`**', () => {
    const drag = ruleBody('.vtuber-item.dragging')
    expect(drag, '要有放大').toMatch(/transform:\s*scale\(/)
    expect(drag, '要有投影').toMatch(/box-shadow:\s*0 /)
    expect(drag, '⚠️ 不许用整行变淡表达"拖动中"（那是"禁用"的语言）').not.toMatch(/opacity\s*:/)
  })

  it('★ 过渡**同时**写在基础规则上 —— 否则松手那一拍没有过渡（回弹会跳）', () => {
    const base = ruleBody('.vtuber-item')
    expect(base, '基础规则里的 transition 必须覆盖 transform').toMatch(
      /transition:[^;]*transform/)
    expect(base, '还要覆盖 box-shadow（投影也得跟着过渡）').toMatch(
      /transition:[^;]*box-shadow/)
  })

  it('放大从**左缘**起算（整行满宽，从中心放大会把左缘 3px 选中竖条裁掉）', () => {
    expect(ruleBody('.vtuber-item.dragging')).toMatch(/transform-origin:\s*left/)
  })

  it('拿起用 `--ease-pop`（本仓唯一允许过冲的那条），且**减少动态下只去动画、不撤状态**', () => {
    expect(ruleBody('.vtuber-item.dragging')).toMatch(/var\(--ease-pop\)/)
    const rm = css.slice(css.indexOf('prefers-reduced-motion: reduce'))
    expect(rm, '减少动态要保留放大与投影（它们是"哪条在拖"的唯一标识）')
      .toMatch(/transition-duration:\s*0s/)
  })
})
