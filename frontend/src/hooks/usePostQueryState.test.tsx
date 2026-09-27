// @vitest-environment jsdom
/**
 * 列表页筛选状态的**行为**判据（M4，批次 12 第二刀，devlog/219）。
 *
 * 这台机器里有一条**时序契约**（E9）值得单独钉住：换账号/换 V 时七个字段必须重置，
 * 而且这条 effect **要先于场景提交跑完** —— 否则提交时 `filterRef` 还是旧筛选，
 * 与"恒按默认筛选预取"的种子指纹错配 ⇒ **种子被误消费**（列表先错一帧再被重取纠正，
 * 界面上只闪一下，极难归因）。
 *
 * 依赖数组 `[sceneAcc, accountKey]` 就是这个时序的实现方式，所以下面既测"重置了没有"，
 * 也测"**什么时候**重置"（同批 render 后、下一个 render 之前）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePostQueryState } from './usePostQueryState'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let api!: ReturnType<typeof usePostQueryState>
/** 每次渲染后递增：用来断言"重置发生在同一批 render 之后" */
let renders = 0

function Harness({ sceneAcc, accountKey }: { sceneAcc: number; accountKey: string | null }) {
  api = usePostQueryState({ sceneAcc, accountKey })
  renders += 1
  return (
    <div
      id="probe"
      data-type={api.typeFilter ?? ''}
      data-archived={api.archived}
      data-deleted={api.deletedOnly ? '1' : '0'}
      data-input={api.searchInput}
      data-kw={api.searchKw}
      data-from={api.dateFrom}
      data-to={api.dateTo}
    />
  )
}

const el = () => document.getElementById('probe')!
const attr = (name: string) => el().getAttribute(`data-${name}`)
const render = (sceneAcc: number, accountKey: string | null) =>
  act(() => { root.render(<Harness sceneAcc={sceneAcc} accountKey={accountKey} />) })

/** 把七个字段都改成"非默认"，方便观察重置 */
function dirty() {
  act(() => {
    api.setTypeFilter('video')
    api.setArchived('archived')
    api.setDeletedOnly(true)
    api.setSearchInput('奶绿')
    api.setDateFrom('2026-09-01')
    api.setDateTo('2026-09-30')
  })
  act(() => { vi.advanceTimersByTime(300) })     // 让防抖把 searchKw 落下去
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  renders = 0
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('① 换账号 / 换 V ⇒ 七个字段全部重置（含 archived 那条历史漏网）', () => {
  it('accountKey 变化即重置', () => {
    render(1, 'bilibili:100')
    dirty()
    expect(attr('archived')).toBe('archived')
    expect(attr('kw')).toBe('奶绿')

    render(1, 'bilibili:200')                    // 同 V 换账号
    expect(attr('type')).toBe('')
    expect(attr('archived'), 'P8-A 曾漏掉 archived ⇒ 种子指纹错配').toBe('all')
    expect(attr('deleted')).toBe('0')
    expect(attr('input')).toBe('')
    expect(attr('kw')).toBe('')
    expect(attr('from')).toBe('')
    expect(attr('to')).toBe('')
  })

  it('sceneAcc 变化即重置（切 V）', () => {
    render(1, 'bilibili:100')
    dirty()
    render(2, null)                              // 新 V 还没选中账号
    expect(attr('type')).toBe('')
    expect(attr('archived')).toBe('all')
    expect(attr('kw')).toBe('')
  })

  it('**只有** sceneAcc / accountKey 变才重置（refreshTick 之类的无关变化不许清筛选）', () => {
    render(1, 'bilibili:100')
    dirty()
    render(1, 'bilibili:100')                    // 同参数重渲染（真实场景：refreshTick 边沿）
    expect(attr('type')).toBe('video')
    expect(attr('archived')).toBe('archived')
    expect(attr('kw')).toBe('奶绿')
  })
})

describe('② 时序：重置在**同一批 render 之后**跑完（先于场景提交）', () => {
  it('切账号那一次 render 的下一拍，字段已经是重置态', () => {
    render(1, 'bilibili:100')
    dirty()
    const before = renders

    render(1, 'bilibili:200')                    // 这一批 render 后 effect 应当已跑过
    expect(renders).toBeGreaterThan(before)      // 确实又渲染了（reset 触发的那次）
    expect(attr('archived'), '提交时若还是旧筛选 ⇒ 预取种子指纹错配').toBe('all')
  })
})

describe('③ 搜索防抖：300ms 后才落到生效关键词', () => {
  it('输入后立刻读 kw 还是旧的，300ms 后才变', () => {
    render(1, 'bilibili:100')
    act(() => { api.setSearchInput('奶') })
    expect(attr('kw')).toBe('')
    act(() => { vi.advanceTimersByTime(299) })
    expect(attr('kw')).toBe('')
    act(() => { vi.advanceTimersByTime(1) })
    expect(attr('kw')).toBe('奶')                // 生效值也 trim 过
  })

  it('连续输入只落最后一次（防抖而不是每次都发）', () => {
    render(1, 'bilibili:100')
    act(() => { api.setSearchInput('奶') })
    act(() => { vi.advanceTimersByTime(150) })
    act(() => { api.setSearchInput('奶绿') })
    act(() => { vi.advanceTimersByTime(150) })
    expect(attr('kw'), '这时距第一次输入已 300ms，但第二次输入重新计时').toBe('')
    act(() => { vi.advanceTimersByTime(150) })
    expect(attr('kw')).toBe('奶绿')
  })
})

describe('④ 弹窗里的「重置」只清弹窗内三件字段', () => {
  it('resetFilters 清掉归档 / 已删 / 日期，保留类型与关键词', () => {
    render(1, 'bilibili:100')
    dirty()
    act(() => { api.resetFilters() })

    expect(attr('archived')).toBe('all')
    expect(attr('deleted')).toBe('0')
    expect(attr('from')).toBe('')
    expect(attr('to')).toBe('')
    expect(attr('type'), '类型 chip 不在弹窗里，不该被它清掉').toBe('video')
    expect(attr('kw')).toBe('奶绿')
  })
})
