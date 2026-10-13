/**
 * 日历弹窗的**自动聚焦**收口（2026-10-13，`devlog/476`）。
 *
 * ## 这里曾经是"页面被挤上去"的修补处 —— 真正的病根在 CSS，已经修掉了
 *
 * 用户报过两件看似无关的事：
 *
 * 1. 「点击日期格之后有灰色遮罩但是没看见小窗」；
 * 2. 「新建预约弹窗把页面挤上去了」。
 *
 * 它们是**同一个根因**：`.lc-ms`（面板自己）写了 `position: relative`，而面板的
 * `position: fixed` 来自 `DialogContent` 的基础类（Tailwind 的 `.fixed`）——
 * posts.css 是**无层级**样式、Tailwind v4 的 utilities 在 `@layer utilities` 里，
 * 层叠里**层级先于特异性** ⇒ `relative` 压掉了 `fixed`。于是面板根本不是浮层，
 * 而是 Radix portal div 里普通流的一块；那个 div 排在满视口的 `#root` 之后
 * ⇒ 面板落在**首屏下方**（① 有遮罩没小窗）；随后 Chrome 为了把聚焦的日期输入框
 * 滚进视口，把 `body` 滚了 486px ⇒ 整页上跳（② 页面被挤上去）。
 *
 * 所以**修的是 `posts.css` 的 `.lc-ms`（那一处有完整读数）**，不是这里。
 * 我一度在这个模块里攒了三套"滚了之后想办法"的补丁（钉 `body.scrollTop`、
 * 给 body 上 `position: fixed`、`freezeBodyScroll`）——它们都在治症状：
 * 前两套还会把面板推到 `y=761`（视口只有 621），也就是**亲手造出**用户报的第①条。
 * 病根修掉后一次性删掉，并重跑探针确认判据仍绿（`ui_probe --archive`）。
 *
 * ## 现在只留一件事：接管自动聚焦
 *
 * Radix `DialogContent` 默认聚焦第一个可聚焦元素；浏览器为了把它带进视口会滚动
 * 「最近的可滚动祖先」。日历卡在数据视图里本来就有一个可滚的 `.os-scroll`，
 * 弹窗比视口高时（窄窗/小窗）默认行为就会把那层滚一下 —— 视觉上仍是"内容跳了一下"。
 * 这里用 `preventScroll: true` 自己聚焦：焦点该有的都有（Tab/打字正常），一次都不滚。
 */
import type { FocusEvent } from 'react'

/**
 * 交给 Radix `DialogContent` 的 `onOpenAutoFocus`：**接管自动聚焦**。
 *
 * 选择器默认聚焦第一个输入框（与 Radix 的行为一致：它也是聚焦第一个可聚焦元素），
 * 找不到就聚焦面板自身（`tabIndex=-1` 的容器，Radix 也支持这种"聚焦面板"的降级）。
 */
export function noScrollAutoFocus(
  e: Event | FocusEvent,
  selector = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
): void {
  e.preventDefault()
  const content = e.currentTarget as HTMLElement | null
  if (!content) return
  const target = content.querySelector<HTMLElement>(selector) ?? content
  try {
    target.focus({ preventScroll: true })
  } catch {
    // 老浏览器不认 options 参数：退回无参聚焦（会不会滚就听天由命，但至少焦点在）
    target.focus()
  }
}
