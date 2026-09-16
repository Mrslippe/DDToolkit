import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EXIT_MS } from '../hooks/useSceneTransition'
import { planSceneStep, type SceneStepArgs } from './sceneStep'

/** 只写关心的那几项，其余取「什么都没变、也没在退场」的默认值 */
const step = (over: Partial<SceneStepArgs> = {}) =>
  planSceneStep({
    accChanged: false, viewChanged: false, exiting: false, exitingIsForTarget: false,
    ready: false, exitMs: EXIT_MS, ...over,
  })

describe('planSceneStep：场景机的一步决策', () => {
  it('目标没变、也不在退场 ⇒ idle（别白重排定时器）', () => {
    expect(step()).toEqual({ kind: 'idle' })
    expect(step({ ready: true })).toEqual({ kind: 'idle' })
  })

  it('仅视图变化（无数据依赖）⇒ 退场后提交', () => {
    expect(step({ viewChanged: true })).toEqual({ kind: 'exit', waitMs: EXIT_MS })
  })

  it('账号变化：数据未就绪 ⇒ 等预取（提交空数据才是真的闪帧）', () => {
    expect(step({ accChanged: true })).toEqual({ kind: 'wait-prefetch' })
  })

  it('账号变化：数据已就绪 ⇒ 退场后提交', () => {
    expect(step({ accChanged: true, ready: true })).toEqual({ kind: 'exit', waitMs: EXIT_MS })
  })

  it('退场时长由 exitMs 透传（测试可注入小值）', () => {
    expect(step({ viewChanged: true, exitMs: 7 })).toEqual({ kind: 'exit', waitMs: 7 })
    expect(step({ accChanged: true, ready: true, exitMs: 7 })).toEqual({ kind: 'exit', waitMs: 7 })
  })

  it('退场是「为当前目标」播的 ⇒ 继续等它自己的定时器（不是连点，devlog/133 的坑）', () => {
    // 这正是 `setScene(exiting:true)` 之后 effect 自己再跑一遍时的状态：
    // 若在这里走 commit，退场会被整个跳过（第一版实测单次切换 210ms → 15ms）
    expect(step({ viewChanged: true, exiting: true, exitingIsForTarget: true }))
      .toEqual({ kind: 'exit', waitMs: EXIT_MS })
    expect(step({ accChanged: true, ready: true, exiting: true, exitingIsForTarget: true }))
      .toEqual({ kind: 'exit', waitMs: EXIT_MS })
    expect(step({ exiting: true, exitingIsForTarget: true }))
      .toEqual({ kind: 'exit', waitMs: EXIT_MS })
  })

  describe('连点：退场已经为别的目标播过就不再重播（R31，devlog/133）', () => {
    it('退场中再次切视图 ⇒ 立刻提交，不等第二轮', () => {
      expect(step({ viewChanged: true, exiting: true })).toEqual({ kind: 'commit' })
    })

    it('退场中换 V 且数据已就绪 ⇒ 立刻提交', () => {
      expect(step({ accChanged: true, ready: true, exiting: true })).toEqual({ kind: 'commit' })
    })

    it('退场中换 V 但数据未就绪 ⇒ 仍要等预取（不能提交空数据）', () => {
      expect(step({ accChanged: true, exiting: true })).toEqual({ kind: 'wait-prefetch' })
    })

    it('退场中又点回**原来那个** V（目标没变）⇒ 立刻落地，掐掉这轮退场', () => {
      expect(step({ exiting: true })).toEqual({ kind: 'commit' })
    })
  })
})

describe('布局契约：退场动画必须短于提交定时器', () => {
  const css = readFileSync(new URL('../styles/layout.css', import.meta.url), 'utf8')

  it('.scene-exit 的动画时长 < EXIT_MS，且留 ≥10ms 余量', () => {
    // 动画必须在类被摘掉之前结束（否则会闪回终态帧）——
    // 这条护栏挡的是「改了 EXIT_MS 忘了 CSS」（或反之）：两处都在，但没人把它们绑在一起。
    const m = /\.scene-exit\s*\{[^}]*?animation:\s*fall-out\s+([\d.]+)s/.exec(css)
    if (!m) throw new Error('layout.css 里找不到 .scene-exit 的 fall-out 动画时长（选择器改名了？）')
    const cssMs = Number(m[1]) * 1000
    expect(cssMs).toBeLessThan(EXIT_MS)
    expect(EXIT_MS - cssMs).toBeGreaterThanOrEqual(10)
  })
})
