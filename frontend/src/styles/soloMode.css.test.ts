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

  it('★ 正常模式左栏收起/展开的时长与 `--solo-step` **解耦**（各吃各的旋钮，用户 2026-10-07）', () => {
    // 用户口径：「正常模式下左栏收起的速度和 --solo-step 解耦」。
    // 原因：基础那条 transition 曾经把 `.sidebar-shell, .icon-rail, .topbar` 写在一起、
    // 共用 `--solo-step` ⇒ 调单推的节奏会**顺手改掉正常模式的手动收起**（反之亦然）。
    const base = bodyWith(layout, '.sidebar-shell', 'transition:')
    expect(base, '左栏吃自己的旋钮').toMatch(/transition:[^;]*var\(--sidebar-toggle-ms\)/)
    expect(base, '★不许再共用单推那颗').not.toMatch(/var\(--solo-step\)/)
    // ⚠️ 正对照：单推第①段**确实**钉回 `--solo-step`（否则上面那句"不含"什么都证明不了 ——
    //    万一基础规则被整条删掉，左栏就是**完全不带动画**的硬切，而"不含 --solo-step"照样成立）
    expect(L(".app-shell[data-solo='1'] .sidebar-shell"), '单推第①段钉回单推节奏')
      .toMatch(/transition-duration:\s*var\(--solo-step\)/)
    // 旋钮必须有定义：`var()` 取不到值时整个声明无效 ⇒ 时长回退 0s ＝ 硬切（静默退化）
    const root = layout.slice(layout.indexOf(':root {'))
    expect(root.slice(0, root.indexOf('}')), '旋钮有定义（并跟慢放倍率走）')
      .toMatch(/--sidebar-toggle-ms:\s*calc\([^)]*var\(--motion-scale\)\)/)
  })

  it('★ 退出倒着来：顶栏(0) → 工具栏(1)；**左栏没有基础延时**（那会拖住正常模式的手动收起）', () => {
    // ⚠️ 这两个选择器在"入场动画"那段也出现过 ⇒ 挑**含 `transition-delay` 的那一条**
    expect(bodyWith(layout, '.topbar', 'transition-delay'), '顶栏先回').toMatch(/transition-delay:\s*0ms/)
    expect(bodyWith(layout, '.icon-rail', 'transition-delay')).toMatch(/transition-delay:\s*var\(--solo-step\)/)
    // ⚠️ 左栏**故意没有**基础延时（`devlog/441`）：正常模式手动收起左栏会先干等 520ms
    expect(layout, '左栏不该有基础 transition-delay').not.toMatch(/^\.sidebar-shell \{[^}]*transition-delay/m)
    // 正对照：单推里那条**进场**延时确实在（0ms ⇒ 左栏总是第一个动）
    expect(L(".app-shell[data-solo='1'] .sidebar-shell")).toMatch(/transition-delay:\s*0ms/)
  })

  it('★ 唤出：坐标判定（`data-peek`）—— 不许再有"贴边窄带"覆盖层，也不许退回 `:hover` 兄弟选择器', () => {
    // ⚠️ 第三版（devlog/433）：窄带覆盖层会挡内容点击、还得靠 pointer-events 来回让位，
    //    而"指针在哪个元素上"这套判定会被**唤出引起的布局位移**反复触发（用户报的闪动）。
    //    现在判定在 `utils/soloPeek.ts`（按 clientX/Y，有单测），CSS 只认属性。
    expect(layout, '窄带覆盖层必须撤掉').not.toContain('.solo-hover')
    expect(layout, '也别退回 :hover 兄弟选择器').not.toContain('.solo-hover-top:hover ~')
    expect(L(".app-shell[data-solo='1'][data-peek='top'] .topbar"), '唤出顶栏：位移归零')
      .toMatch(/margin-top:\s*0/)
    expect(L(".app-shell[data-solo='1'][data-peek='top'] .topbar"), '且延时归零（别慢半拍）')
      .toMatch(/transition-delay:\s*0ms/)
    expect(L(".app-shell[data-solo='1'][data-peek='left'] .icon-rail"))
      .toMatch(/margin-left:\s*0/)
  })
})

describe('单推：全收起后的延时淡出', () => {
  it('★ 让位 = 只在 cards 视图 + 闲置（data-idle）：界面元素**下滑 + 渐隐**、纱罩**渐隐**', () => {
    // ⚠️ 第四版（devlog/434）：让位依据从 "data-peek 恒有值" 改成**闲置计时器** ——
    //    上一版 data-peek 默认就有值 ⇒ 恢复规则一直生效 ⇒ **自动隐藏直接没了**。
    // ⚠️ 第五版（devlog/435）：让位/回来带上**位移**（下滑退场 / 上滑进场），过渡时长与
    //    滑动距离是两个 CSS 旋钮（--solo-hide-ms / --solo-hide-shift）。
    const idle = P(".app-shell[data-solo='1'][data-idle] .posts-panel[data-view='cards'] > :not(.hero-backdrop)")
    expect(idle, '★渐隐的**深浅**是旋钮（此前写死 0 ⇒ 改 --solo-dim 毫无效果，devlog/443）')
      .toMatch(/opacity:\s*var\(--solo-dim\)/)
    expect(idle, '★下滑退场（margin-top：hero 的入场动画是 transform，会抢掉它）').toMatch(/margin-top:\s*var\(--solo-hide-shift\)/)
    expect(idle, '过渡时长是旋钮').toMatch(/transition:[^;]*var\(--solo-hide-ms\)/)
    // ⚠️⚠️ 必须 `!important`：页面级容器挂着 `rise-in-page` 入场动画，
    // 而 `animation` 的优先级**高于**普通声明 ⇒ 不加就是"位移生效、渐隐不生效"（`devlog/438`）
    expect(idle, '要压过入场动画').toMatch(/opacity:\s*var\(--solo-dim\)\s*!important/)
    expect(idle).toMatch(/margin-top:[^;]*!important/)
    // 回来那条（默认态）：上滑 + 渐显，同样要压过动画
    const back = P(".app-shell[data-solo='1'] .posts-panel[data-view='cards'] > :not(.hero-backdrop)")
    expect(back).toMatch(/margin-top:\s*0\s*!important/)
    expect(back).toMatch(/opacity:\s*1\s*!important/)
    // 纱罩 = 一层**平的 12% 白**（用户口径："还是加上遮罩吧，透明度改为 12%"，`devlog/438`）
    // ⚠️ 行首锚定：`indexOf('.hero-backdrop::after {')` 会先命中 solo 那条（它也含这个子串）
    const base = posts.slice(posts.indexOf("\n.hero-backdrop::after {"))
    expect(base.slice(0, 220), '纱罩回来了，而且是 12%').toMatch(/rgba\(255,\s*255,\s*255,\s*0?\.12\)/)
  })
  it('★ 恢复只由 `data-idle` 决定：**不许**再把面板内容挂到 `data-peek` 上', () => {
    // 上一版（`devlog/434`）就是把它挂在 `data-peek` 上，而那个属性默认就有值 ⇒ 自动隐藏没了
    expect(posts, '`data-peek` 只管两栏，不该出现在面板内容的选择器里')
      .not.toContain("[data-peek] .posts-panel")
    // 正对照：让位那条**确实**在（否则上面那句"不含"什么都证明不了）
    expect(posts).toContain("[data-idle] .posts-panel[data-view='cards']")
  })

  it('★ 让位/回来带**位移**（下滑退场、上滑进场），时长与距离都是旋钮', () => {
    const root = layout.slice(layout.indexOf(':root {'))
    expect(root.slice(0, root.indexOf('}')), '滑动距离旋钮').toMatch(/--solo-hide-shift:\s*\d+px/)
    expect(root.slice(0, root.indexOf('}')), '过渡时长旋钮').toMatch(/--solo-hide-ms:\s*\d+ms/)
    // ★ 第三个旋钮：**淡出的深浅**（`devlog/443`）。它与上面两条不同 —— 上面两条一直有接线，
    // `--solo-dim` 只在 `:root` 里定义、**没有任何规则引用** ⇒ 改它等于没改（真正生效的是写死的 0）。
    // 所以这一组要**成对**断言：旋钮有定义 ＋ 让位那条真的用它（后者在上面那条用例里）。
    expect(root.slice(0, root.indexOf('}')), '不透明度旋钮（0 = 完全让出背景）')
      .toMatch(/--solo-dim:\s*[\d.]+/)
  })
  it('★ 唤出的工具栏/顶栏必须压过**左栏与面板里的浮层**（关系式：层级 > `.view-toolbar`）', () => {
    const rail = bodyWith(layout, '.icon-rail', 'z-index')
    expect(rail, '要能盖住同层的兄弟').toMatch(/position:\s*relative/)
    // ⚠️ 两条都是踩过的坑：
    // ① 左栏负外边距藏起来后盒子横跨到 [0,50]、DOM 又在后面 ⇒ 白底盖住工具栏；
    // ② 单推里面板从 0,0 起，而 `.view-toolbar` 是 `absolute; top:0; z-index:3`
    //    ⇒ 不给外壳层级就会**盖住工具栏/顶栏的按钮**（用户"左上角的按钮被顶掉了"）。
    // 所以判据写成**关系**（外壳 > 面板浮层），而不是写死某个数字。
    const zOf = (body: string) => Number(/^\s*z-index:\s*(\d+)/m.exec(body)![1])
    /** 同名选择器可能有好几条（`.topbar` 就有多条）⇒ 取**含 z-index 的那些里的最大值**。 */
    const maxZ = (selector: string) => {
      const re = new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{]`, 'gm')
      let best = 0
      for (const m of layout.matchAll(re)) {
        const brace = layout.indexOf('{', m.index)
        const body = layout.slice(brace, layout.indexOf('}', brace))
        const z = /^\s*z-index:\s*(\d+)/m.exec(body)   // ⚠️ 行首锚定：注释里也写着 z-index:3
        if (z) best = Math.max(best, Number(z[1]))
      }
      return best
    }
    const overlay = Number(/^\s*z-index:\s*(\d+)/m.exec(P('.view-toolbar'))![1])
    expect(overlay, '正对照：面板浮层的层级确实是 3').toBe(3)
    expect(maxZ('.icon-rail'), '工具栏要压过面板浮层').toBeGreaterThan(overlay)
    expect(maxZ('.topbar'), '顶栏同理').toBeGreaterThan(overlay)
    expect(zOf(rail), '（顺带：取到的那条本身也要有层级）').toBeGreaterThan(0)
  })

  it('★★ 真原因：`.view-body` 的 `scene-in` 是 `both` 填充 ⇒ 单推里必须改成 `backwards`', () => {
    // `both` 含 `forwards` ⇒ 动画结束后**永久钉住** opacity/transform（不是优先级问题）
    // ⇒ 位移靠 margin-top 躲过去了、opacity 躲不过（"永不渐隐"），"回来"那条同样被钉。
    const fix = P(".app-shell[data-solo='1'] .posts-panel[data-view='cards'] > :not(.hero-backdrop)")
    expect(fix, '填充方式改成 backwards（入场照播、播完不占属性）').toMatch(/animation-fill-mode:\s*backwards/)
    expect(fix, '⚠️ 别改成 animation: none（会把切视图的入场一起干掉）').not.toMatch(/animation:\s*none/)
    // 正对照：那条 both 的入场动画**确实**还在（否则上面这条没有意义）
    expect(posts).toContain('animation: scene-in')
    expect(posts).toMatch(/scene-in[^;]*both/)
  })

  it('★ 纱罩**只有一处真源**（`.custom` 那份单独的要删掉，否则改了一处没用）', () => {
    expect(posts, '⚠️ `.custom::after` 又是一份独立的纱罩 ⇒ 用户在自定义背景上看不到改动')
      .not.toContain('.hero-backdrop.custom::after')
  })

  it('★ 纱罩跟着界面元素一起渐隐/渐显，且**同一套时长与曲线**（形状：`--solo-hide-ms` + `--solo-ease`）', () => {
    // ⚠️ 这两条在 `devlog/438` 被误删过（当时以为纱罩整体撤掉了）⇒ 元素让位了、纱罩还压着背景图
    const veilIdle = P(".app-shell[data-solo='1'][data-idle] .posts-panel[data-view='cards'] .hero-backdrop::after")
    const veilBack = P(".app-shell[data-solo='1'] .posts-panel[data-view='cards'] .hero-backdrop::after")
    expect(veilIdle, '让位 ⇒ 纱罩渐隐到 0').toMatch(/opacity:\s*0/)
    expect(veilBack, '回来 ⇒ 纱罩渐显回 1').toMatch(/opacity:\s*1/)
    // ★"匹配"就是这两样：同一个旋钮 --solo-hide-ms、同一条曲线 --solo-ease
    for (const [name, body] of [['让位', veilIdle], ['回来', veilBack]] as const) {
      expect(body, `${name}那条要用同一套时长`).toMatch(/transition:[^;]*var\(--solo-hide-ms\)/)
      expect(body, `${name}那条要用同一条曲线`).toMatch(/var\(--solo-ease/)
    }
    // 正对照：界面元素那条也是同一套（否则"匹配"无从谈起）
    const content = P(".app-shell[data-solo='1'][data-idle] .posts-panel[data-view='cards'] > :not(.hero-backdrop)")
    expect(content).toMatch(/transition:[^;]*var\(--solo-hide-ms\)/)
    expect(content).toMatch(/var\(--solo-ease/)
  })

  it('★ 左栏**不许**带基础 transition-delay（那会拖住正常模式的手动收起）', () => {
    // 退出单推的次序只该管单推；写进基础规则 ⇒ 正常模式手动收起左栏先干等 520ms（`2 × --solo-step`）
    expect(layout, '⚠️ 基础规则里不该有 .sidebar-shell 的 transition-delay')
      .not.toMatch(/^\.sidebar-shell \{[^}]*transition-delay/m)
  })})
