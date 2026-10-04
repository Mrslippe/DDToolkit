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

vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

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
