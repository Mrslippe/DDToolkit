/**
 * 界面切换的协调器（2026-10-18 用户）。
 *
 * 用户要的顺序是：**界面不动 → 闭幕 → 加载中（这时候才换界面）→ 揭幕 → 完成**。
 *
 * 关键点：**导航必须推迟到幕布合上之后**。如果点了就 `navigate`，新界面会在幕布还没合上
 * 时就已经渲染出来 —— 那就成了"先换界面再遮"，不是"遮住了再换"。
 *
 * 所以工具栏不再直接 `navigate`，而是调 `requestViewChange(() => navigate(path))`：
 * 壳层（`App`）注册一个 driver，driver 负责播完闭幕与图标后**再调用那个回调**。
 * 没有 driver 时（单测环境、或壳层没挂）直接执行，保证不会卡住导航。
 */

type Next = () => void
/** 目标界面的键（`posts` / `workbench` …）—— driver 据此判断"是不是真的在换界面" */
type ViewKey = string
type Driver = (next: Next, key: ViewKey | undefined) => void

let driver: Driver | null = null

/** 由壳层注册。传 `null` 注销。 */
export function setViewTransitionDriver(fn: Driver | null): void {
  driver = fn
}

/**
 * 请求一次「带揭幕的界面切换」。`next` 里做真正的导航。
 *
 * `key` = 目标界面的标识（`posts` / `workbench` …）。**壳层用它判重**：
 * 目标与当前一致时不会播幕布（调用点也各自判了一次，这里是兜底）。
 */
export function requestViewChange(next: Next, key?: ViewKey): void {
  if (driver) driver(next, key)
  else next()
}
