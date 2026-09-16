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

/**
 * 检查更新。三种"没有更新"要分清（都返回 `null`，但含义不同）：
 * - 浏览器/探针环境：**根本没有这回事**（不该显示按钮）；
 * - 已是最新：正常结果；
 * - 检查失败：**抛错**，调用方必须把原因显示出来（连不上 github 是最常见的失败）。
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null
  try {
    // 动态 import：插件包只在这条路径上加载 —— 探针跑在无头浏览器里，不该被它们影响
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
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e))
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
