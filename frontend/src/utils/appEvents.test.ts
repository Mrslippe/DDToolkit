// @vitest-environment jsdom
/**
 * 事件表的判据（M4，批次 12 第五刀，devlog/223）。
 *
 * 最重要的那条是**名字清单**：事件名是跨组件契约，`scripts/ui_probe.py` 与 dev 探针
 * 仍按**裸字符串**派发/监听（它们是外部消费者）—— 名字被改掉时，产品代码这边会因为
 * 集中表而在编译期报错，但探针那边只会**静默失效**（正是 R33 那类事故的形态）。
 * ⇒ 这里把线上名字逐条钉死，改名必须同时改用例 + 探针。
 */
import { describe, expect, it, vi } from 'vitest'

import { APP_EVENT_NAMES, EVENTS, emit, on } from './appEvents'
import { FETCH_IDLE_EVENT } from './fetchIdle'
import { VTUBER_UPDATED_EVENT } from './vtuberList'

describe('① 事件名是契约：逐个钉住（改名会让探针静默失效）', () => {
  it('名单与 `EVENTS` 表完全一致，且就是这 8 个', () => {
    expect([...APP_EVENT_NAMES].sort()).toEqual([...Object.values(EVENTS)].sort())
    expect([...APP_EVENT_NAMES].sort()).toEqual([
      'ddtoolkit:account-progress',
      'ddtoolkit:capabilities-refresh',
      'ddtoolkit:data-changed',
      'ddtoolkit:fetch-idle',
      'ddtoolkit:kick-poll',
      'ddtoolkit:pill-message',
      'ddtoolkit:vtuber-updated',
      'ddtoolkit:widget-seed',
    ])
  })

  it('老常量（`FETCH_IDLE_EVENT` / `VTUBER_UPDATED_EVENT`）就是表里的同一个字面量', () => {
    expect(FETCH_IDLE_EVENT).toBe(EVENTS.fetchIdle)
    expect(VTUBER_UPDATED_EVENT).toBe(EVENTS.vtuberUpdated)
  })
})

describe('② emit / on 往返', () => {
  it('带 payload：监听方拿到同一个对象', () => {
    const seen: Array<{ text: string }> = []
    const off = on(EVENTS.pillMessage, (d) => seen.push(d))
    emit(EVENTS.pillMessage, { text: '抓取完成' })
    expect(seen).toEqual([{ text: '抓取完成' }])
    off()
  })

  it('不带 payload 的事件也能派发/监听（老的裸 `Event` 监听方读 `.detail` 得到 undefined）', () => {
    const cb = vi.fn()
    const off = on(EVENTS.kickPoll, cb)
    emit(EVENTS.kickPoll)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0], '无 detail 的事件 detail 必须是 undefined').toBeUndefined()
    off()
  })

  it('退订之后不再收到（`on` 返回的就是退订函数）', () => {
    const cb = vi.fn()
    const off = on(EVENTS.dataChanged, cb)
    emit(EVENTS.dataChanged)
    off()
    emit(EVENTS.dataChanged)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('裸字符串写法照旧可用（不换机制，只集中名字与类型）', () => {
    const cb = vi.fn()
    window.addEventListener('ddtoolkit:data-changed', cb)
    emit(EVENTS.dataChanged)
    window.removeEventListener('ddtoolkit:data-changed', cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('可以指定宿主（`fetchIdle` 的单测就是这么在 node 环境里跑的）', () => {
    const host = new EventTarget()
    const cb = vi.fn()
    const off = on(EVENTS.capabilitiesRefresh, cb, host)
    emit(EVENTS.capabilitiesRefresh, undefined, host)
    expect(cb, '发到注入的宿主上').toHaveBeenCalledTimes(1)
    off()
  })
})
