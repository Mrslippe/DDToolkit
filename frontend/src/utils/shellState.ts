/**
 * 「关闭窗口」与「深休眠后恢复现场」的纯逻辑（R18，devlog/095）—— 有单测。
 *
 * 两条与用户确认过的口径：
 * 1. **首次点 ✕ 问一次，之后按选择记住** —— 偏好存后端 `prefs.close_action`
 *    （`ask` / `tray` / `quit`），不是 localStorage：它是用户偏好，要和主题一样跨启动活着。
 * 2. **隐藏 10 分钟后释放界面内存**（Rust 侧销毁 WebView），唤回时**回到用户离开的位置**
 *    —— 所以要在这里把"离开哪儿"持久化下来，并且在恢复时**校验**它。
 *
 * ⚠️ 恢复路径必须校验（`sanitizeRoute`）：那个字符串会被丢给 `navigate()`，
 * 一个被改坏/过期的值轻则白屏、重则跳到不存在的路由。所以只认 `/` 与 `/vtubers/<数字>`，
 * 其余一律当作"没有保存过"。
 */

export type CloseAction = 'ask' | 'tray' | 'quit'

/** 视图模式（与 `PostsPage` 的 `AppView` 对应；这里**不复用**它的类型，
 *  免得 utils 反向依赖组件 —— 代价是这里要校验，而校验正是窗口恢复时该做的事） */
export type ShellView = 'cards' | 'list' | 'archive' | 'profile'
const VIEWS: ShellView[] = ['cards', 'list', 'archive', 'profile']

export interface ShellState {
  route: string
  view: ShellView | null
  /** 保存时刻（ms）——恢复只认最近的，避免"几天前的位置"突然冒出来 */
  at: number
}

export const SHELL_STATE_KEY = 'ddtoolkit.shell-state'
/** 超过这个时长的现场不再恢复（用户早就忘了自己停在哪儿了） */
export const SHELL_STATE_TTL_MS = 12 * 60 * 60 * 1000

/** 后端值 → 三态动作；不认识的值按 `ask`（宁可多问一次，也别擅自退出/隐藏） */
export function parseCloseAction(raw: string | null | undefined): CloseAction {
  return raw === 'tray' || raw === 'quit' ? raw : 'ask'
}

/** 点 ✕ 时到底做什么：记住过就直接做；否则弹一次询问 */
export function closeIntent(action: CloseAction): 'hide' | 'quit' | 'ask' {
  if (action === 'tray') return 'hide'
  if (action === 'quit') return 'quit'
  return 'ask'
}

/** 只认 `/` 与 `/vtubers/<id>`；其余返回 null（调用方按"没有现场"处理） */
export function sanitizeRoute(route: string | null | undefined): string | null {
  if (!route) return null
  if (route === '/') return '/'
  return /^\/vtubers\/\d+$/.test(route) ? route : null
}

export function sanitizeView(view: unknown): ShellView | null {
  return typeof view === 'string' && (VIEWS as string[]).includes(view)
    ? (view as ShellView)
    : null
}

/** 当前视图的发布点：`PostsPage` 每次切视图时告诉这里，保存现场时才有得存 */
let currentView: ShellView | null = null
export function noteCurrentView(view: ShellView): void {
  currentView = view
}
export function currentViewForState(): ShellView | null {
  return currentView
}

/** 保存现场（隐藏/深休眠前调用）。localStorage 不可用时静默失败 —— 少恢复一次位置不该报错 */
export function saveShellState(route: string, view: ShellView | null, now: number,
                               store: Storage | undefined = globalThis.localStorage): void {
  const safe = sanitizeRoute(route)
  if (!safe) return
  try {
    store?.setItem(SHELL_STATE_KEY, JSON.stringify({
      route: safe, view: sanitizeView(view) ?? currentView, at: now,
    }))
  } catch {
    /* 隐私模式/配额满：恢复功能降级，不影响隐藏本身 */
  }
}

/** 读现场：过期、格式坏、路径非法、视图非法 → null */
export function loadShellState(now: number, ttlMs = SHELL_STATE_TTL_MS,
                               store: Storage | undefined = globalThis.localStorage): ShellState | null {
  let raw: string | null = null
  try {
    raw = store?.getItem(SHELL_STATE_KEY) ?? null
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const route = sanitizeRoute(typeof o.route === 'string' ? o.route : null)
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
  if (!route || !at) return null
  if (now - at > ttlMs || at - now > 60_000) return null   // 过期，或时钟倒退得离谱
  return { route, view: sanitizeView(o.view), at }
}

export function clearShellState(store: Storage | undefined = globalThis.localStorage): void {
  try {
    store?.removeItem(SHELL_STATE_KEY)
  } catch {
    /* 同上 */
  }
}

/** 这一轮启动是不是"从托盘深休眠里被唤醒的"（Rust 重建窗口时会带 `?restored=1`） */
export function shouldRestoreFromTray(search: string): boolean {
  try {
    return new URLSearchParams(search).get('restored') === '1'
  } catch {
    return false
  }
}
