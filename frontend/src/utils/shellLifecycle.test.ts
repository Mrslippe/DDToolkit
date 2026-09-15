import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SHELL_HIDDEN_EVENT,
  SHELL_SHOWN_EVENT,
  isShellHidden,
  onShellVisibilityChange,
  resetShellLifecycle,
  setShellHidden,
} from './shellLifecycle'

/**
 * 外壳可见性生命周期（R18，devlog/095）。
 * 判错的代价：① 隐藏后定时器还在跑（用户要的"不用渲染前端"落空，且白烧请求）；
 * ② 同值重复设置也通知 → 恢复时被多次"立刻刷一轮"打爆；
 * ③ 单个订阅者抛错带倒其它订阅者（顶栏挂了不该把侧栏一起带走）。
 */
afterEach(() => resetShellLifecycle())

describe('隐藏状态与订阅', () => {
  it('初始是可见（隐藏必须是**被明确告知**的）', () => {
    expect(isShellHidden()).toBe(false)
  })

  it('切换会通知订阅者，并带上新值', () => {
    const seen: boolean[] = []
    onShellVisibilityChange((h) => seen.push(h))
    setShellHidden(true)
    setShellHidden(false)
    expect(seen).toEqual([true, false])
    expect(isShellHidden()).toBe(false)
  })

  it('**幂等**：同值重复设置不通知（否则恢复时会被多次"立刻刷一轮"打爆）', () => {
    const fn = vi.fn()
    onShellVisibilityChange(fn)
    setShellHidden(true)
    setShellHidden(true)
    setShellHidden(true)
    expect(fn).toHaveBeenCalledTimes(1)
    setShellHidden(false)
    setShellHidden(false)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('单个订阅者抛错不影响其它订阅者', () => {
    const ok = vi.fn()
    onShellVisibilityChange(() => { throw new Error('顶栏挂了') })
    onShellVisibilityChange(ok)
    expect(() => setShellHidden(true)).not.toThrow()
    expect(ok).toHaveBeenCalledWith(true)
  })

  it('注销后不再收到通知', () => {
    const fn = vi.fn()
    const off = onShellVisibilityChange(fn)
    off()
    setShellHidden(true)
    expect(fn).not.toHaveBeenCalled()
  })

  it('事件名与 Rust 侧约定的常量一致（改名字要两边一起改）', () => {
    expect(SHELL_HIDDEN_EVENT).toBe('shell:hidden')
    expect(SHELL_SHOWN_EVENT).toBe('shell:shown')
  })
})
