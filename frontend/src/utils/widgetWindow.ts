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

/**
 * 折叠态的**最小**尺寸 200 × 40（D1 起：宽是**内容下限**，不是定值 —— 见
 * `WIDGET_CAP_MAX_W`。CSS 里对应的三个数是 `--widget-cap-min-w` / `-max-w` / `--widget-radius`，
 * 由 `applyWidgetCssVars()` 从这里的常量写下去 ⇒ **只有这一份真源**）。
 */
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

/**
 * 首次开启的落点：**顶部居中**，离屏幕上沿 `WIDGET_DEFAULT_TOP_GAP`（80px，用户 2026-09-27）。
 *
 * 为什么不是"某个角"：角落是**四方向里最坏**的落点 —— 它必然贴两条边，
 * 于是第一条判据（向下）永远不成立、必须向上翻，用户看到的第一眼就是特例。
 * 顶部居中只在"上沿"这一条轴上靠边，横向完全自由 ⇒ 默认就是"向下展开"。
 */
export function defaultWidgetPos(screen: ScreenBox, size: { w: number; h: number } = WIDGET_SIZE): WidgetPos {
  return clampWidgetPos(
    { x: Math.round((screen.width - size.w) / 2), y: WIDGET_DEFAULT_TOP_GAP },
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

/** 折叠态尺寸（= `WIDGET_SIZE`；D1 起它是**下限**，真实宽由内容决定） */
export const WIDGET_COLLAPSED = WIDGET_SIZE

/** 胶囊高度（折叠态窗口高）—— §10「中间态高度恒定」，**不跟内容走** */
export const WIDGET_CAP_H = 40

/**
 * 胶囊**宽度的下限**（= `WIDGET_SIZE.w`，内容再短也不许比它窄）。
 *
 * 与上限成对存在，是为了让"夹进区间"这件事只有一个出口（`clampCapsuleW`）——
 * 调用点各写一遍 `Math.max(200, Math.min(400, w))` 就会有人写漏一边。
 */
export const WIDGET_CAP_MIN_W = WIDGET_SIZE.w

/**
 * 胶囊**宽度的上限**（D1 定稿，2026-09-27：用户的 400 口径）。
 *
 * ## 为什么是"跟内容走 + 上下限"而不是定值
 *
 * 09-25 那版方案给的是"折叠 200 定值 + 展开 280"（`d1-form-options.md` 的 A+280）。
 * 09-27 的样例页（`docs/design/widget-preview/direction.html`）把它改成**方案 A**：
 * **短文案的胶囊就窄、长文案就宽**，只有超过 400 才上省略号（上限**之内不省**）。
 * 用户 2026-09-27 拍板按 09-27 那一版 ⇒ 这里的三个数（200 / 400 / 40）就是规格。
 *
 * ⚠️ **宽度不许由 JS 逐帧去改**：胶囊用 CSS `width: max-content` 自己量自己
 * （`max-content` 与容器宽**无关** ⇒ 不构成自指循环，见 `widgetPanelMaxHeight` 那条注释
 * 记的三次循环）。JS 只负责**读**它的 `offsetWidth` 去调窗口大小。
 */
export const WIDGET_CAP_MAX_W = 400

/**
 * 圆角——**恒定 20px**（09-27 定稿）。
 *
 * 折叠 40 高时 20 = 完美胶囊；展开（窗口长成 400×面板高）**也是 20** ⇒ 半径**单调**，
 * 不会出现"先胀后收"那种"两个形状拼起来"的观感（规格 §5 的同心圆角同一族理由）。
 */
export const WIDGET_RADIUS = 20

/**
 * 展开态面板宽 = 展开态窗口宽（D1 定稿：400；09-25 的 280 已作废）。
 *
 * ⚠️ 取 `≥ WIDGET_CAP_MAX_W` 是**有意的**：窗口宽 ≥ 胶囊上限 ⇒ 展开后胶囊**必然**
 * 装得进窗口，横向偏移只需要管"贴哪一边"，不会出现"胶囊比窗口还宽被裁掉"。
 */
export const WIDGET_PANEL_W = 400

/**
 * 展开窗口与屏幕边之间的留白（**四个方向共用这一个口径**）。
 *
 * ⚠️ 与 `WIDGET_MIN_VISIBLE`(24) 的分工要分清：
 *   · `WIDGET_MIN_VISIBLE` 管**折叠态**（拖到屏幕外时至少留 24px 让人抓得到）；
 *   · `WIDGET_EDGE` 管**展开态**（面板要能整块读，所以四边都留 8px）。
 * 混用一个数会得到"面板下缘被裁掉 16px"或"胶囊贴边时展开方向判错"。
 */
export const WIDGET_EDGE = 8

/**
 * 首次开启的落点：**顶部居中**，离屏幕上沿 80px（用户 2026-09-27：「大概留出两个小窗
 * 高度的间距」= 2 × 40）。
 *
 * 取代原来的**右下角**（`y = 屏高 − 40 − 72`，1080p 上是 968）。为什么落点要改：
 * 右下角那个位置**任何面板高度都放不下**（向下展开需要 `968 + 40 + 6 + 面板高 ≥ 1214`），
 * 于是小窗一起手就**只能向上翻** —— 一个"默认就在边缘"的落点会把四方向逻辑的第一印象
 * 变成"永远向上"。顶部居中则四个方向都有余量：默认向下，也真的会向下。
 */
export const WIDGET_DEFAULT_TOP_GAP = 80

/**
 * 贴边判定的容差（px）——夹取是精确等号，亚像素会让"贴住了"判不出来。
 * 与样例页的 `STUCK = 1.5` 同值。
 */
export const WIDGET_STUCK = 1.5

/**
 * 折叠态重算窗口宽时的**死区**（px）：内容宽变化小于它就不发 resize。
 *
 * 为什么需要：活数据槽（倒计时 `47s`→`46s`）每秒都可能让 `max-content` 变一两个像素，
 * 而 Windows 的窗口 resize 是**可见**的（`StatusWidgetWindow` 里那条"去重"注释记过）。
 * 2px 是人眼在 40px 高的胶囊上分不出的量级，而它能挡掉绝大多数每秒一次的抖动。
 */
export const WIDGET_RESIZE_DEADBAND = 2

/**
 * 展开态的窗口高度 = 胶囊高 + 间隙 + 面板高。
 *
 * 间隙 **6px** 与 `StatusIsland.place()` 里的 `r.bottom + 6` **必须一致** ——
 * 两处算的是同一件事（面板相对于胶囊的落点），不一致就会出现
 * "面板下缘被窗口裁掉 6px"这种只有真机上才看得见的缝。
 */
export const WIDGET_PANEL_GAP = 6

/** 面板与胶囊之间的间隙（与 `StatusIsland.place()` 的 `r.bottom + 6` 同值） */
const GAP = WIDGET_PANEL_GAP

/**
 * 展开方向：面板开在胶囊的**下方**（`down`）还是**上方**（`up`）。
 *
 * ⚠️ **这个字段是必需的，不是优化**：小窗的落点如果贴着屏幕下沿
 * （旧默认落点就是右下角：1080p 上 `y = 968`），向下展开需要
 * `968 + 40 + 6 + 面板高` —— **任何面板高度都放不下**（≥1214 > 1080）。
 * 硬要向下长就只能夹取，而夹取会**把胶囊从用户摆的位置挪走**。
 */
export type WidgetDir = 'down' | 'up'

/**
 * 横向：面板往哪一边长。
 *
 * - `right`：胶囊贴窗口**左**缘 ⇒ 多出来的宽度在胶囊右边（面板向右长）
 * - `left`：胶囊贴窗口**右**缘 ⇒ 面板向左长
 * - `center`：胶囊在窗口里居中（默认；居中放得下就用它）
 *
 * ⚠️ 判定口径是**"装不装得下"**，不是"在屏幕的哪一半"（09-27 样例页记过这个错）：
 * 按中线劈半会把**正中央**判成"向上 + 向左"（`0.5 < 0.5` 为 false），
 * 用户截图正是"胶囊在屏幕正中、面板却往左上长"。
 */
export type WidgetAlign = 'left' | 'center' | 'right'

/** 一次 resize 要下发的**全部**几何事实（单一真源：窗口矩形 + 方向 + 胶囊在窗口内的偏移） */
export interface WidgetGeom {
  /** 窗口应该长到的尺寸 */
  w: number
  h: number
  /** 窗口应该挪到的位置 */
  x: number
  y: number
  dir: WidgetDir
  align: WidgetAlign
  /**
   * **胶囊在窗口内的横向偏移**（px，从窗口左边算）。
   *
   * ⚠️ 为什么必须由几何算出来，不能让 CSS 猜（与纵向的 `capOffsetY` 同一条教训）：
   * "胶囊在窗口里靠哪一边"曾有两个主人 —— 几何算窗口矩形，CSS 又自己认定"居中"。
   * 四方向展开之后这个矛盾会变成**可见的错位**（面板向左长、胶囊却还在窗口中间）。
   */
  capOffsetX: number
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
   * CSS 又自己认定胶囊贴哪条边。现在**统一由几何给**（`capOffsetX` / `capOffsetY`），
   * CSS 只负责把它用起来 —— 单一事实源。
   */
  capOffsetY: number
}

/** 把胶囊宽夹进规格区间（`200–400`）——所有入口共用，别在调用点各写一遍 */
export function clampCapsuleW(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return WIDGET_CAP_MIN_W
  return Math.min(WIDGET_CAP_MAX_W, Math.max(WIDGET_CAP_MIN_W, Math.round(raw)))
}

/**
 * 展开态/折叠态共用的**屏幕夹取**（四边都留 `WIDGET_EDGE`）。
 *
 * `max(WIDGET_EDGE, …)` 兜的是"窗口比屏幕还大"那种退化情形（此时贴左上）。
 */
function clampToScreen(
  x: number, y: number, w: number, h: number, screen: ScreenBox,
): WidgetPos {
  const maxX = Math.max(WIDGET_EDGE, screen.width - w - WIDGET_EDGE)
  const maxY = Math.max(WIDGET_EDGE, screen.height - h - WIDGET_EDGE)
  return {
    x: Math.round(Math.min(Math.max(x, WIDGET_EDGE), maxX)),
    y: Math.round(Math.min(Math.max(y, WIDGET_EDGE), maxY)),
  }
}

/**
 * 由**当前**窗口矩形 + 面板高度，算出展开后的窗口矩形（纯函数，可单测）。
 *
 * ## 四条判据（09-27 定稿，与样例页 `decideDir` 同款）
 *
 * 1. **垂直：默认向下；装不下才向上** —— 判据是"下方**装不装得下**"，不是"在哪一半"。
 *    贴屏幕下沿（`stuckBottom`）必须向上：它下方根本没有位置。
 *    两边都不够时挑余量大的那边，再由夹取保证不出屏。
 * 2. **水平：默认居中；居中出屏才贴边** —— 夹取天然就是"只在边缘才反向展开"。
 *    ⚠️ 三个候选（居中 / 贴左 / 贴右）里**居中是区间中点** ⇒ 若两侧贴边都放得下，
 *    居中必然也放得下 ⇒ 这个顺序**不必来回比较**（可证，不是拍脑袋）。
 * 3. **近边恒等**（F1）：窗口**贴住胶囊的那条边**在展开前后是同一个值
 *    （向下 ⇒ 窗口顶 = 胶囊顶；向上 ⇒ 窗口底 = 胶囊底）。
 *    样例页记过：把窗口放在胶囊**外侧**会让卡片整体离开屏边一个胶囊高
 *    （CDP 实测 `jumpY = +46 = CAP_H + GAP`，用户报的"和边缘拉开"就是它）。
 * 4. **锚点 = 胶囊所在的角**：方向定了之后，胶囊在窗口里贴哪一边也就定了
 *    —— 所以 `capOffsetX/Y` 是**算出来的**，不是让 CSS 再判一次。
 */
export function widgetExpandGeom(
  cur: { x: number; y: number; w: number; h: number },
  panelH: number,
  screen: ScreenBox,
): WidgetGeom {
  const capH = WIDGET_CAP_H
  const capW = clampCapsuleW(cur.w)          // 折叠态：窗口 == 胶囊 ⇒ `cur.w` 就是胶囊宽
  const h = Math.max(0, panelH)
  const totalH = capH + GAP + h
  const w = Math.max(capW, WIDGET_PANEL_W)
  const capLeft = cur.x
  // 中心用**夹过之后**的 capW 算（不是 `cur.w`）：调用方可能量到"窗口还差一帧没跟上"的
  // 旧宽，两处用不同的数会让"居中"偏半个宽度差。
  const capCenter = cur.x + capW / 2

  // ── 垂直方向 ────────────────────────────────────────────────────────
  // 余量口径：向下是"从胶囊**顶边**到屏幕下边"（窗口顶边不动），
  //          向上是"从胶囊**底边**到屏幕上边"（窗口底边不动）。
  const roomBelow = screen.height - WIDGET_EDGE - cur.y
  const roomAbove = cur.y + capH - WIDGET_EDGE
  const stuckBottom = cur.y + capH >= screen.height - WIDGET_EDGE - WIDGET_STUCK
  let dir: WidgetDir
  if (stuckBottom && roomAbove >= totalH) dir = 'up'
  else if (roomBelow >= totalH) dir = 'down'
  else if (roomAbove >= totalH) dir = 'up'
  else dir = roomBelow >= roomAbove ? 'down' : 'up'

  // ── 水平：先居中，居中放不下才贴边 ──────────────────────────────────
  const centered = Math.round(capCenter - w / 2)
  const fitsCentered =
    centered >= WIDGET_EDGE && centered + w <= screen.width - WIDGET_EDGE
  const growRight = Math.round(capLeft)                 // 胶囊贴窗口左缘 ⇒ 面板向右长
  const growLeft = Math.round(capLeft + capW - w)        // 胶囊贴窗口右缘 ⇒ 面板向左长
  const fitsRight =
    growRight >= WIDGET_EDGE && growRight + w <= screen.width - WIDGET_EDGE
  const fitsLeft =
    growLeft >= WIDGET_EDGE && growLeft + w <= screen.width - WIDGET_EDGE
  const rawX = fitsCentered ? centered : fitsRight ? growRight : fitsLeft ? growLeft : centered

  // 纵向：近边恒等（向下 ⇒ 顶边不动；向上 ⇒ 底边不动），再整体夹进屏幕
  const rawY = dir === 'down' ? cur.y : cur.y + capH - totalH
  const c = clampToScreen(rawX, rawY, w, totalH, screen)

  // 胶囊在窗口内的偏移：**默认就是它原来在屏幕上的位置**（胶囊不动），
  // 只有当窗口被夹回来、装不下时才会被挤（退化情形：屏幕比面板还窄）。
  const capOffsetX = Math.round(
    Math.min(Math.max(capLeft - c.x, 0), Math.max(0, w - capW)))
  const capOffsetY = Math.round(
    Math.min(Math.max(cur.y - c.y, 0), Math.max(0, totalH - capH)))
  const align: WidgetAlign = capOffsetX <= 0 ? 'right'
    : capOffsetX >= w - capW ? 'left' : 'center'

  return { w, h: totalH, x: c.x, y: c.y, dir, align, capOffsetX, capOffsetY }
}

/**
 * 折叠态：把窗口收成**胶囊本身**的大小（宽由调用方量出来的 `capW` 决定）。
 *
 * ## 为什么必须"回到原处"而不是反推
 *
 * 光靠"从展开矩形反推"**在屏幕边缘会漂**：展开时窗口从 200 变 400，
 * 贴右缘的小窗**必须**被夹回来（否则面板出屏），于是"展开矩形的中心"已经不是
 * 原来那个中心了 —— 再反推回去就少了那几十像素（实测 1696 → 1656）。
 * 一次展开/收起看不出什么，但**每次悬停都漂一点**，久了小窗就爬走了。
 *
 * 所以调用方（`StatusWidgetWindow`）在展开**之前**把胶囊矩形传进来，
 * 收起时**直接回到那个矩形** —— 展开/收起成为一个精确的闭环。
 * 拿不到 `restore` 时才退回反推（退化路径，仍有夹取兜底）。
 *
 * ⚠️ 回到的是**胶囊的中心**（横向）与**顶边**（纵向），不是"窗口左上角"：
 * 内容变了之后胶囊宽也变了（方案 A），按左上角回位会让胶囊**中心**漂掉半个宽度差。
 */
export function widgetCollapseGeom(
  cur: { x: number; y: number; w: number; h: number },
  screen: ScreenBox,
  capW: number,
  restore?: { x: number; y: number; w: number } | null,
): WidgetGeom {
  const w = clampCapsuleW(capW)
  const h = WIDGET_CAP_H
  const anchorX = restore ? restore.x + restore.w / 2 : cur.x + cur.w / 2
  const topY = restore ? restore.y : cur.y
  const raw = { x: Math.round(anchorX - w / 2), y: Math.round(topY) }
  // ⚠️ **两条路径的夹取口径不同，这不是笔误**：
  //   · 有 `restore` ⇒ 回到的是**它自己刚才占过的那个矩形**，本来就地合法，
  //     唯一要防的是"换显示器/改分辨率"。此时必须用**与展开同一套**的 `WIDGET_EDGE`：
  //     展开用 EDGE(8)、收起用 `clampWidgetPos` 的 24 ⇒ **贴下沿的胶囊会被推上去 16px**
  //     —— 一次看不出什么，但那正是"展开/收起不闭环"的老毛病（restore 这条机制存在的理由）。
  //   · 没有 `restore` ⇒ 退化路径，位置是**反推**出来的、不保证合法 ⇒ 用放置口径
  //     `clampWidgetPos`（右下留 24px，见它的注释）。
  const c = restore
    ? clampToScreen(raw.x, raw.y, w, h, screen)
    : clampWidgetPos(raw, screen, { w, h })
  // 折叠态：窗口 == 胶囊 ⇒ 两个偏移都是 0（方向无关紧要，给个确定的默认值）
  return { w, h, x: c.x, y: c.y, dir: 'down', align: 'center', capOffsetX: 0, capOffsetY: 0 }
}

/**
 * 折叠态下**只改宽度**（内容变了）：保持胶囊的**中心**与顶边不动，把窗口跟上去。
 *
 * 为什么不是"保持左缘"：默认落点是**顶部居中**，内容变长时用户的预期是"往两边长"，
 * 而不是"往右长、中心跑掉"。保持中心 = 顶部居中这个落点在内容变化下**自洽**。
 */
export function widgetCapsuleGeom(
  cur: { x: number; y: number; w: number },
  screen: ScreenBox,
  capW: number,
): WidgetPos & { w: number; h: number } {
  const w = clampCapsuleW(capW)
  const h = WIDGET_CAP_H
  const centerX = cur.x + cur.w / 2
  const c = clampWidgetPos(
    { x: Math.round(centerX - w / 2), y: Math.round(cur.y) }, screen, { w, h })
  return { w, h, x: c.x, y: c.y }
}

/**
 * 把 TS 侧的形态常量写进 CSS 变量（**单一真源**：CSS 里不许再抄一遍数字）。
 *
 * ⚠️ 为什么要有这一步：这些数同时被**三处**用到 —— JS 几何（算窗口矩形）、
 * CSS（画胶囊）、探针（量出来判）。本仓为此栽过（`d1-form-options.md` §6 的"三源"）：
 * 只改其中一两处，**单测和探针都会绿**，而真机上窗口正在裁胶囊。
 * 现在数字只在 `widgetWindow.ts` 里写一遍，CSS 用 `var(…)` 读，探针量**变量**是否等于常量。
 *
 * 幂等：每帧调都行（`setProperty` 同值不触发样式重算）。
 */
export function applyWidgetCssVars(): void {
  const root = globalThis.document?.documentElement
  if (!root) return
  const s = root.style
  s.setProperty('--widget-cap-min-w', `${WIDGET_SIZE.w}px`)
  s.setProperty('--widget-cap-max-w', `${WIDGET_CAP_MAX_W}px`)
  s.setProperty('--widget-radius', `${WIDGET_RADIUS}px`)
  s.setProperty('--widget-panel-w', `${WIDGET_PANEL_W}px`)
  s.setProperty('--widget-cap-h', `${WIDGET_CAP_H}px`)
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

/**
 * ⚠️ **「主窗口 → 小窗：当前条目」那条广播已退役**（M5-2b，devlog/259）。
 *
 * 小窗改拉 `GET /vtuber/notices`（两扇窗同一个 hook），所以不再需要"主窗口替小窗取数"
 * 这条通道 —— 而它的代价恰恰是"主窗口不在（没开 / 关掉了）时小窗永远是空的"。
 */
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

/** 小窗把"用户点了某个动作"转回主窗口 */
export async function relayWidgetAction(payload: { kind: string; id: string }): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit(WIDGET_ACTION_EVENT, payload)
  } catch {
    /* 同上 */
  }
}
