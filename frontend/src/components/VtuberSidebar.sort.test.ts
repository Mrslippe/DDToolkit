/**
 * 左栏排序的**接线**判据（需求 5，`devlog/414`）。
 *
 * 为什么是源码级：`VtuberSidebar` 是个大组件（API + router + FloatPill + OverlayScroll），
 * 为这一格搭整套渲染夹具不划算。但**接线本身会悄悄丢**（下次改筛选顺手就删了），
 * 而纯函数用例（`vtuberSort.test.ts` 那 10 条）覆盖不到"它到底有没有被接上"。
 * ⇒ 这里只钉三件接线事实，**行为正确性归纯函数那 10 条**，各管一段。
 * ⚠️ **断言一律用"行首锚定"的正则，不用 `toContain`**：后者连**注释里**那句话也算命中 ——
 * 第一版就是这么假绿的（把 `saveVtuberSortKey(k)` 注释掉，判据照样全过）。
 * 同 `devlog/382` 那条"全文搜会被本测试自己里的字面量满足"（自指假绿）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.resolve(HERE, 'VtuberSidebar.tsx'), 'utf8')

/** 行首锚定：只认**语句**，不认注释里的同一句话。 */
const stmt = (re: string) => new RegExp(`^\\s*${re}`, 'm')

describe('左栏排序：接线', () => {
  it('排序走 `sortVtubers`，且**排在筛选之后**（顺序反了会把 custom 打乱）', () => {
    expect(src).toMatch(stmt('return sortVtubers\\(list, sortKey\\)'))
    const kwAt = src.indexOf('v.name.toLowerCase().includes(kw)')
    const sortAt = src.search(stmt('return sortVtubers\\(list, sortKey\\)'))
    expect(kwAt, '锚点没了（筛选那段改名了？）').toBeGreaterThan(0)
    expect(sortAt, '排序必须落在筛选之后').toBeGreaterThan(kwAt)
  })

  it('六档从**真源**渲染（不是手抄六个按钮 —— 加一档时不会漏）', () => {
    expect(src).toMatch(stmt('\\{VTUBER_SORT_KEYS\\.map\\('))
    expect(src).toMatch(stmt('\\{VTUBER_SORT_LABEL\\[k\\]\\}'))
  })

  it('选一档要**落盘**，读档要**接上**（偏好与 `playerPrefs` 同套路：localStorage）', () => {
    expect(src).toMatch(stmt('saveVtuberSortKey\\(k\\)'))
    expect(src).toMatch(stmt('const \\[sortKey, setSortKey\\] = useState<VtuberSortKey>\\(\\(\\) => loadVtuberSortKey\\(\\)\\)'))
  })
})
