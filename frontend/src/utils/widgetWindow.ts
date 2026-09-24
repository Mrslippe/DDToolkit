/**
 * 桌面状态控件的**位置持久化**（R38 批 5b，规格 §7）。
 *
 * 规格说「位置持久化（`utils/shellState` 同款做法）」—— 也就是 **localStorage**。
 * 为什么不像 `usePrefs` 那样存后端：那套的理由是"打包版换端口/清缓存都会丢"，
 * 而那些是**功能偏好**（主题、关闭语义）；窗口坐标丢了最多是位置回到默认落点，
 * 不值得为它多一次网络往返。
 *
 * ## 为什么抽纯函数
 *
 * 与 `utils/sceneStep.ts` / `utils/statusIslandText.ts` 同款理由：本仓 vitest 跑 **node 环境**，
 * **拿不到真实屏幕**（也没有多显示器）—— 而"换显示器之后窗口跑到屏幕外"这类问题**只能靠算**。
 * 控件是**置顶 + 无边框 + 不进任务栏**的，整个跑出屏幕就**再也点不到它**了
 * （连"从任务栏找回来"这条路都没有），所以这条夹取不是锦上添花。
 */

export const WIDGET_POS_KEY = 'ddtoolkit.widget-pos'

/** §7：折叠尺寸 200 × 40（与 `layout.css` 的 `[data-density='widget']` 同值） */
export const WIDGET_SIZE = { w: 200, h: 40 } as const

/** 至少要有这么多像素留在屏幕内 —— 保证用户抓得到它 */
export const WIDGET_MIN_VISIBLE = 24

export interface WidgetPos {
  x: number
  y: number
}

export interface ScreenBox {
  width: number
  height: number
}

/** 解析存下来的坐标。坏数据（非 JSON / 缺字段 / 非有限数）一律当"没存过" */
export function parseWidgetPos(raw: string | null | undefined): WidgetPos | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<WidgetPos> | null
    if (typeof o !== 'object' || o === null) return null
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null
    return { x: Math.round(o.x as number), y: Math.round(o.y as number) }
  } catch {
    return null
  }
}

/**
 * 把坐标夹回屏幕内，**四个方向都至少留 `WIDGET_MIN_VISIBLE` 像素可见**。
 *
 * 上/左允许超出（贴边是正常用法），但不能超到只剩不到 24px；
 * 右/下则连整个窗口都要在屏幕内（`maxX = 屏宽 − 窗宽 − 边距`）——
 * 因为右下角超出时，露出来的那一角通常是**不可交互的空白**。
 */
export function clampWidgetPos(
  pos: WidgetPos,
  screen: ScreenBox,
  size: { w: number; h: number } = WIDGET_SIZE,
): WidgetPos {
  const m = WIDGET_MIN_VISIBLE
  const maxX = Math.max(m - size.w, screen.width - size.w - m)
  const maxY = Math.max(0, screen.height - size.h - m)
  return {
    x: Math.min(Math.max(pos.x, m - size.w), maxX),
    y: Math.min(Math.max(pos.y, 0), maxY),
  }
}

/** 首次开启的落点：右下角（避开任务栏，按 §7 的 200×40 算） */
export function defaultWidgetPos(screen: ScreenBox, size: { w: number; h: number } = WIDGET_SIZE): WidgetPos {
  return clampWidgetPos(
    { x: screen.width - size.w - WIDGET_MIN_VISIBLE, y: screen.height - size.h - 72 },
    screen,
    size,
  )
}

/** 开关取值（后端 `prefs.widget_enabled` 的白名单是 `off` / `on`） */
export type WidgetEnabled = 'off' | 'on'

/** 解析开关；认不出的一律当 `off`（与 `parseCloseAction` 同款：**默认安全**） */
export function parseWidgetEnabled(raw: string | null | undefined): WidgetEnabled {
  return raw === 'on' ? 'on' : 'off'
}

/** 存（只在真变了的时候写，避免拖动过程中每帧一次 `setItem`） */
export function saveWidgetPos(pos: WidgetPos, prevRaw: string | null): void {
  const prev = parseWidgetPos(prevRaw)
  if (prev && prev.x === pos.x && prev.y === pos.y) return
  try {
    globalThis.localStorage?.setItem(WIDGET_POS_KEY, JSON.stringify(pos))
  } catch {
    /* 隐私模式等场景写不了 —— 位置记不住而已，不该让拖动炸掉 */
  }
}

// ── 两扇窗之间的通道（R38 批 5b）──────────────────────────────────────

/** 主窗口 → 小窗：当前条目 */
export const WIDGET_NOTICES_EVENT = 'widget:notices'
/** 小窗 → 主窗口：面板里点了动作（"去登录"/"查看详情"这些只有主窗口做得了） */
export const WIDGET_ACTION_EVENT = 'widget:action'
/**
 * 小窗 → 主窗口：**小窗自己关掉了**（用户按 Alt+F4 / 系统关它）。
 * 主窗口据此把偏好改回 `off`（2026-09-24 真机反馈补）。
 */
export const WIDGET_CLOSED_EVENT = 'widget:closed'

/** 桌面端判定（与 `shellBridge` 同款：`__TAURI_INTERNALS__` 在 window 上） */
export const isDesktopShell = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * 重新拉一次主窗口的**可见性**，并**报告结果**。
 *
 * ## 背景（2026-09-24 真机反馈）
 *
 * 开了小窗之后：主窗口点 ✕ / 最小化都**没反应**，托盘退出也杀不掉进程，
 * 而且那个小窗**只有一块透明背景、没有胶囊**。
 *
 * ## 查证到的事实（**只有这些**）
 *
 * - `capabilities/default.json` 的作用域原本是 `"windows": ["main"]` ⇒ 小窗**一条窗口权限
 *   都没有**。（顺带核实：`core:window:default` 是**包含** `allow-hide` / `allow-show` /
 *   `allow-start-dragging` 的 —— 所以问题在**作用域**，不在权限集合里。这一点与最初的猜测不同，
 *   特意写下来免得下次又猜错。）
 * - 小窗前端里那句 `startDragging()` 包在一个**没被 await 的 async IIFE** 里 ⇒
 *   权限被拒时是**未处理的 Promise rejection**。
 * - 只补权限、不重拉主窗口是不够的（见下）。
 *
 * ## 为什么"先 hide 再 show"而不是直接 `show()`
 *
 * 权限缺失期间主窗口可能已经处于**错误状态**（它被藏起来过、或显示链路被搅过）。
 * 重拉一次是把状态**摆正**，而不是假设它是对的。失败时返回 `false` → 调用方提示用户
 * "点一下托盘图标" —— 比闷头做完、界面毫无反应要好。
 *
 * ## ⚠️ 这句是**未确证**的
 *
 * "小窗的未处理 rejection 会打坏**主窗口**的 IPC 通道"——两个 webview 各有各的 IPC，
 * 这条因果**没有查到证据**。但它解释了用户看到的全部三个症状（关不掉 / 最小化不了 /
 * 托盘退不掉），而且"async IIFE 必须 catch"本身就是对的，所以照修了。
 * **真正的确认要靠装一次直装版复现**（见 `docs/TODO.md` §1.3）。
 */
export async function resurfaceMainWindow(): Promise<boolean> {
  if (!isDesktopShell()) return false
  try {
    const { getAllWindows } = await import('@tauri-apps/api/window')
    const wins = await getAllWindows()
    for (const w of wins) {
      if (w.label !== 'main') continue
      try {
        await w.hide()
        await w.show()
        await w.setFocus()
      } catch {
        // 连 show 都失败：至少别把整个 flow 带崩
        return false
      }
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 主窗口把条目推给小窗。
 *
 * **小窗自己不轮询** —— 六个信息源（任务进度/风控/登录/完成报告/瞬时消息/磁盘）全在主窗口的
 * `TopBar` 里，小窗再来一份就是**双倍请求**。所以小窗是**纯显示**的：主窗口推什么它画什么。
 * 这也是没有按规格 §8 抽 `useStatusIsland()` 的原因 —— 抽了也只是把轮询搬个家，
 * 两扇窗仍然各轮各的；推事件才是真的只轮一次。
 *
 * 浏览器/探针环境没有 `@tauri-apps/api/event`（动态 import 会失败）—— 静默跳过。
 */
export async function broadcastNotices(notices: unknown[]): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit(WIDGET_NOTICES_EVENT, notices)
  } catch {
    /* 非桌面端：没有第二扇窗，没人听 */
  }
}

/** 小窗把"用户点了某个动作"转回主窗口 */
export async function relayWidgetAction(payload: { kind: string; id: string }): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit(WIDGET_ACTION_EVENT, payload)
  } catch {
    /* 同上 */
  }
}
