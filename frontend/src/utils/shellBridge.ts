import { invoke } from '@tauri-apps/api/core'
import { setShellHidden } from '../utils/shellLifecycle'
import { saveShellState, currentViewForState } from './shellState'

/**
 * 桌面外壳桥（R18，devlog/095）：把"隐藏到托盘 / 退出 / 深休眠后恢复"这三件事
 * 收成一个模块，**并且给浏览器/探针环境留可用的退化路径**。
 *
 * 为什么退化路径重要：这套逻辑的主体在 Rust（托盘、拦 CloseRequested、销毁 WebView），
 * 而 `ui_probe` 跑在**无头浏览器**里 —— 没有 Tauri、没有托盘。所以：
 * - 隐藏：浏览器里退化为"把前端切到挂起态"（`setShellHidden(true)`），
 *   于是"隐藏之后该不该继续轮询"这件事**照样能断言**；
 * - 恢复：探针用 dev 钩子直接调 `setShellHidden(false)`；
 * - 退出：浏览器里没有"退出应用"这回事，返回 false 让调用方知道没做成。
 */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 隐藏到托盘（先把"我在哪儿"存下来，供深休眠唤醒后恢复现场） */
export async function hideToTray(route: string): Promise<boolean> {
  // 存现场要**在隐藏之前**：Rust 侧可能过一会儿就把 WebView 销毁掉
  saveShellState(route, currentViewForState(), Date.now())
  setShellHidden(true)
  if (!isTauri) return false
  try {
    await invoke('hide_to_tray')
    return true
  } catch {
    setShellHidden(false)     // 隐藏失败就别装成隐藏了（否则界面永远不刷新）
    return false
  }
}

/** 真退出（Rust 侧会置 quitting 标志再退出，避免又被 CloseRequested 拦下） */
export async function quitApp(): Promise<boolean> {
  if (!isTauri) return false
  try {
    await invoke('quit_app')
    return true
  } catch {
    return false
  }
}

/** 供界面显示"当前是桌面端还是浏览器"（探针/开发时提示用） */
export function isDesktopShell(): boolean {
  return isTauri
}

// ── 桌面状态控件（R38 批 5b，devlog/173）────────────────────────────────

/**
 * 显示（必要时创建）桌面状态控件小窗。
 *
 * `pos` 为 `null` 时由 Rust 落到默认位置（右下角）—— 那是"第一次开启"的路径。
 * 之后的位置由前端存 localStorage（`utils/widgetWindow`），这里只是把它递过去。
 *
 * 浏览器/探针环境返回 `false`：那边没有第二扇窗，界面据此**不显示**这个开关
 * （与 `storageInfo()` 返回 `null` 是同一套取舍）。
 */
export async function showWidgetWindow(
  pos: { x: number; y: number } | null,
): Promise<boolean> {
  if (!isTauri) return false
  try {
    await invoke('show_widget_window', { x: pos?.x ?? null, y: pos?.y ?? null })
    return true
  } catch {
    return false
  }
}

/** 关掉桌面状态控件小窗（**销毁**，不是隐藏 —— 关掉开关就不该再留一个 webview） */
export async function hideWidgetWindow(): Promise<boolean> {
  if (!isTauri) return false
  try {
    await invoke('hide_widget_window')
    return true
  } catch {
    return false
  }
}

// ── 数据目录（R22-B2d，devlog/108）────────────────────────────────────

export interface ShellDataDirInfo {
  dir: string
  /** `env`（用户用环境变量指定 = 便携/自定义）· `migrated`（应用内迁过）· `default` · `unknown` */
  source: string
  /** 便携/自定义安装 ⇒ 界面**不给迁移入口**（整个文件夹一起搬才是便携的本意） */
  portable: boolean
  /** 有迁移记录但用不了（已回退默认目录）：界面要提醒，不能静默 */
  pointerUnusable: string | null
}

export interface MigrateReport {
  dataDir: string
  oldDir: string
  files: number
  bytes: number
  skipped: string[]
}

/**
 * 这次启动实际用的数据目录 + 来源。
 * 浏览器/探针环境返回 `null` —— 于是界面**不显示迁移入口**（那边根本没有这回事）。
 */
export async function storageInfo(): Promise<ShellDataDirInfo | null> {
  if (!isTauri) return null
  try {
    const raw = await invoke<{
      dir: string; source: string; portable: boolean; pointer_unusable: string | null
    }>('storage_info')
    return {
      dir: raw.dir,
      source: raw.source,
      portable: raw.portable,
      pointerUnusable: raw.pointer_unusable ?? null,
    }
  } catch {
    return null
  }
}

/**
 * 迁移数据目录（系统文件夹选择框 → 规划 → 停后端 → 复制 → 校验 → 写指针 → 新目录启动并探活；
 * 任何一步失败都会回滚并用**原目录**重启，旧目录全程不动）。
 *
 * 抛错时 message 就是给用户看的中文原因（Rust 侧保证这一点）。
 */
export async function migrateDataDir(): Promise<MigrateReport> {
  if (!isTauri) throw new Error('只有桌面端才能迁移数据目录')
  try {
    const raw = await invoke<{
      data_dir: string; old_dir: string; files: number; bytes: number; skipped: string[]
    }>('migrate_data_dir')
    return {
      dataDir: raw.data_dir,
      oldDir: raw.old_dir,
      files: raw.files,
      bytes: raw.bytes,
      skipped: raw.skipped ?? [],
    }
  } catch (e) {
    // Rust 侧的 `Err(String)` 会被 invoke 原样抛出（**不是** Error 对象），
    // 这里统一成 Error：调用方拿 `.message` 就能直接显示给用户
    throw new Error(typeof e === 'string' ? e : String(e))
  }
}

/** 删除迁移前的旧目录（**用户确认后**才调；返回释放的字节数） */
export async function deleteOldDataDir(dir: string): Promise<number> {
  if (!isTauri) throw new Error('只有桌面端才能删除旧数据目录')
  try {
    return await invoke<number>('delete_old_data_dir', { dir })
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e))
  }
}

// ── 应用内更新（R23b，devlog/114）─────────────────────────────────────

export interface UpdateInfo {
  version: string
  /** 更新说明（取自 `latest.json` 的 notes，是发布说明的开头一段） */
  notes: string | null
  date: string | null
}

/**
 * 待安装的更新。**留在模块作用域**：启动时的静默检查发现新版本后，
 * 用户过一会儿才点"更新并重启"，那时不该再查一次（也避免两次检查结果不一致）。
 */
let pendingUpdate: unknown = null
/** 与 `pendingUpdate` 配套的信息（给界面直接显示，不必为了"发现了什么版本"再查一次网络） */
let pendingInfo: UpdateInfo | null = null

/** 有没有已发现、待安装的更新（关于页据此直接显示，不必重查） */
export function hasPendingUpdate(): boolean {
  return pendingUpdate !== null
}

/** 已发现的更新信息（没有就返回 `null`）——**不发网络请求** */
export function pendingUpdateInfo(): UpdateInfo | null {
  return pendingInfo
}

/** 最近一次检查是不是**借助本地代理**成功的（界面据此说明，也便于排查） */
let usedProxy: string | null = null

export function lastCheckProxy(): string | null {
  return usedProxy
}

const errText = (e: unknown) => (typeof e === 'string' ? e : String(e))

/** 检查更新失败的**类别**：决定"要不要试代理"和"给用户什么提示" */
export type UpdateErrorKind = 'network' | 'remote' | 'other'

export class UpdateCheckError extends Error {
  kind: UpdateErrorKind

  constructor(kind: UpdateErrorKind, message: string) {
    super(message)
    this.name = 'UpdateCheckError'
    this.kind = kind
  }
}

/**
 * 把更新器/插件的原始报错翻译成**能行动**的话（R23d，devlog/116）。
 *
 * ⚠️ 真机实测（2026-09-16）踩到的坑：远端**还没有发布任何 Release** 时，插件报的是
 * `Could not fetch a valid release JSON from the remote` —— 它看起来像"网络不通"，
 * 于是我那条代理兜底白试了一次，界面上还出现"改用代理后仍失败"的误导性文案。
 * 这两类是**完全不同**的问题：前者再换多少代理都没用（远端没有 `latest.json`）。
 */
export function classifyUpdateError(raw: string): { kind: UpdateErrorKind; text: string } {
  const s = raw.toLowerCase()
  const looksRemote =
    s.includes('valid release json') || s.includes('404') || s.includes('not found')
  if (looksRemote) {
    return {
      kind: 'remote',
      text: '远端没有可用的更新信息（通常是还没发布过版本，或发布资产里缺 latest.json）',
    }
  }
  const looksNetwork = ['connect', 'dns', 'timed out', 'timeout', 'sending request',
    'network', 'unreachable', 'tls', 'certificate'].some((k) => s.includes(k))
  if (looksNetwork) {
    return { kind: 'network', text: raw }
  }
  return { kind: 'other', text: raw }
}

async function pluginCheck(): Promise<UpdateInfo | null> {
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  if (!update) {
    pendingUpdate = null
    pendingInfo = null
    return null
  }
  pendingUpdate = update
  pendingInfo = {
    version: update.version,
    notes: update.body ?? null,
    date: update.date ?? null,
  }
  return pendingInfo
}

/**
 * 检查更新。三种"没有更新"要分清（都返回 `null`，但含义不同）：
 * - 浏览器/探针环境：**根本没有这回事**（不该显示按钮）；
 * - 已是最新：正常结果；
 * - 检查失败：**抛错**，调用方必须把原因显示出来。
 *
 * **代理兜底（R23c，devlog/115）**：`reqwest` 编译时带了 `system-proxy`，所以系统代理模式
 * （Clash/v2rayN 的"系统代理"开关）下本来就走代理。但代理只配在浏览器/git 里、或系统代理
 * 开关关着时，应用会直连失败 —— 而用户明明有个能用的代理在跑。所以失败后：
 * 探一遍常见本地代理端口 → 探到就把 `HTTPS_PROXY` 设进**本进程**（不动系统设置）→ 重试一次。
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null
  usedProxy = null
  try {
    return await pluginCheck()
  } catch (first) {
    const cls = classifyUpdateError(errText(first))
    // ⚠️ **只有网络类错误才试代理**：远端没有 latest.json（还没发版）时换代理也是 404，
    //    白试一次还会在界面上写出"改用代理后仍失败"这种误导性文案（真机实测过）
    if (cls.kind !== 'network') {
      throw new UpdateCheckError(cls.kind, cls.text)
    }
    let proxy: string | null = null
    try {
      proxy = await invoke<string | null>('probe_local_proxy')
    } catch {
      proxy = null
    }
    if (!proxy) {
      throw new UpdateCheckError('network', `${cls.text}（也没检测到本地代理在监听）`)
    }
    try {
      await invoke('set_process_proxy', { url: proxy })
      const info = await pluginCheck()
      usedProxy = proxy
      return info
    } catch (second) {
      const cls2 = classifyUpdateError(errText(second))
      if (cls2.kind !== 'network') {
        // 代理连上了但远端内容不对：如实说内容问题，别赖代理
        throw new UpdateCheckError(cls2.kind, cls2.text)
      }
      throw new UpdateCheckError(
        'network',
        `${cls.text}；改用本地代理 ${proxy} 后仍失败：${cls2.text}`,
      )
    }
  }
}

/**
 * 下载并安装（装完自动重启自己）。`onProgress` 拿到 0–100；`null` = 总大小未知。
 *
 * 便携版**不调这个**（解压即用的目录不该被安装器覆盖）——由调用方按 `storageInfo().portable` 决定。
 */
export async function installUpdate(onProgress?: (pct: number | null) => void): Promise<void> {
  if (!isTauri) throw new Error('只有桌面端才能安装更新')
  if (!pendingUpdate) throw new Error('没有待安装的更新（先点一次「检查更新」）')
  let total = 0
  let done = 0
  try {
    const update = pendingUpdate as {
      downloadAndInstall: (cb: (e: {
        event: string
        data?: { contentLength?: number; chunkLength?: number }
      }) => void) => Promise<void>
    }
    await update.downloadAndInstall((e) => {
      if (e.event === 'Started') {
        total = e.data?.contentLength ?? 0
        onProgress?.(total ? 0 : null)
      } else if (e.event === 'Progress') {
        done += e.data?.chunkLength ?? 0
        onProgress?.(total ? Math.min(100, Math.round((done / total) * 100)) : null)
      } else if (e.event === 'Finished') {
        onProgress?.(100)
      }
    })
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e))
  }
}

/** 打开发布页（连不上 GitHub 时的兜底：让用户手动下载安装包）。 */
export async function openReleasePage(): Promise<boolean> {
  if (!isTauri) return false
  try {
    await invoke('open_release_page')
    return true
  } catch {
    return false
  }
}

/**
 * 更新托盘那行状态（R29，devlog/129）：传 `null` 复位成「后台运行中」。
 *
 * 用途：窗口收进托盘后没人看界面，风控冷却就"看不见"了 —— 壳把它显示在托盘 tooltip
 * 与菜单项 `status` 上，悬停托盘图标即可见。
 * **失败静默**（浏览器/探针环境下 `isTauri` 为假，直接返回；壳侧写不进也只记日志）：
 * 托盘文案是提示，不该影响任何功能。
 */
export async function setTrayStatus(text: string | null): Promise<void> {
  if (!isTauri) return
  try {
    await invoke('set_tray_status', { text })
  } catch {
    /* 忽略：见上 */
  }
}
