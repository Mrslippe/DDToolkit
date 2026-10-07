// @vitest-environment jsdom
/**
 * 单推的唤出区判定（2026-10-07 用户三条反馈后重做，`devlog/433`）。
 *
 * 为什么这一版能站住：**只看坐标**（`mousemove` + `clientX/clientY`）——
 * 前两版分别用 CSS `:hover` 与"指针落在哪个元素上"，都因为"唤出会改变布局"而让状态来回翻
 * （用户报的"界面元素快速闪动 + 卡顿"，以及左侧工具栏干脆唤不出来）。
 *
 * 四条判据：
 * ① 三个区互不重叠、优先级是"上缘 > 左缘 > 其余"；
 * ② ★**唤出后那个区会长大**到该栏自身的大小（否则指针一移进去就掉出薄条、栏从手底下消失）；
 * ③ 退出单推 ⇒ 复位（下次进来不会带着上次的唤出态）；
 * ④ 指针划过 ⇒ 只在该变的时候变（同值不重渲染）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { peekZoneAt, useSoloPeek, type SoloPeek } from './soloPeek'

const M = { railW: 50, topH: 46 }
const at = (x: number, y: number, cur: SoloPeek = 'center') => peekZoneAt(x, y, { ...M, current: cur })

describe('唤出区：按坐标判定', () => {
  it('★ 三个区互不重叠；左上角那一小块归**顶栏**（顺序即优先级）', () => {
    expect(at(400, 3), '贴上缘').toBe('top')
    expect(at(400, 40), '离上缘远了 ⇒ 中间区').toBe('center')
    expect(at(3, 400), '贴左缘那条薄条').toBe('left')
    expect(at(30, 400), '⚠️ 没唤出时只有 8px 薄条（三个区不许重叠 ⇒ 触发条必须窄）').toBe('center')
    expect(at(3, 3), '左上角：顶栏优先').toBe('top')
    expect(at(400, 400), '中间那块 = 界面元素区').toBe('center')
    expect(at(0, 0)).toBe('top')
  })

  it('★ 唤出之后那个区**长大**到该栏自身的大小（否则指针一移进去就掉出去）', () => {
    // 顶栏：没唤出时只有 8px 薄条；唤出后整条 46px 都算它的
    expect(at(400, 40, 'center'), '没唤出时 y=40 不算顶栏').toBe('center')
    expect(at(400, 40, 'top'), '唤出后 y=40 仍在顶栏区里').toBe('top')
    expect(at(400, 47, 'top'), '超出顶栏高度就出去').toBe('center')
    // 工具栏：没唤出时只有 8px；唤出后整个 50px 宽都算它的
    expect(at(30, 400, 'center'), '没唤出时 x=30 不算工具栏').toBe('center')
    expect(at(30, 400, 'left'), '唤出后 x=30 仍在工具栏区里').toBe('left')
    expect(at(55, 400, 'left'), '超出工具栏宽度就出去').toBe('center')
    // ⚠️ 顶栏"长大"不妨碍左缘（y 已经超出顶栏高度）
    expect(at(3, 100, 'top')).toBe('left')
  })
})

describe('useSoloPeek：跟着指针走', () => {
  let host: HTMLDivElement
  let root: Root
  /** 探针：把 hook 的返回值画出来 */
  function Probe({ enabled }: { enabled: boolean }) {
    const peek = useSoloPeek(enabled)
    return <span data-testid="peek">{peek}</span>
  }
  const shown = () => host.querySelector('[data-testid="peek"]')!.textContent
  const move = async (x: number, y: number) => {
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }))
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('★ 未启用（不在单推里）⇒ 恒定 `center`，且**不挂**全局监听', async () => {
    await act(async () => { root.render(<Probe enabled={false} />) })
    await move(3, 3)
    expect(shown(), '没在单推 ⇒ 划到哪儿都不该唤出').toBe('center')
  })

  it('★ 启用后：贴上缘 ⇒ `top`；划到中间 ⇒ 回 `center`；退出单推 ⇒ 复位', async () => {
    await act(async () => { root.render(<Probe enabled />) })
    expect(shown()).toBe('center')
    await move(400, 3)
    expect(shown()).toBe('top')
    await move(3, 400)
    expect(shown()).toBe('left')
    await move(400, 400)
    expect(shown()).toBe('center')
    // 退出单推 ⇒ 复位（下次进来不带上次的唤出态）
    await move(400, 3)
    await act(async () => { root.render(<Probe enabled={false} />) })
    expect(shown()).toBe('center')
  })
})
