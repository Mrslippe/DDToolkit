// @vitest-environment jsdom
/**
 * 播放器浮层的**触发口径**（2026-10-04，devlog/316）。
 *
 * 用户口径：「清晰度、倍速的按钮上拉栏并不是 hover 触发，而是点击触发，这会让控制逻辑不统一，
 * 全部改为 hover 触发」；外加「鼠标点击音量滑杆后移开，滑杆不会自动缩回去，
 * 需要点击空白处才回缩」。
 *
 * ⚠️ 两个测试环境的硬事实（这一批踩过）：
 * ① React 的 `onMouseEnter/onMouseLeave` 是用 `mouseover`/`mouseout` 合成出来的，
 *    所以要派发**这两个**事件并带上 `relatedTarget`（用 `document.body` 表示"移出到外面"）；
 * ② 收起有 `HOVER_GRACE_MS`（140ms）宽限，所以断言"已收起"要**真等一小会儿**。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VideoPlayer from './VideoPlayer'
import { resetPlayerPrefs } from '../utils/playerPrefs'

vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve(),
  // B2（devlog/381）：进/出全屏时会调它切窗口表面；jsdom 里没有壳，给个空实现
  setSurfaceOpaque: () => Promise.resolve() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const QUALITIES = [
  { id: 80, label: '高清 1080P' },
  { id: 64, label: '高清 720P' },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  resetPlayerPrefs()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** 指针进入/离开某个元素（React 的 enter/leave 是 mouseover/mouseout 合成的） */
const pointer = (el: Element, on: boolean) =>
  el.dispatchEvent(new MouseEvent(on ? 'mouseover' : 'mouseout',
                                   { bubbles: true, relatedTarget: document.body }))

/** 等过宽限期（`HOVER_GRACE_MS` 180ms） */
const afterGrace = () => act(async () => { await new Promise((r) => setTimeout(r, 260)) })
/** 等过呼出延时（`HOVER_OPEN_MS` 240ms）—— **扫过不弹**就是靠它 */
const afterOpenDelay = () => act(async () => { await new Promise((r) => setTimeout(r, 320)) })

const render = (props: Record<string, unknown> = {}) => {
  act(() => root.render(
    <VideoPlayer video={{ url: 'https://cdn/v.mp4' }} qualities={QUALITIES} qualityId={80}
                 {...props} />))
}

const menu = (name: 'rate' | 'quality') => host.querySelector<HTMLElement>(
  `[data-vp-menu="${name}"] .vp-menu`)

describe('VideoPlayer · 浮层由 hover 触发（与音量同一套）', () => {
  it('倍速：指针停上去一会儿才出菜单，移开一会儿就收起', async () => {
    render()
    const group = host.querySelector<HTMLElement>('[data-vp-menu="rate"]')!
    expect(menu('rate'), '一开始不该有').toBeNull()

    await act(async () => { pointer(group, true); await Promise.resolve() })
    expect(menu('rate'), '刚移上去就弹 = 鼠标扫过也会呼出（用户不要这个）').toBeNull()
    await afterOpenDelay()
    expect(menu('rate'), 'hover 要能拉出来（不是只有点击才行）').not.toBeNull()

    await act(async () => { pointer(group, false); await Promise.resolve() })
    await afterGrace()
    expect(menu('rate'), '移开该自动收起（不用点别处）').toBeNull()
  })

  it('**扫过不弹**：hover 不到延时就走，菜单一次都不出现', async () => {
    render()
    const group = host.querySelector<HTMLElement>('[data-vp-menu="rate"]')!
    await act(async () => {
      pointer(group, true)
      await new Promise((r) => setTimeout(r, 80))     // 远小于 240ms
      pointer(group, false)
      await Promise.resolve()
    })
    await afterOpenDelay()
    expect(menu('rate'), '鼠标顺路划过也弹出来 ⇒ 用户明确否掉的那种').toBeNull()
  })

  it('清晰度：同样是 hover；划过倍速**不会**把清晰度菜单带出来', async () => {
    render()
    const q = host.querySelector<HTMLElement>('[data-vp-menu="quality"]')!
    const r = host.querySelector<HTMLElement>('[data-vp-menu="rate"]')!

    await act(async () => { pointer(q, true); await Promise.resolve() })
    await afterOpenDelay()
    expect(menu('quality')).not.toBeNull()
    expect(menu('rate'), '两组各管各的 hover 区').toBeNull()

    await act(async () => { pointer(q, false); pointer(r, true); await Promise.resolve() })
    await afterGrace()
    expect(menu('quality'), '移开后要收').toBeNull()
    await afterOpenDelay()
    expect(menu('rate')).not.toBeNull()
  })

  it('指针从按钮移进菜单**不闪断**（宽限吃掉那条缝里的 leave）', async () => {
    render()
    const group = host.querySelector<HTMLElement>('[data-vp-menu="rate"]')!
    await act(async () => { pointer(group, true); await Promise.resolve() })
    await afterOpenDelay()
    expect(menu('rate')).not.toBeNull()
    // 穿过缝隙：先 leave（还在宽限内）再 enter —— 菜单不能消失
    await act(async () => {
      pointer(group, false)
      await new Promise((r) => setTimeout(r, 60))
      pointer(group, true)
      await Promise.resolve()
    })
    expect(menu('rate'), '够不着菜单 = 宽限没起作用').not.toBeNull()
  })

  it('键盘/触屏（没有 hover）点击仍能开合，且**钉住**到再点一次', async () => {
    render()
    const btn = host.querySelector<HTMLButtonElement>('[data-vp-menu="rate"] button')!
    expect(btn.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { btn.click(); await Promise.resolve() })       // 触屏/键盘：没有 hover
    expect(menu('rate')).not.toBeNull()
    expect(btn.getAttribute('aria-expanded'), '展开态要如实告诉读屏').toBe('true')

    await afterGrace()
    expect(menu('rate'), '钉住的菜单不该因为"没在 hover"就自己关掉').not.toBeNull()

    await act(async () => { btn.click(); await Promise.resolve() })
    expect(menu('rate')).toBeNull()
  })

  it('选中一项 ⇒ 菜单收起（鼠标停在原地也不重开）', async () => {
    const onPick = vi.fn()
    render({ onPickQuality: onPick })
    const group = host.querySelector<HTMLElement>('[data-vp-menu="quality"]')!
    await act(async () => { pointer(group, true); await Promise.resolve() })
    await afterOpenDelay()

    const items = host.querySelectorAll<HTMLButtonElement>('.vp-menu-item')
    await act(async () => { items[1].click(); await Promise.resolve() })
    expect(onPick).toHaveBeenCalledWith(64)
    expect(menu('quality'), '选完还挂着 = 用户以为没生效').toBeNull()
  })
})

describe('VideoPlayer · 上拉栏与按钮水平居中（CSS，devlog/332）', () => {
  /**
   * 用户口径（2026-10-04）：控件栏里**每一颗**按钮呼出的上拉栏都要与它**水平居中** ——
   * 旧口径是 `right: 0`（菜单右缘贴按钮右缘），菜单比按钮宽时整体看着偏右、
   * 不像"从这颗按钮长出来"。锚点是 `.vp-rate` / `.vp-volwrap`（盒宽 = 按钮宽），
   * 所以 `left: 50%` 正好是按钮中线。
   */
  const css = () => readFileSync(resolve(__dirname, '../styles/posts.css'), 'utf8')

  it('清晰度 / 倍速 / 分P 共用 `.vp-menu`：必须居中，且**不许**回到 `right: 0`', () => {
    const block = css().match(/\.vp-menu\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block, '找不到 .vp-menu 的规则').not.toBe('')
    expect(block, '要居中：锚点盒宽 = 按钮宽 ⇒ left:50% 就是中线').toContain('left: 50%')
    expect(block, '配 translateX(-50%) 才是"以中线为准"').toContain('translateX(-50%)')
    expect(block, '`right: 0` 是旧口径（右对齐 ⇒ 看着偏右）').not.toContain('right: 0')
  })

  it('音量浮窗同样居中（它是另一套规则 `.vp-volpop`）', () => {
    const block = css().match(/\.vp-volpop\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block, '找不到音量浮窗的规则').not.toBe('')
    expect(block).toContain('left: 50%')
    expect(block).toContain('translateX(-50%)')
    expect(block, '音量浮窗也要跟按钮对齐').not.toContain('right: 0')
  })
})

describe('VideoPlayer · 分P 菜单的宽度与滚动（CSS，devlog/331）', () => {
  /**
   * 起因（用户 2026-10-04 截图）：分P 菜单里**只有 P1…P7、没有标题**。
   * 根因不在数据（上游 `part` 都有），在 CSS：`.vp-menu` 是 grid，而我给 grid 项自己加了
   * `overflow: hidden` ⇒ 该项的 min-content 贡献变成 0 ⇒ 自动轨道塌成按钮那么宽（≈2 个字符）
   * ⇒ 标题被裁光。**规矩：宽度写在菜单上，裁切交给内层 `.vp-page-label`。**
   */
  const css = () => readFileSync(resolve(__dirname, '../styles/posts.css'), 'utf8')

  it('菜单宽度是**写死的 7 个字符**（不许塌成按钮宽，也不用 max-width）', () => {
    const block = css().match(/\.vp-menu--page\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block, '找不到分P 菜单的规则').not.toBe('')
    expect(block, '7 个字符宽是用户口径').toContain('--vp-page-w: 7em')
    expect(block, '宽度要真的用上这个变量').toMatch(/width:\s*var\(--vp-page-w\)/)
    expect(block, 'max-width 挡不住"塌成按钮宽"').not.toContain('max-width')
  })

  it('裁切落在**内层 span** 上（挂 grid 项自己身上会把宽度塌掉），且整行**左对齐**', () => {
    const item = css().match(/\.vp-menu--page \.vp-menu-item\s*\{[^}]*\}/)?.[0] ?? ''
    expect(item).toContain('overflow: hidden')
    expect(item, '用户口径：左对齐（滚动起点也从左边读起）').toContain('text-align: left')
    expect(item, '居中那版是上一稿，别再回来').not.toContain('text-align: center')
    const label = css().match(/\.vp-menu--page \.vp-page-label\s*\{[^}]*\}/)?.[0] ?? ''
    expect(label, '标签要能整体位移且不换行').toContain('inline-block')
    expect(label).toContain('nowrap')
  })

  it('过长 ⇒ hover 滚一次并**停在末尾**（不回滚）；短标题不被推着跑；reduced-motion 关掉', () => {
    const all = css()
    const hover = all.match(/\.vp-menu--page \.vp-menu-item:hover \.vp-page-label\s*\{[^}]*\}/)?.[0] ?? ''
    expect(hover, '要有"hover 才滚"的规则').toContain('animation: vp-page-scroll')
    expect(hover, '滚到末尾要停住（不是来回滚）').toContain('forwards')
    expect(hover, '用户口径：不回滚').not.toContain('alternate')
    expect(hover, '用户口径：只滚一次').not.toContain('infinite')
    const key = all.match(/@keyframes vp-page-scroll\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(key, '找不到滚动关键帧').not.toBe('')
    // `min(0em, …)`：文字比菜单窄时位移取 0（不滚）；百分比按 span 自身宽度算
    expect(key).toMatch(/translateX\(\s*min\(0em, calc\(var\(--vp-page-w\)/)
    expect(all, 'reduced-motion 下不许动').toMatch(
      /prefers-reduced-motion[\s\S]{0,240}vp-page-label\s*\{\s*animation: none/)
  })
})

describe('VideoPlayer · 音量浮窗的收起条件（CSS）', () => {
  it('显示规则里**不许**有裸 `:focus-within`（点一下滑杆就再也不收 = 用户报的那条）', () => {
    const css = readFileSync(resolve(__dirname, '../styles/posts.css'), 'utf8')
    const rule = css.match(/\.vp-volwrap:hover \.vp-volpop[^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(rule, '找不到音量浮窗的显示规则').not.toBe('')
    expect(rule, '要有 hover 那一路').toContain(':hover')
    expect(rule, '鼠标点过滑杆之后焦点还在 ⇒ 浮窗永远不收').not.toContain(':focus-within')
    expect(rule, '键盘 Tab 过来仍要常开').toContain(':has(:focus-visible)')
  })
})
