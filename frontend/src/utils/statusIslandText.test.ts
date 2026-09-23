/**
 * 文案切换状态机的用例（`utils/statusIslandText.ts`，R38 批 4）。
 *
 * 抽纯函数的理由见模块头注释 —— 这里只测**可打断**这条核心性质：
 * 撤的途中再来新文案**不许重排、不许重启定时器**，撤完要换上**当时最新**的那一版。
 */
import { describe, expect, it } from 'vitest'

import { TEXT_EXIT_MS, initialTextState, phaseClass, reduceText } from './statusIslandText'

describe('文案切换：基本推进', () => {
  it('文案没变 ⇒ 停在 idle 且不排定时器（不空跑）', () => {
    const s = initialTextState('数据服务运行中')
    const r = reduceText(s, '数据服务运行中', false)
    expect(r.state).toEqual(s)
    expect(r.scheduleMs).toBeNull()
  })

  it('文案变了 ⇒ 进入 out（旧文案开始撤）并排期撤的时长', () => {
    const r = reduceText(initialTextState('旧'), '新', false)
    expect(r.state).toEqual({ shown: '旧', phase: 'out' }) // 屏幕上**仍是旧文案**
    expect(r.scheduleMs).toBe(TEXT_EXIT_MS)
  })

  it('out 到点 ⇒ 换字 + 回到 idle（淡入就是撤掉 .is-out 这次过渡本身）', () => {
    const out = reduceText(initialTextState('旧'), '新', false)
    const r = reduceText(out.state, '新', true)
    expect(r.state).toEqual({ shown: '新', phase: 'idle' })
    expect(r.scheduleMs).toBeNull()
  })

  it('回到 idle 之后文案没再变 ⇒ 不重排（不会来回抖）', () => {
    const out = reduceText(initialTextState('旧'), '新', false)
    const done = reduceText(out.state, '新', true)
    const again = reduceText(done.state, '新', false)
    expect(again.state).toEqual({ shown: '新', phase: 'idle' })
    expect(again.scheduleMs).toBeNull()
  })
})

describe('文案切换：可打断（本模块存在的理由）', () => {
  it('**out 途中再来新文案 ⇒ 继续撤，不重排、不重启定时器**', () => {
    const out = reduceText(initialTextState('旧'), '新 A', false)
    expect(out.state.phase).toBe('out')
    // 撤到一半，又来一条更新的
    const again = reduceText(out.state, '新 B', false)
    expect(again.state).toEqual(out.state) // 状态**完全没变**（连 shown 都还是旧的）
    expect(again.scheduleMs).toBeNull() // ⚠️ 不排新定时器 ⇒ 原来那个继续跑
  })

  it('撤完换上的是**当时最新**的那一版，不是当初那一版', () => {
    const out = reduceText(initialTextState('旧'), '新 A', false)
    const again = reduceText(out.state, '新 B', false) // 打断
    const done = reduceText(again.state, '新 B', true) // 原来那个定时器到点
    expect(done.state).toEqual({ shown: '新 B', phase: 'idle' })
  })

  it('连打三次也只走一遍撤', () => {
    let s = initialTextState('旧')
    s = reduceText(s, 'A', false).state
    const a = reduceText(s, 'B', false)
    const b = reduceText(a.state, 'C', false)
    expect(a.scheduleMs).toBeNull()
    expect(b.scheduleMs).toBeNull()
    expect(b.state).toEqual({ shown: '旧', phase: 'out' })
  })

  it('稳定后（idle）再变 ⇒ 重新起一次撤', () => {
    const done = reduceText(reduceText(initialTextState('旧'), 'A', false).state, 'A', true)
    const r = reduceText(done.state, 'B', false)
    expect(r.state).toEqual({ shown: 'A', phase: 'out' })
    expect(r.scheduleMs).toBe(TEXT_EXIT_MS)
  })
})

describe('阶段类名', () => {
  it('idle 不加类；out 给一个', () => {
    expect(phaseClass('idle')).toBe('')
    expect(phaseClass('out')).toBe(' is-out')
  })
})
