import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

/**
 * 单测配置（2026-10-03 新增，此前只有 `vite.config.ts` 里的默认值）。
 *
 * 为什么需要一个 setup 文件：**jsdom 没有实现 `HTMLMediaElement.play()/pause()`**
 * （调用会打印 `Not implemented: HTMLMediaElement's play() method` 并返回 `undefined`）。
 * 自绘播放器从 `devlog/295` 起会在地址就绪后**自动起播**（`autoPlay`），
 * 于是"渲染一个播放器"这件事本身就会调用 `play()` —— 每个相关用例都会炸在
 * `Cannot read properties of undefined (reading 'catch')` 上。
 *
 * 取舍：**不为了测试去改生产代码**（不在 `VideoPlayer` 里写 `play()?.catch()` 这种防御），
 * 而是在这里补一份最小实现 —— 生产里 `play()` 一定有返回值，加防御只会把真问题藏起来。
 */
export default mergeConfig(viteConfig, defineConfig({
  test: {
    setupFiles: ['./src/test/setup.ts'],
  },
}))
