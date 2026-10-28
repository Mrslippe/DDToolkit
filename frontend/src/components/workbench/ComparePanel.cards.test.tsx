// @vitest-environment jsdom
/**
 * 对比页**卡片化**（2026-10-28，E 批，用户第 4 条）。
 *
 * 钉两件事：
 * ① 多主播模式下是「选择主播 / 重叠矩阵 / 配对详情」三张卡，**每张卡自带空态**；
 * ② 切到帖子评论是「选择主播 / 评论交集」两张卡（评论卡内部自带分块）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/api', () => ({
  api: {
    fanCompareMulti: () => Promise.resolve({ vtubers: [], matrix: [], pairs: [], needs_analysis: [] }),
  },
  resolveAsset: (p?: string | null) => p ?? null,
}))

import ComparePanel from './ComparePanel'

let host: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <ComparePanel current="弥月Mizuki" options={[{ name: '星瞳', short: '星瞳' }]}
                    window={75} since="2026-09-01" until="2026-10-26" />,
    )
    await Promise.resolve()
  })
}

const q = (sel: string) => host.querySelector(sel)

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('对比页卡片化', () => {
  it('多主播：三张卡 + 矩阵/配对各自的空态', async () => {
    await mount()
    expect(q('[data-testid="compare-card-pick"]')).toBeTruthy()
    expect(q('[data-testid="compare-card-matrix"]')).toBeTruthy()
    expect(q('[data-testid="compare-card-pair"]')).toBeTruthy()
    // 只选了当前主播 ⇒ 两个空态都在，且是结果区同一句文案
    expect(q('[data-testid="compare-matrix-empty"]')!.textContent).toContain('暂无数据')
    expect(q('[data-testid="compare-pair-empty"]')!.textContent).toContain('暂无数据')
    expect(q('[data-testid="compare-matrix"]')).toBeNull()
  })

  it('切到帖子评论：换成评论卡，矩阵与配对卡消失', async () => {
    await mount()
    await act(async () => {
      q('[data-testid="compare-mode-comment"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(q('[data-testid="compare-card-comment"]')).toBeTruthy()
    expect(q('[data-testid="compare-card-matrix"]')).toBeNull()
    expect(q('[data-testid="compare-card-pair"]')).toBeNull()
  })
})
