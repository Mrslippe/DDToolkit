// @vitest-environment node
/**
 * **弹窗层叠的契约**（2026-10-15，`devlog/499`）。
 *
 * ## 为什么是源码级判据
 *
 * 用户连报两次同一类毛病：
 * ① 「点击扫描录播并自动填充后，遮罩盖住了窗口，**点击任意处都会关闭窗口，无法选中按钮**」；
 * ② 「在没有录播的日期格详情窗口中，点击添加录播按钮打开的小窗**和前面提到的症状相同**」。
 *
 * 两次的根因是同一个：**面板的 z-index 低于它自己的遮罩**（面板吃 Radix 基座的 `z-50`，
 * 而遮罩是 `.lc-dlg-backdrop` 的 60 ⇒ 面板在遮罩底下 ⇒ 点哪都被当"点外部"）。
 * 第一次只修了当时在场的三个窗，**漏了 `VodDialog`** —— 于是第二次原样复发。
 *
 * ⇒ 这一族窗"能不能点"取决于一个类名在不在，而**少写一个类不会有任何行为报错**
 *（编译过、用例过、渲染也对，只有真机上点不动）。所以钉在这里：
 * **只要它是从场次详情窗里开出来的，就必须带 `lc-dlg-layer`。**
 *
 * ⚠️ jsdom 量不到层号（没有布局与命中测试）⇒ 真正的层号由真机探针守着
 * （`python scripts/ui_probe.py --vod-fill` 的"面板严格高于遮罩 / 中心点命中自己"）；
 * 这一条守的是**"那个类有没有写"**，两者互补。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const LIVE = resolve(__dirname, '.')

/** 从**场次详情窗里**打开的小窗 —— 都必须抬到第 7 层（`lc-dlg-layer`）。 */
const NESTED_DIALOGS = [
  'ManualSessionDialog.tsx',   // 详情页下拉栏的「编辑这一场」
  'VodDialog.tsx',             // 详情封面 ＋ / 下拉栏的「添加·更换录播」← 第二次报的就是它
  'VodAccountDialog.tsx',      // 录播号设置（详情里也可能开）
  'VodFillDialog.tsx',         // 录播填充审查窗（工具栏 `+`，但它盖的是整页）
]

function read(name: string): string {
  return readFileSync(resolve(LIVE, name), 'utf8')
}

describe('从详情窗里开的小窗：层叠契约', () => {
  it.each(NESTED_DIALOGS)('%s 的遮罩与面板都带 `lc-dlg-layer`', (file) => {
    const src = read(file)
    const content = src.match(/<DialogContent[\s\S]*?>/)?.[0] ?? ''
    expect(content, `${file}: 找不到 <DialogContent>`).toBeTruthy()
    expect(content, `${file}: 面板缺 lc-dlg-layer（会掉到遮罩下面，点哪都关窗）`)
      .toMatch(/className="[^"]*lc-dlg-layer/)
    expect(content, `${file}: 遮罩缺 lc-dlg-layer（那么它盖不住底下那个二级窗）`)
      .toMatch(/overlayClassName="[^"]*lc-dlg-layer/)
  })

  it('第 7 层的层号来自令牌，面板不自己写数字（写死就会漂）', () => {
    const tokens = readFileSync(
      resolve(__dirname, '../../styles/tokens.css'), 'utf8')
    expect(tokens).toContain('--z-dialog-6')
    expect(tokens).toContain('--z-dialog-7')
    const posts = readFileSync(
      resolve(__dirname, '../../styles/posts.css'), 'utf8')
    // 兜底规则必须在：面板 = 遮罩 + 1，嵌套层用 --z-dialog-7
    expect(posts).toMatch(/\[data-slot='dialog-overlay'\]\s*\{[^}]*--z-dialog-6/)
    expect(posts).toMatch(/\[data-slot='dialog-content'\]\s*\{[^}]*calc\(var\(--z-dialog-6[^)]*\)\s*\+\s*1\)/)
    expect(posts).toMatch(/\[data-slot='dialog-content'\]\.lc-dlg-layer\s*\{[^}]*--z-dialog-7/)
  })
})
