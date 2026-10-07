/**
 * 左栏**按住拖动重排**的接线判据（需求 4，`devlog/415`）。
 *
 * 拖拽的"算"全在 `utils/vtuberReorder.ts`（那里 6 条纯函数判据）；这里只钉**接线**：
 * 指针事件有没有接上、落点怎么算、松手有没有落库、失败有没有回退。
 * ⚠️ 断言一律**行首锚定正则**：`toContain` 会被注释里的同一句话满足 ——
 * `VtuberSidebar.sort.test.ts` 第一版就这么假绿过，别再来一次。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.resolve(HERE, 'VtuberSidebar.tsx'), 'utf8')
const stmt = (re: string) => new RegExp(`^\\s*${re}`, 'm')

describe('左栏拖动重排：接线', () => {
  it('落点靠 `elementFromPoint` + `data-vtuber-id`/`data-index`（不手算几何，同 `devlog/048`）', () => {
    expect(src).toMatch(stmt('const hit = document\\.elementFromPoint\\(ev\\.clientX, ev\\.clientY\\)'))
    expect(src).toMatch(stmt('\\?\\.closest\\(\\\'\\[data-vtuber-id\\]\\\'\\)'))
    expect(src).toMatch(stmt('data-vtuber-id=\\{vtuber\\.id\\}'))
    expect(src).toMatch(stmt('data-index=\\{index\\}'))
  })

  it('"按住"有阈值：`DRAG_HOLD_MS` 到点才进拖拽态（否则"点一下选中"当场变成拖动）', () => {
    expect(src).toMatch(stmt('timer: window\\.setTimeout\\(\\(\\) => \\{'))
    expect(src).toMatch(stmt('\\}, DRAG_HOLD_MS\\),'))
    expect(src).toMatch(stmt('if \\(Math\\.hypot\\(ev\\.clientX - x, ev\\.clientY - y\\) > DRAG_CANCEL_PX\\) stop\\(\\)'))
  })

  it('★ 进拖拽态的同一拍**切到"自定义"**（任何档位下拖一下就生效，用户口径）', () => {
    expect(src).toMatch(stmt('pickSort\\(\\\'custom\\\'\\)'))
    expect(src).toMatch(stmt('setDragId\\(id\\)'))
  })

  it('移动用 `moveItem`，乐观渲染用 `applyVisibleOrder`（与服务端同一套语义）', () => {
    expect(src).toMatch(stmt('const next = moveItem\\(cur, from, to\\)'))
    expect(src).toMatch(stmt('setVtubers\\(\\(alls\\) => applyVisibleOrder\\(alls, next\\.map\\(\\(v\\) => v\\.id\\)\\)\\)'))
  })

  it('松手落库 `reorderVtubers`；**失败要回退**（重拉服务端顺序，不静默吞掉）', () => {
    expect(src).toMatch(stmt('void api\\.reorderVtubers\\(order\\)\\.catch\\(\\(\\) => \\{'))
    const at = src.search(stmt('void api\\.reorderVtubers\\(order\\)'))
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 400), '落库失败必须重拉（否则"拖了没保存"会静默）').toContain('load()')
  })
})
