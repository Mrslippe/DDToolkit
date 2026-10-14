// @vitest-environment jsdom
/**
 * 词云 hover 提示的**坐标空间**（2026-10-14 用户报：「词云中鼠标 hover 出现的悬浮胶囊和
 * 鼠标位置对不上」，附截图 —— 胶囊整体偏到右下）。
 *
 * **根因不是坐标算错**：`.lc-dlg-cloud-tip` 是 `position: fixed`，而 `position: fixed` 的
 * **包含块会被祖先抢走** —— 凡是带 `transform` / `translate` / `filter` 的祖先都会成为它的
 * 包含块。Radix 的 `DialogContent` 上挂着 `translate-x-[-50%] translate-y-[-50%]`（居中）
 * 与 `zoom-in-95` 动画 ⇒ 这个 fixed 元素其实以**面板左上角**为原点，而 `left/top` 给的是
 * `clientX/clientY`（视口坐标）⇒ 整体偏一个面板原点。
 *
 * **本用例钉的是"它挂在 `document.body` 上"** —— 这是"left/top 一定按视口解释"的充要条件：
 * 只要它还留在弹窗子树里，将来任何一次祖先加 transform 都会让这个 bug 复活。
 * ⚠️ 别改成"断言 left/top 的数值"：那测不出**包含块是谁**，正是这次踩空的地方。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudWord } from '../../utils/wordCloudLayout'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom 缺的两样：ResizeObserver（宽度自适应）与 matchMedia（reduced-motion 分支）
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)
// matches:true ⇒ 摊铺走**同步终态**那条路（不起 rAF），用例才可判
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: true, media: q, onchange: null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
}))

import MosaicCloud from './MosaicCloud'

const WORDS: CloudWord[] = [
  { text: '奶绿', count: 420 }, { text: '抱抱', count: 310 }, { text: '哈哈哈', count: 288 },
  { text: '奶姐', count: 260 }, { text: '对不起', count: 210 }, { text: '直播间', count: 190 },
  { text: '引导', count: 170 }, { text: '妈妈', count: 150 }, { text: '喜欢', count: 130 },
  { text: '晚安', count: 110 },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.querySelectorAll('.lc-dlg-cloud-tip').forEach((el) => el.remove())
})

const mount = () => act(() => { root.render(<MosaicCloud data={WORDS} boxH={210} />) })
const cells = () => [...host.querySelectorAll('g.lc-dlg-cloud-cell')]
const tip = () => document.body.querySelector<HTMLElement>('.lc-dlg-cloud-tip')

/** hover 一格（React 的 onMouseEnter 是从冒泡的 mouseover 合成的，见文件头的用法说明） */
const hover = (el: Element, x: number, y: number) =>
  act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y })) })

describe('词云 hover 提示：坐标空间（2026-10-14 用户报的偏移）', () => {
  it('正对照：词云真的摊铺出了格子（否则下面那条是空过）', () => {
    mount()
    expect(cells().length, '一个格子都没摊出来 ⇒ 用例本身失效').toBeGreaterThan(0)
  })

  it('★ 提示挂在 `document.body` 上 —— 不被弹窗的 transform 抢走包含块', () => {
    mount()
    hover(cells()[0], 412, 318)
    const el = tip()
    expect(el, 'hover 之后没有出现提示').toBeTruthy()
    expect(
      el!.parentElement,
      '提示还在弹窗子树里 ⇒ 祖先一旦有 transform/translate，left/top 就会被当成"相对面板"',
    ).toBe(document.body)
  })

  it('★ 提示的 left/top 就是鼠标的**视口坐标**（不再叠加容器原点）', () => {
    mount()
    hover(cells()[0], 412, 318)
    const el = tip()!
    expect(el.style.left).toBe('412px')
    expect(el.style.top).toBe('318px')
    expect(el.textContent).toContain('次')

    // 跟着鼠标走（onMouseMove 更新同一个节点）
    act(() => {
      cells()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 500, clientY: 400 }))
    })
    expect(tip()!.style.left).toBe('500px')
    expect(tip()!.style.top).toBe('400px')
  })

  it('移开就收（mouseleave 合成自 mouseout）', () => {
    mount()
    hover(cells()[0], 412, 318)
    expect(tip()).toBeTruthy()
    act(() => {
      cells()[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(tip()).toBeNull()
  })
})
