// @vitest-environment jsdom
/**
 * 左栏收起/展开的偏好（需求 6 视觉版，`devlog/431`）。
 *
 * ① 只认 `'1'`（其余值 —— 包括手工改坏的 —— 一律当"展开"）；
 * ② 跨启动记得（界面偏好，与 `vtuberSort` 同套路）；
 * ③ 同值不重复通知（否则订阅方会白重渲染）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  parseRailCollapsed, railCollapsed, RAIL_COLLAPSED_KEY, serializeRailCollapsed,
  setRailCollapsed, subscribeRailCollapsed, toggleRailCollapsed,
} from './railCollapsed'

beforeEach(() => {
  localStorage.clear()
  setRailCollapsed(false)
})

describe('左栏收起偏好', () => {
  it('读原文：只认 `1`，坏值一律当"展开"', () => {
    expect(parseRailCollapsed('1')).toBe(true)
    for (const bad of [null, undefined, '', '0', 'true', 'yes', '2', '{}']) {
      expect(parseRailCollapsed(bad), `坏值：${bad}`).toBe(false)
    }
    expect(serializeRailCollapsed(true)).toBe('1')
  })

  it('★ 跨启动记得：写进 localStorage，且退出单推**不会**动它（那是另一个量）', () => {
    setRailCollapsed(true)
    expect(railCollapsed()).toBe(true)
    expect(parseRailCollapsed(localStorage.getItem(RAIL_COLLAPSED_KEY))).toBe(true)
    toggleRailCollapsed()
    expect(railCollapsed()).toBe(false)
    expect(parseRailCollapsed(localStorage.getItem(RAIL_COLLAPSED_KEY))).toBe(false)
  })

  it('同值不重复通知；退订之后不再收到', () => {
    const seen = vi.fn()
    const off = subscribeRailCollapsed(seen)
    setRailCollapsed(true)
    expect(seen).toHaveBeenCalledTimes(1)
    setRailCollapsed(true)
    expect(seen, '本来就是收起 ⇒ 不必再通知').toHaveBeenCalledTimes(1)
    off()
    setRailCollapsed(false)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
