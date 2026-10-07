// @vitest-environment jsdom
/**
 * 闲置判定（`devlog/435` 起用它决定"界面元素让位"）：鼠标停一会儿 ⇒ `true`；一动 ⇒ `false` 并重新计时。
 *
 * ⚠️ 这一条此前**没有判据**（只有 `peekZoneAt`/`useSoloPeek` 有），而用户实测"让位没生效" ——
 * 先把"它到底会不会变 true"钉住，再谈 CSS。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSoloIdle } from './soloPeek'

function Probe({ enabled, ms }: { enabled: boolean; ms: number }) {
  const idle = useSoloIdle(enabled, ms)
  return <span data-testid="idle">{idle ? '1' : '0'}</span>
}

let host: HTMLDivElement
let root: Root
const shown = () => host.querySelector('[data-testid="idle"]')!.textContent
const move = async (x = 100, y = 100) => {
  await act(async () => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }))
    await Promise.resolve()
  })
}
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useSoloIdle', () => {
  it('★ 停够时间 ⇒ 闲置；**一动就回来并重新计时**', async () => {
    await act(async () => { root.render(<Probe enabled ms={5000} />) })
    expect(shown(), '刚进来还没闲置').toBe('0')
    await advance(4999)
    expect(shown(), '差 1ms 还不算').toBe('0')
    await advance(2)
    expect(shown(), '够 5s ⇒ 闲置').toBe('1')
    await move()
    expect(shown(), '一动立刻退出闲置').toBe('0')
    await advance(4999)
    expect(shown(), '计时重新开始').toBe('0')
    await advance(2)
    expect(shown()).toBe('1')
  })

  it('★ **抖动不算动**（`SOLO_IDLE_EPS_PX` 那颗死区旋钮）：触控板搭手指 / 传感器抖动不该把计时一直顶回去', async () => {
    await act(async () => { root.render(<Probe enabled ms={100} />) })
    await move(100, 100)          // 第一次算"动"（还没有基准）
    // 之后每 10ms 抖 1px —— 真机上这就是"停着不动"的样子
    for (let i = 0; i < 12; i++) {
      await advance(10)
      await move(100 + (i % 2), 100)
    }
    expect(shown(), '⚠️ 1px 级抖动不该重置计时 ⇒ 该闲置了').toBe('1')
    // 正对照：真的挪一大步 ⇒ 立刻回来
    await move(400, 400)
    expect(shown()).toBe('0')
  })

  it('★ 没在单推（`enabled=false`）⇒ 永远不闲置，也不挂监听', async () => {
    await act(async () => { root.render(<Probe enabled={false} ms={10} />) })
    await advance(5000)
    expect(shown()).toBe('0')
  })
})
