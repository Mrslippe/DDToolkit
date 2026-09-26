/**
 * **小窗能碰到的命令 ⊆ 小窗允许的命令**（S3-0 的派生判据，devlog/208 §六）。
 *
 * ## 为什么要有它（这条是补的，因为手工清单真的漏了）
 *
 * 2026-09-26 真机复验：用户报"小窗功能稍微有点问题"。查下去是 `COMMAND_ACL` 把
 * **`destroy_widget_window`** 与 **`is_fullscreen_app_running`** 填成了"只有主窗口"，
 * 而它们同样是 `StatusWidgetWindow` 在调的（小窗自己的关闭请求 + 全屏隐藏逻辑）。
 *
 * 漏的原因很具体：那两处是**动态 import**（`await import('../utils/shellBridge')`），
 * 而人肉盘点时只看见了同一个文件里另外几处 —— **"我数过了"这类判据不可靠**。
 *
 * ⇒ 这里改成**派生**：从两个前端入口里抠出它们从 `shellBridge` 解构出来的函数名，
 * 再到 `shellBridge.ts` 里查这些函数各自 invoke 了哪条**自定义命令**，
 * 最后要求这些命令**全部**在小窗的可调集合里（真源 = `lib.rs::COMMAND_ACL`）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUST = path.join(SRC, '..', 'src-tauri', 'src', 'lib.rs')

/** 小窗的两个前端入口（`widget.html` → widgetMain；它只渲染 StatusWidgetWindow）。 */
const WIDGET_ENTRIES = ['widgetMain.tsx', 'components/StatusWidgetWindow.tsx']

/** 从入口里抠出 `const { a, b } = await import('../utils/shellBridge')` 的解构名。 */
function shellBridgeNames(file: string): Set<string> {
  const text = readFileSync(path.join(SRC, file), 'utf-8')
  const out = new Set<string>()
  const re = /const\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*['"][^'"]*shellBridge['"]\s*\)/g
  for (const m of text.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(':')[0].trim()
      if (name) out.add(name)
    }
  }
  return out
}

/** `shellBridge.ts` 里每个导出函数 invoke 的命令名（可能有多个，取全部）。 */
function commandsPerBridgeFunction(): Map<string, string[]> {
  const text = readFileSync(path.join(SRC, 'utils', 'shellBridge.ts'), 'utf-8')
  const lines = text.split('\n')
  const out = new Map<string, string[]>()
  let current: string | null = null
  for (const line of lines) {
    const decl = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line)
    if (decl) {
      current = decl[1]
      out.set(current, [])
    }
    if (!current) continue
    const inv = /invoke(?:<[^>]*>)?\(\s*'([a-z_0-9]+)'/.exec(line)
    if (inv) out.get(current)!.push(inv[1])
  }
  return out
}

/** `lib.rs::COMMAND_ACL` 里"允许 widget"的命令。 */
function widgetAllowedCommands(): Set<string> {
  const text = readFileSync(RUST, 'utf-8')
  const start = text.indexOf('const COMMAND_ACL')
  const block = text.slice(start, text.indexOf('];', start))
  const out = new Set<string>()
  for (const line of block.split('\n')) {
    const m = /^\s*\("([a-z_0-9]+)",\s*(BOTH|CALLER_LABELS_ALLOWED)\)/.exec(line)
    if (m) out.add(m[1])
  }
  return out
}

describe('小窗可达命令的准入（派生判据）', () => {
  it('小窗从 shellBridge 拿到的每个函数，其命令都必须允许 widget', () => {
    const perFn = commandsPerBridgeFunction()
    const allowed = widgetAllowedCommands()
    expect(allowed.size, 'COMMAND_ACL 里没解析出任何"允许 widget"的命令').toBeGreaterThan(0)

    const wanted = new Set(shellBridgeNames(WIDGET_ENTRIES[0]))
    for (const n of shellBridgeNames(WIDGET_ENTRIES[1])) wanted.add(n)
    expect(wanted.size, '没从入口里解析出 shellBridge 解构（写法变了？）').toBeGreaterThan(0)

    const problems: string[] = []
    for (const fn of wanted) {
      const cmds = perFn.get(fn)
      if (!cmds) {
        problems.push(`${fn}：shellBridge 里找不到这个导出函数（改名了？）`)
        continue
      }
      for (const cmd of cmds) {
        if (!allowed.has(cmd)) {
          problems.push(`${fn} → invoke('${cmd}')：这条命令的准入里没有 widget`)
        }
      }
    }
    expect(problems, [
      '小窗会调这些命令，但 COMMAND_ACL 没放给小窗 —— 真机症状是"小窗某功能没反应"：',
      ...problems.map((p) => '  · ' + p),
    ].join('\n')).toEqual([])
  })

  it('反方向也钉一下：小窗**不该**拿到"只有主窗能用"的那几条', () => {
    // 这条守的是"别为了修上面那条而把 ACL 一路放宽"：动用户数据 / 不可逆的命令
    // 不许出现在小窗可达集合里。
    const perFn = commandsPerBridgeFunction()
    const dangerous = new Set([
      'delete_old_data_dir', 'migrate_data_dir', 'quit_app', 'hide_to_tray',
      'open_release_page', 'set_process_proxy', 'open_external', 'open_data_dir',
    ])
    const wanted = new Set(shellBridgeNames(WIDGET_ENTRIES[0]))
    for (const n of shellBridgeNames(WIDGET_ENTRIES[1])) wanted.add(n)
    const leaked = [...wanted]
      .flatMap((fn) => perFn.get(fn) ?? [])
      .filter((cmd) => dangerous.has(cmd))
    expect(leaked, '小窗可达集合里出现了危险命令').toEqual([])
  })
})
