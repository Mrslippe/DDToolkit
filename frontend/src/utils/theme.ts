/**
 * 主题（R14b，devlog/092）—— 纯逻辑，有单测。
 *
 * 用户需求 R14 里"例如主题"那一项。本批的边界（用户已批准）：
 * **只做「浅色 / 跟随系统」，深色主题本身留钩子、下一批做** ——
 * 三个 CSS 里硬编码色值 243 处（146 种）+ ECharts 主题 + 内联样式，
 * 不是换个变量就能收的，混在这一批里必然做出一个"半黑不黑"的界面。
 *
 * 那"钩子"具体是什么（不写清楚就等于没做）：
 * ① 偏好**真的存**（`prefs.theme`），`light | system` 枚举、后端校验；
 * ② 解析逻辑在这里：`resolveTheme(pref, systemDark)` —— 深色落地后**不用改调用点**，
 *    只需让它返回 `'dark'` 并在 CSS 里补 `:root[data-theme='dark']` 的令牌；
 * ③ 根元素属性 `data-theme` 现在就挂（`applyTheme`）—— 深色样式接上来即可生效；
 * ④ 跟随系统要**真的跟随**：`watchSystemTheme` 订阅 `prefers-color-scheme`，
 *    系统切换时立刻重解析（否则"跟随系统"只在启动那一刻成立，是个假跟随）。
 */

export type ThemePref = 'light' | 'system'
export type ResolvedTheme = 'light' | 'dark'

/** 深色主题是否已经能用。**下一批做完把它改成 true 即可**（其余逻辑不用动）。 */
export const DARK_IMPLEMENTED = false

/**
 * 偏好 + 系统状态 → 实际主题。
 *
 * ⚠️ `DARK_IMPLEMENTED=false` 时**一律返回 `light`**：这是有意的"如实"而不是偷懒 ——
 * 深色样式还没写，返回 `dark` 只会让 root 挂上 `data-theme="dark"` 却没有任何规则响应，
 * 用户看到的是"切了没反应"，那比明说"还没做"更糟。偏好照旧存下来，
 * 深色落地后这里改成 `return 'dark'` 就自动生效。
 */
export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (!DARK_IMPLEMENTED) return 'light'
  return pref === 'system' && systemDark ? 'dark' : 'light'
}

/** 系统是否偏好深色（`matchMedia` 不可用时按浅色 —— 探针/SSR 环境） */
export function systemPrefersDark(win: Window | undefined = globalThis.window): boolean {
  try {
    return !!win?.matchMedia?.('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** 把解析结果写到根元素（`html[data-theme]`）—— 深色样式将来只需认这个属性 */
export function applyTheme(root: HTMLElement | undefined, resolved: ResolvedTheme): void {
  if (!root) return
  root.setAttribute('data-theme', resolved)
}

/**
 * 给用户看的一句实话：选了「跟随系统」而系统确实是深色、但深色还没实现时，
 * **必须说出来** —— 否则用户会以为"跟随系统坏了"。
 * 返回 null 表示没有需要额外说明的（浅色偏好 / 系统本来就是浅色 / 深色已实现）。
 */
export function themeCaveat(pref: ThemePref, systemDark: boolean): string | null {
  if (DARK_IMPLEMENTED) return null
  if (pref !== 'system' || !systemDark) return null
  return '系统当前是深色，但深色主题尚未实现 —— 现在仍按浅色显示（偏好已记住）'
}

/** 订阅系统主题变化；返回注销函数 */
export function watchSystemTheme(
  onChange: (systemDark: boolean) => void,
  win: Window | undefined = globalThis.window,
): () => void {
  try {
    const mq = win?.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return () => {}
    const handler = (e: MediaQueryListEvent) => onChange(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  } catch {
    return () => {}
  }
}
