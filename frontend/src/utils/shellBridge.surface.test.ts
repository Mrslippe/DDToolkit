// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 窗口表面状态的两个格子（`devlog/382` 起，`devlog/383` 改正口径）。
 *
 * 判错的代价（真发生过）：诊断行是在**窗口结束时**写的，而那时用户往往已经退出全屏 ——
 * 第一版记的是"写日志那一刻"的状态，于是 22:54–23:00 那三条日志全都写成 `表面=transparent`，
 * 读日志的人**根本判断不出**那一轮到底有没有带不透明表面跑。粘性标记回答的是正确的问题：
 * **这一个窗口期间有没有不透明过**。
 *
 * 另一半是失败路径：`invoke` 被拒（跑在旧壳上、命令不存在）时**不许**置粘性位 ——
 * 否则"压根没生效"会被读成"生效了但没用"，那是两个完全相反的结论。
 */
const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args) as unknown,
}))

/** 每例都拿一份**全新**的模块（粘性标记是模块状态，不隔离就测不出"没置位"）。 */
async function freshModule() {
  vi.resetModules()
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  return await import('./shellBridge')
}

beforeEach(() => {
  invoke.mockReset()
})

describe('窗口表面状态', () => {
  it('没调过：状态是 unknown、粘性标记为假（不许一上来就说"生效了"）', async () => {
    const m = await freshModule()
    expect(m.surfaceState()).toBe('unknown')
    expect(m.surfaceEverOpaque()).toBe(false)
  })

  it('切到不透明后**退出全屏也不复位**：报告那一刻多半已经退出全屏', async () => {
    const m = await freshModule()
    invoke.mockResolvedValue(undefined)
    await expect(m.setSurfaceOpaque(true)).resolves.toBe(true)
    expect(m.surfaceState()).toBe('opaque')
    expect(m.surfaceEverOpaque()).toBe(true)

    await expect(m.setSurfaceOpaque(false)).resolves.toBe(true)
    expect(m.surfaceState(), '当前状态要如实变回 transparent').toBe('transparent')
    expect(m.surfaceEverOpaque(), '粘性标记：这一轮确实带过不透明表面').toBe(true)
  })

  it('被拒（旧壳没有这条命令）：记 failed，且**不许**置粘性位', async () => {
    const m = await freshModule()
    invoke.mockRejectedValue(new Error('command not found'))
    await expect(m.setSurfaceOpaque(true)).resolves.toBe(false)
    expect(m.surfaceState()).toBe('failed')
    expect(m.surfaceEverOpaque(), '失败被读成"生效了但没用"就是误判').toBe(false)
  })

  it('浏览器/探针里没有壳：静默退化，不撒谎', async () => {
    vi.resetModules()
    // 这一例**不**装 `__TAURI_INTERNALS__`（前面几例往同一个 jsdom `window` 上装过，这里要摘掉）
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    const m = await import('./shellBridge')
    await expect(m.setSurfaceOpaque(true)).resolves.toBe(false)
    expect(m.surfaceState()).toBe('unknown')
    expect(m.surfaceEverOpaque()).toBe(false)
    expect(invoke, '没有壳就别去调 IPC').not.toHaveBeenCalled()
  })
})
