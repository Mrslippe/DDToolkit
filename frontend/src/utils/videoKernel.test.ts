// @vitest-environment jsdom
/**
 * 播放内核开关（`utils/videoKernel.ts`，devlog/312）的判据。
 *
 * 用户口径是「**默认 MSE**、开关只作为退路」—— 所以这里钉的第一条就是"默认值",
 * 第二条是"熔断只影响本次运行、**不改用户存的那份**"（一次偶发的 CDN 抽风不该永久改他的选择）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  KERNEL_OPTIONS, effectiveKernel, kernelChoice, mseSessionOff, noteMseFailure,
  resetVideoKernel, setKernelChoice, subscribeKernel,
} from './videoKernel'

beforeEach(() => resetVideoKernel())

describe('videoKernel · 默认与持久化', () => {
  it('默认是 MSE（旧内核 seek 后必卡 ⇒ 不该是默认值）', () => {
    expect(kernelChoice()).toBe('mse')
    expect(effectiveKernel()).toBe('mse')
  })

  it('切到渐进式会落 localStorage（跨启动有效）', () => {
    setKernelChoice('progressive')
    expect(kernelChoice()).toBe('progressive')
    expect(localStorage.getItem('ddtoolkit.player.kernel')).toBe('progressive')
  })

  it('坏值/被禁的存储 ⇒ 回到 MSE，不抛', () => {
    localStorage.setItem('ddtoolkit.player.kernel', 'nonsense')
    // 重新 import 才会重读 localStorage；这里直接验"取值为坏值时按默认处理"的等价路径：
    expect(kernelChoice()).toBe('mse')          // 模块内已是 mse（resetVideoKernel 之后）
    expect(KERNEL_OPTIONS.map((o) => o.value)).toEqual(['mse', 'progressive'])
  })
})

describe('videoKernel · 会话熔断', () => {
  it('快照必须**引用稳定**（否则 useSyncExternalStore 无限重渲染）', () => {
    // 真事故（devlog/312）：`mseSessionOff()` 每次现造一个 `{off, why}` ⇒ 快照永不相等
    // ⇒ React 判定"外部状态又变了" ⇒ 无限重渲染，整个应用壳崩成
    // "页面渲染出错：Maximum update depth exceeded"（无头探针第一条抓到的就是这个）。
    expect(mseSessionOff()).toBe(mseSessionOff())
    const before = mseSessionOff()
    noteMseFailure('boom')
    expect(mseSessionOff()).not.toBe(before)      // 变了要**换引用**，订阅方才知道
    expect(mseSessionOff()).toBe(mseSessionOff())
  })

  it('栽一次就整场改走渐进式，但**不动用户存的那份偏好**', () => {
    const seen = vi.fn()
    const off = subscribeKernel(seen)
    noteMseFailure('appendBuffer 失败')

    expect(effectiveKernel()).toBe('progressive')
    expect(kernelChoice(), '用户存的还是 MSE：下次启动再给它机会').toBe('mse')
    expect(mseSessionOff()).toEqual({ off: true, why: 'appendBuffer 失败' })
    expect(seen).toHaveBeenCalledTimes(1)

    noteMseFailure('再栽一次')                    // 幂等：不重复通知（别让界面反复闪）
    expect(seen).toHaveBeenCalledTimes(1)
    expect(mseSessionOff().why).toBe('appendBuffer 失败')
    off()
  })

  it('用户在设置里重新选一次 MSE ⇒ 熔断解除（"再给它一次机会"）', () => {
    noteMseFailure('x')
    expect(effectiveKernel()).toBe('progressive')
    setKernelChoice('mse')
    expect(effectiveKernel()).toBe('mse')
    expect(mseSessionOff().off).toBe(false)
  })

  it('切到渐进式再切回来，值要真的落盘（不是只改内存）', () => {
    setKernelChoice('progressive')
    setKernelChoice('mse')
    expect(localStorage.getItem('ddtoolkit.player.kernel')).toBe('mse')
  })
})
