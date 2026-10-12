// @vitest-environment jsdom
/**
 * 场景预取抢跑的**接线判据**（2026-10-13，`devlog/474`）。
 *
 * ## 分档长什么样
 *
 * 用户在数据视图上看到的是"退场动画播完，日期格才慢慢填上"—— 因为切视图时
 * `useSceneTransition` **不预取**，卡片挂载后才开始取数（实测那一发中位 ~176ms）。
 * 修法是：页面在退场那 150ms 窗口里把这一发抢跑出去，赶上了就交给日历当**首帧种子**。
 *
 * 纯函数那半边没什么可测的（`useLiveSessions` 只是把它当 `useState` 初值）——
 * 这里钉的是**"卡片真的用了种子、且没有再去打第二发"**：
 * 只测纯函数的话，"页面压根没把它传下来"照样绿。
 *
 * ⚠️ mock 路径是 `../api/api`（本文件在 `src/components/`）—— 写成别的路径
 * **不报错，但也不生效**：组件照旧调 `api.liveSessions`，而 jsdom 里没有后端
 * ⇒ 用例会红在一个与被测逻辑无关的地方（`coverSource.wiring.test.tsx` 踩过这个坑）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const liveSessions = vi.fn()
const reservations = vi.fn()
vi.mock('../api/api', async (orig) => {
  const real = await orig<typeof import('../api/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      liveSessions: (...a: unknown[]) => liveSessions(...a),
      reservations: (...a: unknown[]) => reservations(...a),
    },
  }
})

import LiveCalendar from './LiveCalendar'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 一场落在**当月**的场次（网格要能看见它，才说明首帧真的有内容）。 */
function sessionInMonth(title: string) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 15, 12, 0, 0)
  return {
    source: 'danmakus',
    live_id: `seed-${title}`,
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + 90 * 60 * 1000).toISOString(),
    duration_minutes: 90,
    live_title: title,
    category: 'game',
    category_from: 'title',
  } as never
}

let root: Root | null = null
let host: HTMLDivElement | null = null

async function render(el: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(el) })
  // 让挂载期发出去的 promise 落地（fetch 是 mock，microtask 就够）
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  liveSessions.mockReset().mockResolvedValue([])
  reservations.mockReset().mockResolvedValue([])
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = null
  host = null
})

describe('日历的场次种子（场景预取抢跑）', () => {
  it('★给了种子 ⇒ 首帧就有场次，且**不再打那一发请求**', async () => {
    await render(
      <LiveCalendar accountId={7} vtuberId={3} refreshTick={0}
                    seedSessions={[sessionInMonth('种子场次')]} />,
    )
    expect(host!.textContent).toContain('种子场次')
    expect(liveSessions).not.toHaveBeenCalled()
  })

  it('★没种子（预取没赶上 / 失败）⇒ 照旧自己取（行为与改动前一致）', async () => {
    liveSessions.mockResolvedValue([sessionInMonth('自己取的场次')])
    await render(<LiveCalendar accountId={7} vtuberId={3} refreshTick={0} />)
    expect(liveSessions).toHaveBeenCalledTimes(1)
    await act(async () => { await Promise.resolve() })
    expect(host!.textContent).toContain('自己取的场次')
  })

  it('★刷新节拍变了 ⇒ 必须真的重取（种子只顶首帧，不是"永远不取"）', async () => {
    liveSessions.mockResolvedValue([sessionInMonth('刷新后的场次')])
    await render(
      <LiveCalendar accountId={7} vtuberId={3} refreshTick={0}
                    seedSessions={[sessionInMonth('种子场次')]} />,
    )
    expect(liveSessions).not.toHaveBeenCalled()

    await act(async () => { root!.render(
      <LiveCalendar accountId={7} vtuberId={3} refreshTick={1}
                    seedSessions={[sessionInMonth('种子场次')]} />) })
    await act(async () => { await Promise.resolve() })
    expect(liveSessions).toHaveBeenCalledTimes(1)
    expect(host!.textContent).toContain('刷新后的场次')
  })
})
