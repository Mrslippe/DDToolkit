import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 二级弹窗页脚的**迁移完整性**（R21 批 3，devlog/102）—— 纯静态扫描，不渲染组件。
 *
 * 为什么需要这条：这批改动是"把 N 个弹窗的页脚按钮换成同一套浮片"，
 * **漏掉一个在界面上看不出来**（你只会觉得"某个窗口的按钮好像有点不一样"），
 * 而行为型断言（探针）只覆盖它真能打开的窗口。所以这里做两件事：
 * ① 每个"有页脚"的弹窗都必须出现浮片（组件 `<FloatPill>` 或类名 `float-pill`）；
 * ② **弹窗清单是冻结的** —— 以后新增一个 `*Dialog.tsx`，必须在这里被判一次
 *    （归到"有页脚"还是"确认过没有页脚"），否则这条用例红。
 *
 * ⚠️ 它**不能**替代探针：这里只证明"代码里有浮片"，坐标/可命中/主操作高亮那些
 * 由 `scripts/ui_probe.py` 在真界面上量（`--app-settings` / `--capabilities` / `--close-ask`）。
 */

const DIR = join(__dirname, '..', 'components')

/** 有页脚按钮的二级弹窗：页脚必须是浮片 */
const WITH_FOOT = [
  'AccountHistoryDialog.tsx',
  'AddAccountDialog.tsx',
  'AppSettingsDialog.tsx',
  'CapabilityLimits.tsx',
  'CloseActionDialog.tsx',
  'VtuberSettingsDialog.tsx',
]

/** 确认过"本来就没有页脚按钮"的弹窗，不属于这批的范围 */
const NO_FOOT = [
  'AddVtuberDialog.tsx',      // 搜索 + 列表，关闭靠 ✕
  'BatchFetchDialog.tsx',     // 一整列动作卡片，点了就跑；没有确认/取消
  'LoginDialog.tsx',          // 扫码登录流，页脚是状态说明不是按钮
]

const read = (f: string) => readFileSync(join(DIR, f), 'utf8')

describe('二级弹窗页脚 = 浮片（迁移完整性）', () => {
  it('每个有页脚的弹窗都用了浮片（组件或类名都算）', () => {
    const missing = WITH_FOOT.filter((f) => {
      const src = read(f)
      return !src.includes('FloatPill') && !src.includes('float-pill')
    })
    expect(missing).toEqual([])
  })

  it('弹窗清单是冻结的：新增弹窗必须在这里被判一次', () => {
    const dialogs = readdirSync(DIR)
      .filter((f) => f.endsWith('Dialog.tsx') || f === 'CapabilityLimits.tsx')
      .sort()
    expect(dialogs).toEqual([...WITH_FOOT, ...NO_FOOT].sort())
  })

  it('主操作带 `.on`（`active`）—— 页脚不能两个按钮一样重', () => {
    // 设置窗口：保存是主操作；添加账号：添加是主操作
    expect(read('AppSettingsDialog.tsx')).toMatch(/shape="text" active/)
    expect(read('AddAccountDialog.tsx')).toMatch(/shape="text" active/)
  })
})
