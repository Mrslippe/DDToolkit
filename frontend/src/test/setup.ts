/**
 * 全局单测环境补丁（`vitest.config.ts` 的 `setupFiles`）。
 *
 * ## 为什么需要它
 *
 * jsdom **没有实现媒体元素的那几个方法**：`play()` / `pause()` / `load()` 会打印
 * `Not implemented: HTMLMediaElement's play() method` 并返回 `undefined`。
 * 而 `VideoPlayer` 从 `devlog/295` 起会在地址就绪后**自动起播**（`autoPlay`）——
 * "渲染一个播放器"本身就会调 `play()`，于是所有相关用例都炸在
 * `Cannot read properties of undefined (reading 'catch')`（一个**与被测逻辑无关**的错）。
 *
 * ## 口径
 *
 * - 只补**返回值与状态**，**不派发事件**：`playing` 那类 React 状态仍由用例自己
 *   `dispatchEvent(new Event('play'))` 驱动（既有用例就是这么写的，保持它们可控）；
 * - 补一份可控的 `paused`：用例要能断言"自动起播**真的**发生了"（而不是只看 play 被调用），
 *   也方便断言"被自动播放策略拒绝时保持暂停"（把 `play` 换成 rejected 即可）；
 * - ⚠️ **别把这条补丁当成生产行为的证据**：真机上 `play()` 受自动播放策略约束，
 *   这里的实现永远成功。
 */
import { vi } from 'vitest'

// ⚠️ 这个 setup 对**所有**用例文件生效，而其中不少跑在默认的 node 环境里
// （没有 jsdom ⇒ 没有 `HTMLMediaElement`）。不做判断就会让那 49 个文件集体
// `ReferenceError: HTMLMediaElement is not defined`（真踩过）。
if (typeof HTMLMediaElement !== 'undefined') {
  const paused = new WeakMap<HTMLMediaElement, boolean>()

  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement): boolean {
      return paused.get(this) ?? true
    },
  })

  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    paused.set(this, false)
    return Promise.resolve()
  }

  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
    paused.set(this, true)
  }
}

/** 用例可用来断言"自动起播发生了"；`vi.spyOn` 也照常可用（spy 会在用例结束后还原）。 */
export const mediaSpies = {
  play: () => vi.spyOn(HTMLMediaElement.prototype, 'play'),
}
