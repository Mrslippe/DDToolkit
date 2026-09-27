// @vitest-environment jsdom
/**
 * 选定账号身份机的**行为**判据（M4，批次 12 第四刀，devlog/222）。
 *
 * 三条最值得钉住的（每条都对应一次真实事故或一次白跑）：
 * 1. **同 uid 要换新对象**（抓取回填后头部才拿得到新快照）；
 * 2. **增量快照未命中时引用必须不变**（`Object.is`）—— 否则每次广播都让依赖
 *    `accountKey` 的 effect 白跑一轮；
 * 3. **两套认人口径的差异是契约**（E7 按 `platform_uid` 且没选过就选第一个；
 *    设置保存按 `id` 且没选过就不选）—— 把它们"统一"掉这条会红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Account, AccountSnapshot } from '../api/types'
import { useSelectedAccount } from './useSelectedAccount'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let api!: ReturnType<typeof useSelectedAccount>
/** 上一次渲染时 `selectedAccount` 的引用（判"引用变没变"用） */
let lastRef: Account | null = null

function Harness() {
  api = useSelectedAccount()
  lastRef = api.selectedAccount
  return (
    <div
      id="probe"
      data-key={api.accountKey ?? ''}
      data-uid={api.selectedAccount?.platform_uid ?? ''}
      data-name={api.selectedAccount?.display_name ?? ''}
      data-null={api.selectedAccount === null ? '1' : '0'}
    />
  )
}

const render = () => act(() => { root.render(<Harness />) })
const attr = (name: string) => document.getElementById('probe')!.getAttribute(`data-${name}`)

const acc = (over: Partial<Account> = {}): Account => ({
  id: 1, vtuber_id: 15, platform: 'bilibili', platform_uid: '100',
  display_name: 'A', ...over,
} as Account)

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  lastRef = null
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('① accountKey 是稳定代理', () => {
  it('初始没有账号 ⇒ key 为 null', () => {
    render()
    expect(attr('null')).toBe('1')
    expect(attr('key')).toBe('')
  })

  it('选中账号 ⇒ key = `platform:platform_uid`', () => {
    render()
    act(() => { api.setSelectedAccount(acc({ platform: 'weibo', platform_uid: 'abc' })) })
    expect(attr('key')).toBe('weibo:abc')
  })
})

describe('② reconcileByUid（E7 抓取回填）', () => {
  it('同 uid 换**新对象**（头部要拿新快照）—— 命中项**排在第二位**才算数', () => {
    render()
    act(() => { api.setSelectedAccount(acc({ display_name: '旧名', platform_uid: '100' })) })
    const before = lastRef
    act(() => {
      api.reconcileByUid([
        acc({ id: 2, platform_uid: '200', display_name: '别人' }),
        acc({ display_name: '新名', platform_uid: '100' }),
      ])
    })
    // ⚠️ 命中项**必须不在首位**：否则"永远取第一个"的实现也能通过，这条判据就是空转
    //    （反向验证时真踩到了）
    expect(attr('uid'), '要按 uid 认人，不是永远取第一个').toBe('100')
    expect(attr('name')).toBe('新名')
    expect(lastRef, '必须换新对象 —— 保留旧引用 = 头部永远背着抓取前的空快照').not.toBe(before)
  })

  it('uid 不在列表里 ⇒ 退回第一个', () => {
    render()
    act(() => { api.setSelectedAccount(acc({ platform_uid: '999' })) })
    act(() => { api.reconcileByUid([acc({ platform_uid: '100' }), acc({ id: 2, platform_uid: '200' })]) })
    expect(attr('uid')).toBe('100')
  })

  it('没选过 ⇒ 选第一个（首开必须有账号可看）', () => {
    render()
    act(() => { api.reconcileByUid([acc({ platform_uid: '100' }), acc({ id: 2, platform_uid: '200' })]) })
    expect(attr('uid')).toBe('100')
  })

  it('空列表 ⇒ 不动（防御；调用方另有「没有可用账号」分支）', () => {
    render()
    act(() => { api.setSelectedAccount(acc({ platform_uid: '100' })) })
    act(() => { api.reconcileByUid([]) })
    expect(attr('uid'), '空列表不许把选定账号写成 undefined').toBe('100')
  })
})

describe('③ reconcileById（设置保存）—— 与上一条**刻意不同**', () => {
  it('同 id 换新对象（命中项也**不在首位**）；id 不在 ⇒ 第一个', () => {
    render()
    act(() => { api.setSelectedAccount(acc({ id: 7, display_name: '旧名', platform_uid: '100' })) })
    act(() => {
      api.reconcileById([
        acc({ id: 9, platform_uid: '900', display_name: '别人' }),
        acc({ id: 7, display_name: '新名', platform_uid: '100' }),
      ])
    })
    expect(attr('uid'), '要按 id 认人，不是永远取第一个').toBe('100')
    expect(attr('name')).toBe('新名')
    act(() => { api.reconcileById([acc({ id: 9, platform_uid: '900' })]) })
    expect(attr('uid')).toBe('900')
  })

  it('**没选过 ⇒ 保持不选**（把两条口径"统一"掉这条会红）', () => {
    render()
    act(() => { api.reconcileById([acc({ platform_uid: '100' })]) })
    expect(attr('null'), '历史口径：prev 为空就原样返回').toBe('1')
  })
})

describe('④ applySnapshots（account-progress 增量）', () => {
  it('命中 ⇒ 合并出新对象', () => {
    render()
    act(() => { api.setSelectedAccount(acc({ display_name: '旧名', platform_uid: '100' })) })
    const snap = { platform_uid: '100', display_name: '新名' } as AccountSnapshot
    act(() => { api.applySnapshots([snap]) })
    expect(attr('name')).toBe('新名')
  })

  it('**未命中 ⇒ 引用不变**（否则依赖 accountKey 的 effect 每广播一轮就白跑）', () => {
    render()
    act(() => { api.setSelectedAccount(acc({ platform_uid: '100' })) })
    const before = lastRef
    act(() => { api.applySnapshots([{ platform_uid: '999' } as AccountSnapshot]) })
    expect(lastRef, '未命中的增量不许换引用').toBe(before)
    expect(attr('uid')).toBe('100')
  })

  it('没选中账号 ⇒ 保持 null（没有可合并的对象）', () => {
    render()
    act(() => { api.applySnapshots([{ platform_uid: '100' } as AccountSnapshot]) })
    expect(attr('null')).toBe('1')
  })
})
