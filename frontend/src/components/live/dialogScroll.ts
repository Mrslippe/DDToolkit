/**
 * 日历弹窗的**页面稳定性**收口（2026-10-13，`devlog/476`）。
 *
 * ## 它修的是什么
 *
 * 用户报：「新建预约弹窗把页面挤上去了」。探针量出来的现场（`ui_probe --archive`）：
 *
 * ```
 * window.scrollY     0 → 0        ← 窗口没滚
 * documentElement    scrollTop 0 → 0 · scrollHeight 621 / clientHeight 621（根本没超屏）
 * body.scrollTop     0 → 486      ← **滚的是 body**
 * 卡片上缘           100 → -386
 * ```
 *
 * 机制：Radix 的 `DialogContent` 会 **`autoFocus` 第一个可聚焦元素**（预约窗里就是那个
 * 日期输入框），浏览器为了把它带进视口会去滚「最近的可滚动祖先」；而 Radix 的滚动锁
 * 给 html/body 加 `overflow: hidden` 之后，`body` 自己成了一个**可滚的盒子**
 * （内容 1080+ vs 视口 621）—— 那一下正好滚到了它身上。
 *
 * ## ⚠️ 两次修错（都留在这里，因为都真踩过）
 *
 * | 第一版 | 现象 | 为什么错 |
 * |---|---|---|
 * | 打开期间把 `body.scrollTop` 钉回 0 | 弹窗跑到视口外（盒 `420×341 @(328,761)`，视口 621）⇒ 用户看到「只有灰色遮罩、没有小窗」 | `fixed` 遮罩的 flex 居中是算在**滚动盒**上的：内容 1080 时 "50%" 落在 540，弹窗被摆到 y≈761。把它钉回顶部 = 让那次滚动**算进布局**却没让用户看见 |
 * | 打开期间给 body 上 `position: fixed` | 弹窗可见了，但 `body.scrollTop` **仍然**被滚了 486 ⇒ 卡片照样跳 | 没堵住源头：`scrollIntoView` 照样把滚动量写进了 body |
 *
 * **两次都在"滚了之后想办法",而不是"别让它滚"。** 真正的源头是那个 `autoFocus` ——
 * 所以本模块现在只做一件事：**把 Radix 的自动聚焦接管过来，自己用
 * `focus({ preventScroll: true })` 聚焦**（见 `noScrollAutoFocus`）。
 * 焦点该有的都有（键盘用户按 Tab/打字正常），浏览器**一次都不滚**。
 *
 * ⚠️ 不碰真正的滚动容器（`.os-scroll`）：日历卡在数据视图里本来就可滚，
 * 把它一起钉死会让"弹窗开着也能滚卡"变成做不到的事。
 * 判据：`ui_probe --archive` 的 `_reservation_dialog_failures` ——
 * ① 卡片上缘/scrollY 开合前后一致；② 弹窗盒**必须在视口内**（两条各守一种错法）。
 */

/**
 * 交给 Radix `DialogContent` 的 `onOpenAutoFocus`：**接管自动聚焦**。
 *
 * 默认行为会让浏览器把焦点元素滚进视口（= 用户看到的"页面被挤上去"）；
 * 这里改成自己聚焦、且显式 `preventScroll: true`。
 *
 * 选择器默认聚焦第一个输入框（与 Radix 的行为一致：它也是聚焦第一个可聚焦元素），
 * 找不到就聚焦面板自身（`tabIndex=-1` 的容器，Radix 也支持这种"聚焦面板"的降级）。
 */
export function noScrollAutoFocus(
  e: Event,
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

/**
 * 打开弹窗时调用：**临时让 body 不可滚**（不改它的定位，因此不影响 `fixed` 遮罩的居中），
 * 并在**下一帧与稍后各一次**把可能已经发生的滚动量压回打开前那一刻。
 *
 * 返回还原函数（关弹窗时调用）。
 *
 * ⚠️ 为什么不给 body 上 `position: fixed`：那样 `fixed` 遮罩的 flex 居中会算在
 * **滚动盒**上（内容 1080 时 50% = 540）⇒ 弹窗被摆到视口外，`devlog/476` 第一版就这么错的。
 * 也不只"钉回 0"（第二版）：那只是把滚动**藏起来**，布局仍旧按滚动后的坐标算。
 *
 * 判据：`ui_probe --archive`（卡片上缘与 scrollY 开合前后一致 + 弹窗盒必须在视口内）。
 */
export function freezeBodyScroll(): () => void {
  const el = document.body
  const root = document.documentElement
  const saved = {
    bodyOverflow: el.style.overflow,
    rootOverflow: root.style.overflow,
    y: el.scrollTop,
  }
  const clamp = () => { if (el.scrollTop !== saved.y) el.scrollTop = saved.y }
  el.style.overflow = 'hidden'
  root.style.overflow = 'hidden'
  clamp()
  const r1 = requestAnimationFrame(clamp)
  const t1 = window.setTimeout(clamp, 50)
  const t2 = window.setTimeout(clamp, 200)
  return () => {
    cancelAnimationFrame(r1)
    window.clearTimeout(t1)
    window.clearTimeout(t2)
    el.style.overflow = saved.bodyOverflow
    root.style.overflow = saved.rootOverflow
    el.scrollTop = saved.y
  }
}
