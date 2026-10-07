/**
 * 单推模式的**视觉契约**（需求 6 视觉版，2026-10-07 用户口径，`devlog/430`）。
 *
 * 四条口径逐条钉住（**全是纯样式**：jsdom 没有布局也没有过渡，组件用例一条都验不到）：
 * 1. 三段收起是**固定顺序**：左栏 → 工具栏 → 顶栏（靠 `transition-delay` 递增表达）；
 * 2. 退出**倒着来**（顶栏先回、工具栏、最后左栏）；
 * 3. hover **唤出**顶栏/工具栏时，`transition-delay` 必须归零（否则慢半拍）；
 * 4. 全收起后的**延时淡出**只在 cards 视图、**不动背景层本身**、且纱罩要撤到 0；
 *    唤出时立刻恢复。
 *
 * ⚠️ 取规则体一律**行首锚定**（`includes` 会被注释里的同一句话满足 —— `devlog/414` 的假绿）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const layout = readFileSync(path.resolve(HERE, 'layout.css'), 'utf8')
const posts = readFileSync(path.resolve(HERE, 'posts.css'), 'utf8')

/** 取某条选择器的规则体（行首锚定；取不到就当场报出来）。 */
function body(css: string, selector: string): string {
  const re = new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{]`, 'm')
  const m = re.exec(css)
  expect(m, `找不到规则 ${selector}（改名了？）`).toBeTruthy()
  const end = css.indexOf('}', m!.index)
  // 多选择器时一路取到 `{` 之后的那一段
  const brace = css.indexOf('{', m!.index)
  return css.slice(brace, end)
}

/**
 * ⚠️ 同名选择器在文件里出现多次（`.topbar` / `.icon-rail` / `.sidebar-shell` 早在"入场动画"
 * 那一段就出现过）⇒ 必须挑**含目标声明的那一条**，否则会拿到别处的规则体而误判。
 */
function bodyWith(css: string, selector: string, needle: string): string {
  const re = new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{]`, 'gm')
  for (const m of css.matchAll(re)) {
    const brace = css.indexOf('{', m.index)
    const end = css.indexOf('}', brace)
    const b = css.slice(brace, end)
    if (b.includes(needle)) return b
  }
  expect(false, `${selector} 里找不到含 ${needle} 的那条规则`).toBe(true)
  return ''
}

const L = (s: string) => body(layout, s)
const P = (s: string) => body(posts, s)

describe('单推：分段收起与 hover 唤出', () => {
  it('★ 顺序是固定的：左栏(0) → 工具栏(1 段) → 顶栏(2 段)', () => {
    expect(L(".app-shell[data-solo='1'] .sidebar-shell"), '第一段：左栏立刻走')
      .toMatch(/transition-delay:\s*0ms/)
    expect(L(".app-shell[data-solo='1'] .icon-rail"), '第二段：等一段')
      .toMatch(/transition-delay:\s*var\(--solo-step\)/)
    expect(L(".app-shell[data-solo='1'] .topbar"), '第三段：等两段')
      .toMatch(/transition-delay:\s*calc\(2\s*\*\s*var\(--solo-step\)\)/)
    // 三段都是**位移**（负外边距）：只有它能动画，且被推出的那一栏留在 DOM 里
    expect(L(".app-shell[data-solo='1'] .sidebar-shell")).toMatch(/margin-left:\s*calc\(-1\s*\*\s*var\(--sidebar-width\)\)/)
    expect(L(".app-shell[data-solo='1'] .icon-rail")).toMatch(/margin-left:\s*calc\(-1\s*\*\s*var\(--rail-width\)\)/)
    expect(L(".app-shell[data-solo='1'] .topbar")).toMatch(/margin-top:\s*calc\(-1\s*\*\s*var\(--topbar-height\)\)/)
  })

  it('★ 退出倒着来：顶栏(0) → 工具栏(1) → 左栏(2)', () => {
    // ⚠️ 这三个选择器在"入场动画"那段也出现过 ⇒ 挑**含 `transition-delay` 的那一条**
    expect(bodyWith(layout, '.topbar', 'transition-delay'), '顶栏先回').toMatch(/transition-delay:\s*0ms/)
    expect(bodyWith(layout, '.icon-rail', 'transition-delay')).toMatch(/transition-delay:\s*var\(--solo-step\)/)
    expect(bodyWith(layout, '.sidebar-shell', 'transition-delay'))
      .toMatch(/transition-delay:\s*calc\(2\s*\*\s*var\(--solo-step\)\)/)
  })

  it('★ hover 唤出：贴边两条带 + 被唤出元素自身 hover 都保持，且**延时归零**', () => {
    expect(layout, '贴边窄带要有').toContain('.solo-hover-top {')
    expect(layout).toContain('.solo-hover-left {')
    for (const sel of [".app-shell[data-solo='1'] .solo-hover-top:hover ~ .topbar",
                       ".app-shell[data-solo='1'] .topbar:hover",
                       ".app-shell[data-solo='1'] .solo-hover-left:hover ~ .app-body .icon-rail",
                       ".app-shell[data-solo='1'] .icon-rail:hover"]) {
      expect(layout, `${sel} 要在`).toContain(sel)
    }
    // 唤出组里必须把 delay 归零（否则收起那几段延时会让唤出慢半拍）
    const summon = layout.slice(layout.indexOf(".app-shell[data-solo='1'] .solo-hover-top:hover"))
    expect(summon.slice(0, 600)).toMatch(/transition-delay:\s*0ms/)
  })
})

describe('单推：全收起后的延时淡出', () => {
  it('★ 只在 **cards 视图**（`data-view`）+ 延时（"一段时间之后"）', () => {
    const base = P(".app-shell[data-solo='1'] .posts-panel[data-view='cards']")
    expect(base, '淡出量').toMatch(/--solo-a-content:\s*var\(--solo-dim\)/)
    expect(base, '纱罩撤到 0 ⇒ 背景图完全显现').toMatch(/--solo-a-veil:\s*0/)
    expect(base, '延时').toMatch(/--solo-a-delay:\s*var\(--solo-fade-delay\)/)
    // 页面元素读这两个变量；⚠️ 背景层被排除（要的正是"背景图显现"）
    const dim = P(".app-shell[data-solo='1'] .posts-panel[data-view='cards'] > :not(.hero-backdrop)")
    expect(dim).toMatch(/opacity:\s*var\(--solo-a-content\)/)
    expect(dim).toMatch(/transition:[^;]*var\(--solo-a-delay\)/)
    // 纱罩那条也读变量
    const veil = posts.slice(posts.indexOf(".app-shell[data-solo='1'] .posts-panel[data-view='cards'] .hero-backdrop::after"))
    expect(veil.slice(0, 300)).toMatch(/opacity:\s*var\(--solo-a-veil\)/)
  })

  it('★ 唤出时**立刻恢复**（4 条选择器把两个变量拨回 1、延时归零）', () => {
    const i = posts.indexOf(".app-shell[data-solo='1'] .solo-hover-top:hover ~ .app-body .posts-panel")
    expect(i, '唤出恢复那条要在').toBeGreaterThan(0)
    const restore = posts.slice(i, posts.indexOf('}', i))
    expect(restore).toMatch(/--solo-a-content:\s*1/)
    expect(restore).toMatch(/--solo-a-veil:\s*1/)
    expect(restore).toMatch(/--solo-a-delay:\s*0ms/)
    // 四条都要在（顶栏带 / 左带 / 顶栏自身 / 工具栏自身）
    for (const frag of ['.solo-hover-left:hover ~ .app-body', '.topbar:hover ~ .app-body',
                        '.icon-rail:hover ~ .app-main']) {
      expect(posts.slice(i, i + 900), `${frag} 要在恢复组里`).toContain(frag)
    }
  })
})
