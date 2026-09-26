// @vitest-environment jsdom
/**
 * 外链打开的**唯一入口**（S3-B，devlog/208）。
 *
 * 判据为什么长这样：真正的安全边界在 Rust 侧（`lib.rs::external_url_host` 的主机白名单 +
 * 那条 `external_url_rejects_everything_else` 矩阵），前端**不该复制那张表**。
 * 前端这层要守的是两件事：
 *  1. 桌面端**只走自定义命令** `open_external`（旧的 `plugin:shell|open` 已从 capability 删除 ——
 *     它用的是插件内置正则，没有主机白名单）；
 *  2. 拒绝原因**原样抛出去**（调用方要显示它）—— 静默失败等于用户点了一下没反应。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

async function importBridge(withTauri: boolean) {
  vi.resetModules()
  const w = window as unknown as Record<string, unknown>
  if (withTauri) {
    w.__TAURI_INTERNALS__ = {}
  } else {
    delete w.__TAURI_INTERNALS__
  }
  return await import('./shellBridge')
}

describe('openExternal', () => {
  beforeEach(() => {
    invoke.mockReset()
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('浏览器/探针：退化为新标签页（探针没有 Tauri，这条路必须留着）', async () => {
    const { openExternal } = await importBridge(false)
    await openExternal('https://space.bilibili.com/1')
    expect(window.open).toHaveBeenCalledWith('https://space.bilibili.com/1', '_blank', 'noopener')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('桌面端：走 open_external 命令（带 url 参数）', async () => {
    invoke.mockResolvedValue(undefined)
    const { openExternal } = await importBridge(true)
    await openExternal('https://space.bilibili.com/1')
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://space.bilibili.com/1' })
    expect(window.open).not.toHaveBeenCalled()
  })

  it('桌面端：被白名单拒绝时**把原因抛出去**（不吞、不退化）', async () => {
    invoke.mockRejectedValue(new Error('这个主机不在允许打开的名单里：evil.com'))
    const { openExternal } = await importBridge(true)
    await expect(openExternal('https://evil.com/')).rejects.toThrow('不在允许打开的名单里')
    expect(window.open).not.toHaveBeenCalled()   // 被拒 ≠ 换个方式打开
  })

  it('前端不再用 plugin:shell|open（那条通路没有主机白名单，已从 capability 删除）', () => {
    // 扫源码而不是靠人记得：旧通路一旦在某个组件里复活，本用例红。
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(e.name) || e.name.endsWith('.test.ts')) continue
        readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
          const trimmed = line.trim()
          // 跳过注释行：本仓已 4 次踩到"判据的说明文字命中判据自己"
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
          if (line.includes('plugin:shell|open')) {
            offenders.push(`${path.relative(root, p)}:${i + 1}`)
          }
        })
      }
    }
    walk(root)
    expect(offenders, '外链必须走 shellBridge.openExternal（命令侧有主机白名单）').toEqual([])
  })
})
