/**
 * 全屏模式的**诊断开关**（2026-10-07，`devlog/399`）。
 *
 * ## 为什么要有它
 *
 * B2 到第十六轮已经能稳定复现：**进全屏 → 2~3 秒后开始每秒丢 4 帧；退出全屏 / 一次 seek → 立刻恢复**
 * （`devlog/398`，4/4 次，含一个无混淆对照：小窗连播 30 秒 `0/896 = 0.0%` ⇒ 进全屏 ⇒ 2 秒后翻坏）。
 * 但"进全屏"这个动作一次翻了**三件事**，不拆开就没法归因：
 *
 * | 变量 | 窗口态 | 全屏态 |
 * |---|---|---|
 * | ① 全屏 API / 全屏窗口 | 无 | `requestFullscreen()` |
 * | ② 显示尺寸 | `678x381`（`.vp-video{max-height:60vh}`） | `1920x1080`（1:1） |
 * | ③ WebView 底色 | `transparent` | `不透明`（`set_surface_opaque`） |
 *
 * 两个模式各只动一个变量：
 *
 * - **`size`**：走真全屏（①③ 与全屏态相同），只把画面钉回 `678x381` ⇒ **只动 ②**。
 *   流畅 ⇒ 元凶是"铺到 1:1"；照旧卡 ⇒ ② 出局。**已跑：卡 ⇒ ② 出局**（`devlog/400`）。
 * - **`surface`**：走真全屏、画面照常铺满，**但保留透明的窗口底色**（不调 `set_surface_opaque`）
 *   ⇒ **只动 ③**。流畅 ⇒ 元凶是"窗口底色"；照旧卡 ⇒ ③ 出局、只剩 ①。
 * - **`pseudo`**：**不走全屏 API**（① 变），但布局、尺寸、底色照全屏做 ⇒ 只动 ①。
 *   ⚠️ **这一格至今没成功跑起来**（`devlog/400`）：`position: fixed` 被祖先里的
 *   transform/contain 困住，画面**一次都没被放大过**（实测 `尺寸=1920x1080→718x392`），
 *   于是它量到的只是"窗口态"。修它要先查清 `.vp` 的祖先链 —— 等 ① 真的成了嫌疑再做。
 *
 * ## 怎么开
 *
 * `$env:VITE_VP_FS_MODE='size'; npm run tauri:dev`（或 `surface`）—— 与
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 同一套路：**不用改代码、不用重编**（`PROBE.md` §6.22）。
 * 也认 `localStorage.ddtoolkit.vpFsMode`（开着 devtools 时更方便）。
 *
 * ⚠️ 只为诊断而存在：**默认 `off`，生产行为一字不变**。这一格查完就把本模块与配套的两条 CSS 删掉。
 * ⚠️ `pseudo` 下 **Esc 退不出来**（没有真全屏可退）—— 再按一次 `f`。这条要写进用法说明，
 *    否则用户会以为"按 Esc 没反应 = 播放器坏了"。
 */
export type VpFsMode = 'off' | 'size' | 'pseudo' | 'surface'

/** `localStorage` 里的键名（开着 devtools 时手写这一条也能开）。 */
export const VP_FS_MODE_KEY = 'ddtoolkit.vpFsMode'

const VALID: readonly string[] = ['size', 'pseudo', 'surface']

function fromLocalStorage(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(VP_FS_MODE_KEY)
  } catch {
    return null        // 隐私模式/被策略挡住时 localStorage 会抛，别让它把播放器带崩
  }
}

function fromEnv(): unknown {
  try {
    return (import.meta as unknown as { env?: Record<string, unknown> }).env?.VITE_VP_FS_MODE
  } catch {
    return undefined
  }
}

/**
 * 读全屏模式：**环境变量优先，其次 `localStorage`，垃圾值一律当 `off`**。
 *
 * ⚠️ 垃圾值必须当 `off`（而不是抛出去、也不是原样透传）：这个开关一旦被一个手滑的值卡住，
 * 表现是"播放器行为莫名其妙变了"，而排查的人**根本不会想到去看环境变量**。
 */
export function readVpFsMode(
  env: unknown = fromEnv(),
  ls: string | null = fromLocalStorage(),
): VpFsMode {
  for (const raw of [env, ls]) {
    if (typeof raw === 'string' && VALID.includes(raw)) return raw as VpFsMode
  }
  return 'off'
}
