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

// ── 小窗的**形态梯度**（R38 批 5d，2026-09-24）─────────────────────────
//
// ## 为什么必须有这个（一个真 bug 逼出来的）
//
// 规格 §3 早就写了「展开尺寸：**280 × 面板高**」，但 Rust 侧窗口尺寸**写死 200×40、
// 没有 resize 通路** —— 于是小窗里那个面板 `top = 胶囊底(40) + 6 = 46`，
// **落在 40px 高的窗口外面**，宽度 280 也超出 200。实测（`ui_probe --status-island
// --width 200 --height 90`）：`可命中=False / 在视口内=False`。
//
// 也就是说：**小窗从上线起就只有那颗胶囊是真的**，悬停/点击弹出的面板用户从没看见过。
// 这个 bug 能活下来，是因为探针一直在**主窗口的视口**（1100×800）里量那套样式 ——
// 在宽视口里面板当然"在视口内、可命中"，于是**绿**。判据的坐标系错了，
// 它量的是"这套样式在一个大视口里对不对"，而不是"在小窗里能不能用"。
//
// ## 锚点：**顶边中心**
//
// 展开时窗口要从 200×40 长到 280×(40+H)。若以左上角为锚，窗口会**向右下"长出去"** ——
// 用户看到胶囊往左上跳一下。所以 resize 时要**同时挪位置**，保持**顶边中心**不动
// （这正是 LuckyIsland `window_policy.rs` 的做法，README「参考与致谢」）。

/** 折叠态尺寸（与 `layout.css` 的 `[data-density='widget']` 同值） */
export const WIDGET_COLLAPSED = { w: 200, h: 40 } as const

/** 展开态面板宽（规格 §3「展开尺寸 280 × 面板高」） */
export const WIDGET_PANEL_W = 280

/**
 * 展开态的窗口高度 = 胶囊高 + 间隙 + 面板高。
 *
 * 间隙 **6px** 与 `StatusIsland.place()` 里的 `r.bottom + 6` **必须一致** ——
 * 两处算的是同一件事（面板相对于胶囊的落点），不一致就会出现
 * "面板下缘被窗口裁掉 6px"这种只有真机上才看得见的缝。
 */
export const WIDGET_PANEL_GAP = 6

export interface WidgetExpandGeom {
  /** 窗口应该长到的尺寸 */
  w: number
  h: number
  /** 窗口应该挪到的位置 */
  x: number
  y: number
  /**
   * 面板开在胶囊的**下方**（`false`）还是**上方**（`true`）。
   *
   * ⚠️ **这个字段是必需的，不是优化**：小窗的默认落点是**右下角**
   * （`defaultWidgetPos`：`y = 屏高 − 40 − 72`，1080p 上是 **968**）——
   * 向下展开需要 `968 + 40 + 6 + 面板高`，**任何面板高度都放不下**（≥1214 > 1080）。
   * 硬要向下长就只能夹取，而夹取会**把胶囊从用户摆的位置挪走**。
   *
   * 所以真机上只有一条路：**贴着屏幕下沿时向上翻**（面板长在胶囊上方）。
   * 这也是所有浮层控件（菜单 / 下拉 / 气泡）的标准解法 —— 不是我们发明的。
   */
  flipUp: boolean
  /**
   * **胶囊在窗口内的纵向偏移**（px，从窗口顶边算）。
   *
   * ## 为什么必须由几何算出来，不能让 CSS 猜（2026-09-25 批 5g 加）
   *
   * 原来 CSS 用的是"翻上去 ⇒ 胶囊贴窗口**底**边"（`flex-end`）。那在**没被夹**时是对的
   * （窗口底边 = 胶囊底边）。但贴屏幕上沿时窗口会被**夹**（顶边不能为负）：
   *
   * ```
   * 胶囊 y=10、高 40 ⇒ 向上翻要 y = 50 − 183 = −133 ⇒ 夹到 0
   * 此时胶囊在窗口内的真实偏移 = 10 − 0 = 10（**不是** 143 = 窗口高 − 胶囊高）
   * ```
   *
   * 于是 CSS 把胶囊画到窗口底部，而面板按"胶囊在 10px 处"算 ⇒ **两者错位**
   * （用户截图：胶囊被压在顶端、和面板叠在一起）。
   *
   * **根因是"谁来决定胶囊在窗口里的位置"有两个主人**：几何算了窗口矩形，
   * CSS 又自己认定胶囊贴哪条边。现在**统一由几何给**（`capsuleOffset`），
   * CSS 只负责把它用起来 —— 单一事实源。
   */
  capsuleOffset: number
}

/** 面板与胶囊之间的间隙（与 `StatusIsland.place()` 的 `r.bottom + 6` 同值） */
const GAP = WIDGET_PANEL_GAP

/**
 * 由**当前**窗口矩形 + 面板高度，算出展开后的窗口矩形（纯函数，可单测）。
 *
 * ## 优先向下，放不下就**向上翻**
 *
 * 向下（面板在胶囊下方）是默认方向；只有当下方**真的装不下**时才向上翻。
 * 判据用"向下展开后底边是否超出屏幕（留 `WIDGET_MIN_VISIBLE` 边）"，
 * 而不是"当前 y 是否在下半屏" —— 后者在**面板很矮**时会做出无谓的翻转
 * （屏幕中间的胶囊：明明下面装得下，却因为在下半屏而翻上去）。
 *
 * ## 翻转之后位置怎么算
 *
 * 向上翻意味着窗口要**向上长**：顶边 = 胶囊顶 − 间隙 − 面板高。
 * 但**胶囊自己在窗口里的位置也得跟着换**（它在窗口顶部 ⇒ 翻上去之后胶囊该在窗口**底部**），
 * 所以 `flipUp` 必须交给调用方（`StatusWidgetWindow`）去改 `.widget-shell` 的对齐。
 * 光改窗口坐标而不管胶囊在窗口内的位置，会得到"面板在上面、胶囊也还在上面"的错位。
 */
export function widgetExpandGeom(
  cur: { x: number; y: number; w: number; h: number },
  panelH: number,
  screen: ScreenBox,
): WidgetExpandGeom {
  const h = Math.max(0, panelH)
  const capH = WIDGET_COLLAPSED.h
  const w = Math.max(cur.w, WIDGET_PANEL_W)
  const anchorX = cur.x + cur.w / 2
  const totalH = capH + GAP + h

  // 向下：窗口顶边不动，整体长到 `cur.y + totalH`
  const downBottom = cur.y + totalH
  const downFits = downBottom <= screen.height - WIDGET_MIN_VISIBLE

  if (downFits) {
    const raw = { x: Math.round(anchorX - w / 2), y: cur.y }
    const c = clampWidgetPos(raw, screen, { w, h: totalH })
    // 向下：胶囊贴窗口**顶边**（`cur.y` 没动过 ⇒ 偏移就是被夹掉的那一点）
    return { w, h: totalH, x: c.x, y: c.y, flipUp: false, capsuleOffset: cur.y - c.y }
  }

  // 向上翻：窗口**底边**对齐胶囊底边，顶边 = 底边 − totalH
  const capBottom = cur.y + capH
  const raw = { x: Math.round(anchorX - w / 2), y: capBottom - totalH }
  const c = clampWidgetPos(raw, screen, { w, h: totalH })
  // ⚠️ 胶囊偏移 = 胶囊原顶边 − 窗口最终顶边。
  //    **没被夹**时它等于 `totalH - capH`（= 窗口底边，与旧的 `flex-end` 一致）；
  //    **被夹**时它更小 —— 那正是旧写法错的地方（固定成 `totalH - capH` 会让胶囊跳）。
  return { w, h: totalH, x: c.x, y: c.y, flipUp: true, capsuleOffset: cur.y - c.y }
}

/**
 * 收起：回到折叠尺寸。
 *
 * `flipUp` 决定胶囊在窗口里的哪一端 —— 收起时窗口只剩胶囊高，两种情况的
 * **预期矩形其实是同一个**（窗口 = 胶囊大小），但**位置**取决于展开时锚的是顶边还是底边：
 *   · 向下展开 ⇒ 顶边没动过 ⇒ 收起也用原顶边；
 *   · 向上展开 ⇒ **底边**没动过 ⇒ 收起要保持底边（否则胶囊会从"贴着屏幕下沿"往上跳）。
 *
 * ## 为什么要 `restore`（2026-09-24 加，被单测逼出来的）
 *
 * 光靠"从展开矩形反推"**在屏幕右/左边缘会漂**：展开时窗口从 200 变 280，
 * 贴右缘的小窗**必须**被夹回来（否则面板出屏），于是"展开矩形的中心"已经不是
 * 原来那个中心了 —— 再反推回去就少了那几十像素（实测 1696 → 1656）。
 * 一次展开/收起看不出什么，但**每次悬停都漂一点**，久了小窗就爬走了。
 *
 * 所以调用方（`StatusWidgetWindow`）在展开**之前**把胶囊矩形传进来，
 * 收起时**直接回到那个矩形** —— 展开/收起成为一个精确的闭环。
 * 拿不到 `restore` 时才退回反推（退化路径，仍有夹取兜底）。
 */
export function widgetCollapseGeom(
  cur: { x: number; y: number; w: number; h: number },
  screen: ScreenBox,
  flipUp = false,
  restore?: { x: number; y: number } | null,
): WidgetExpandGeom {
  const { w, h } = WIDGET_COLLAPSED
  if (restore) {
    const c = clampWidgetPos({ x: Math.round(restore.x), y: Math.round(restore.y) }, screen, { w, h })
    // 折叠态：窗口 == 胶囊，胶囊偏移恒为 0
    return { w, h, x: c.x, y: c.y, flipUp: false, capsuleOffset: 0 }
  }
  const anchorX = cur.x + cur.w / 2
  // 向上展开时保持**底边**不动；否则保持顶边
  const y = flipUp ? cur.y + cur.h - h : cur.y
  const raw = { x: Math.round(anchorX - w / 2), y }
  const c = clampWidgetPos(raw, screen, { w, h })
  return { w, h, x: c.x, y: c.y, flipUp: false, capsuleOffset: 0 }
}



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

/**
 * 面板的高度上限（px）—— **必须按屏幕算，不能按窗口算**。
 *
 * ## 这一条是"自指循环"的第三次现身（2026-09-25 批 5f）
 *
 * 面板高度 → 决定小窗窗口高度（窗口 = 40 + 6 + 面板高）→ 而窗口高度又**不能**反过来
 * 决定面板高度。这个循环换过三件外衣，每一件都看着很合理：
 *
 * | 写法 | 循环怎么闭合的 | 实测后果 |
 * |---|---|---|
 * | `60vh` | `vh` = 窗口高的 1% | 折叠态窗口 40px ⇒ `60vh=24px` ⇒ 面板压成一条 |
 * | `innerHeight - 120` | `innerHeight` **就是小窗自己的高** | 收敛在 120px 下限，**永远长不开** |
 * | **`availHeight - 120`（本函数）** | 屏幕高**与窗口无关** ⇒ 不闭合 | ✅ |
 *
 * ⚠️ **判据（可复用）**：给小窗里任何"按高度算"的值选参照系时，先问一句
 * **"这个值会不会因为我算出来的结果而变？"** —— 会，就不能用。
 *
 * ## 参数
 *
 * - `availHeight`：`screen.availHeight`（**已扣掉任务栏**，比 `screen.height` 更准）
 * - `margin`：留给胶囊(40) + 间隙(6) + 屏幕上下边距的余量
 * - `floor`：下限，防止"屏幕特别小"时算出 0 或负数（那会让面板整块消失）
 */
export function widgetPanelMaxHeight(
  availHeight: number,
  margin = 120,
  floor = 160,
): number {
  // 取不到屏幕高（`availHeight` 为 0 / NaN / 负数）时**退回下限**而不是算出个荒谬值：
  // 宁可面板矮一点（还能滚动），也不要它整块不见。
  if (!Number.isFinite(availHeight) || availHeight <= 0) return floor
  return Math.max(floor, Math.round(availHeight - margin))
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
 * 确保主窗口**可见**（不做多余动作），并报告结果。
 *
 * ## 历史：这里曾经是 `hide() + show()`
 *
 * 2026-09-24 第一轮真机反馈（"主窗口关不掉"）时我加的是 `hide→show→setFocus`。
 * 但那个诊断**是错的** —— 真凶在第六轮才查明：`show_widget_window` 是**同步命令**，
 * 在**主线程**上创建第二个 WebView2 会卡死消息泵（见 devlog/180）。
 *
 * 于是这个补丁只剩副作用：**每切一次开关，主窗口就藏一下再显一下 —— 整窗闪动**
 * （用户 2026-09-24 反馈）。真凶修掉之后，这里只需要"确保可见"。
 *
 * ## 现在的语义
 *
 * - 已经可见 ⇒ **什么都不做**（这是绝大多数情况，也是"不闪"的关键）
 * - 不可见 ⇒ `show()` + `setFocus()`
 *
 * 失败返回 `false`：调用方据此提示用户"点一下托盘图标"。
 */
export async function resurfaceMainWindow(): Promise<boolean> {
  if (!isDesktopShell()) return true
  try {
    const { getAllWindows } = await import('@tauri-apps/api/window')
    const wins = await getAllWindows()
    for (const w of wins) {
      if (w.label !== 'main') continue
      // ⚠️ **可见时立刻返回，绝不 hide**：`hide()` 才是闪动的来源。
      if (await w.isVisible()) return true
      try {
        await w.show()
        await w.setFocus()
      } catch {
        return false
      }
      return true
    }
    return false
  } catch {
    return true   // 拿不到窗口列表：不动它是最安全的
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
