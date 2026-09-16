/**
 * 窗口圆角归谁画（R34，devlog/136）。
 *
 * 2026-09-17 实测（devlog/136）：把圆角交给 **Windows 自己**（DWM）之后 ——
 * 浮动 = 系统 8px 圆角（平滑、无抗锯齿混色），**吸附 = 四角自动变方、填满角落**
 * （连屏幕中间那两个角也是方的），最大化 = 方 —— 一行判定逻辑都不用写。
 * 代价：Win10 没有这个能力（`DwmSetWindowAttribute(33)` 失败）⇒ 必须保留 CSS 圆角兜底。
 *
 * 所以契约是**二选一**，由壳侧的能力探测结果决定：
 * - `true`  ⇒ `<html class="dwm-corners">`：CSS 半径归零（`--radius-window: 0px`），
 *   圆角、吸附方角、最大化方角全交给系统；
 * - `false` ⇒ 不加类：CSS 用 `--radius-window` 的兜底值自绘（Win10 / 浏览器 / 探针都走这条）。
 *
 * 为什么只切一个类而不是在 JS 里写像素值：半径是**设计令牌**，改它要能一处生效；
 * 这里只负责"这次该用谁"，具体度数始终在 `tokens.css`。
 */
export const DWM_CORNERS_CLASS = 'dwm-corners'

/** 按壳侧探测结果切换 `<html>` 上的类。纯 DOM 操作，幂等。 */
export function applyCornersMode(usesDwmCorners: boolean): void {
  document.documentElement.classList.toggle(DWM_CORNERS_CLASS, usesDwmCorners)
}

/** 当前是否由系统画圆角（探针/调试用）。 */
export function cornersModeIsDwm(): boolean {
  return document.documentElement.classList.contains(DWM_CORNERS_CLASS)
}
