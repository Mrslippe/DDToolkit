/**
 * 日历弹窗的**页面稳定性**收口（2026-10-13）。
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
 * 也就是说：**文档没有可滚的内容，body 却被滚到了 486**。那是"焦点滚进视口"那一类动作 ——
 * Radix 的 `DialogContent` 会 `autoFocus` 第一个可聚焦元素（预约窗里就是那个日期输入框），
 * 浏览器为了把它带进视口去滚**最近的可滚动祖先**；而 Radix 的滚动锁把 `overflow: hidden`
 * 加在 html/body 上时，`body` 自己成了一个可滚的盒子（内容 1080+ vs 视口 621），
 * 于是那一下滚到了它身上：弹窗没动，**底下的页面跳了 486px**。
 *
 * ## 为什么不是"改 CSS 让 body 不可滚"
 *
 * `body` 的高度是别人的事（背景层/滚动层各有各的尺寸），今天堵住明天换个布局又会回来。
 * 这里做的是**结果收口**：弹窗开着的期间，body 的滚动位置必须钉在打开前那一刻 ——
 * 用户看不到任何跳动，而我们不需要猜是谁滚的。
 *
 * ⚠️ 只钉 `body.scrollTop`，**不碰**真正的滚动容器（`.os-scroll`）：
 * 日历卡在数据视图里是可滚的，把它一起钉死会让"弹窗开着也能滚 Card"变成做不到的事。
 * 判据：`ui_probe --archive` 的 `_reservation_dialog_failures`（卡片上缘与 scrollY 开合前后必须一致）。
 */

/** 打开前记录 body 的滚动位置；返回一个"钉回去"的函数（关弹窗时调用）。 */
export function pinBodyScroll(): () => void {
  const el = document.body
  const saved = el.scrollTop
  if (!saved) {
    // 本来没滚 ⇒ 只需要防它**被**滚：Radix 的 autoFocus 是异步落地的，
    // 所以钉两次（下一帧 + 一帧之后），而不是只钉一次。
    const pin = () => { if (el.scrollTop) el.scrollTop = 0 }
    const r1 = requestAnimationFrame(pin)
    const t = window.setTimeout(pin, 60)
    return () => {
      cancelAnimationFrame(r1)
      window.clearTimeout(t)
      pin()
    }
  }
  // 打开时就滚着（真机里 body 本可滚的情况）：回到打开前那一刻
  const pin = () => { if (el.scrollTop !== saved) el.scrollTop = saved }
  const r1 = requestAnimationFrame(pin)
  const t = window.setTimeout(pin, 60)
  return () => {
    cancelAnimationFrame(r1)
    window.clearTimeout(t)
    pin()
  }
}
