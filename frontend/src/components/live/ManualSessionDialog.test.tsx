// @vitest-environment jsdom
/**
 * 手动记录/编辑弹窗的行为判据（B2，devlog/454）。
 *
 * 钉住六件事（都是"用户会踩、而服务端拦不住"的）：
 * ① 新建默认今天 20:00–22:00，且**空字段不发**（`undefined` ≠ `null`：服务端把 null 当"清空"）；
 * ② 时间**原样**提交（不是 `toISOString()` —— 那会按浏览器时区折一次，服务端再折一次）；
 * ③ 编辑只提交**改过**的字段（改标题不会顺手清掉结束时间）；没改动时保存不可点；
 * ④ 自动抓来的场次：时间/标题不可改且有说明，录播可改，**没有删除按钮**；
 * ⑤ 409/422 的中文原因**显示在表单里**（不许吞成"保存失败"）；
 * ⑥ 删除要两步确认（没有 `window.confirm`：它在 WebView 里被壳挡住时是静默失败）。
 *
 * 组件用例的写法沿用 `LiveSessionDialog.test.tsx`（jsdom + `react-dom/client` + `act`，零新依赖）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveSession, LiveSessionDetail } from '../../api/types'

vi.mock('../../api/api', () => ({
  api: {
    createManualLiveSession: vi.fn(),
    updateLiveSession: vi.fn(),
    deleteLiveSession: vi.fn(),
  },
}))

import { api } from '../../api/api'
import ManualSessionDialog from './ManualSessionDialog'

const createMock = vi.mocked(api.createManualLiveSession)
const updateMock = vi.mocked(api.updateLiveSession)
const deleteMock = vi.mocked(api.deleteLiveSession)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => false,
}))
Element.prototype.scrollTo = () => {}
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const iso = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).toISOString()

const MANUAL = {
  account_id: 1, live_id: 'manual-abc', live_title: '歌回',
  start_at: iso(2026, 10, 8, 20, 0), end_at: iso(2026, 10, 8, 22, 0),
  duration_minutes: 120, source: 'manual', manual: true,
  vod_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
} as unknown as LiveSession

const AUTO = {
  ...MANUAL, live_id: 'uuid-a', source: 'danmakus', manual: false,
  vod_url: null, live_title: '深夜杂谈',
} as unknown as LiveSession

const SAVED = { ...MANUAL, analysis: null } as unknown as LiveSessionDetail

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onSaved = vi.fn()
const onDeleted = vi.fn()

function render(session: LiveSession | null) {
  act(() => {
    root.render(
      <ManualSessionDialog open accountId={1} session={session}
                           onClose={onClose} onSaved={onSaved} onDeleted={onDeleted} />,
    )
  })
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement
const saveBtn = () => document.querySelector<HTMLButtonElement>('.lc-ms-btn.primary')!
const delBtn = () => document.querySelector<HTMLButtonElement>('.lc-ms-btn.danger')
const errorText = () => document.querySelector('.lc-ms-error')?.textContent ?? ''

/** 受控输入：必须走原生 setter + input 事件，React 才认这次改动 */
function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: HTMLButtonElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

beforeEach(() => {
  createMock.mockReset().mockResolvedValue(SAVED)
  updateMock.mockReset().mockResolvedValue(SAVED)
  deleteMock.mockReset().mockResolvedValue({ deleted: true, live_id: 'manual-abc' })
  onClose.mockReset(); onSaved.mockReset(); onDeleted.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('新建', () => {
  it('① 默认今天 20:00–22:00；只填开始时间就能存，空标题/空录播**不发**', async () => {
    render(null)
    expect(input('lc-ms-start').value).toBe(`${new Date().toISOString().slice(0, 10)}T20:00`)
    expect(input('lc-ms-end').value.endsWith('T22:00')).toBe(true)

    await click(saveBtn())
    expect(createMock).toHaveBeenCalledTimes(1)
    const [aid, body] = createMock.mock.calls[0]
    expect(aid).toBe(1)
    expect(body).toEqual({
      start_at: input('lc-ms-start').value, end_at: input('lc-ms-end').value,
    })
    expect('title' in body).toBe(false)
    expect('vod_url' in body).toBe(false)
    expect(onSaved).toHaveBeenCalledWith(SAVED)
  })

  it('② 时间原样提交（不做 toISOString 折算）；标题/录播去空白后带上', async () => {
    render(null)
    type(input('lc-ms-start'), '2026-10-08T19:30')
    type(input('lc-ms-end'), '2026-10-08T21:30')
    type(input('lc-ms-title'), ' 深夜歌回 ')
    type(input('lc-ms-vod'), ' BV1xx411c7mD ')

    await click(saveBtn())
    expect(createMock.mock.calls[0][1]).toEqual({
      start_at: '2026-10-08T19:30', end_at: '2026-10-08T21:30',
      title: '深夜歌回', vod_url: 'BV1xx411c7mD',
    })
  })

  it('清空开始时间 → 保存不可点（服务端要的就是这个字段）', () => {
    render(null)
    type(input('lc-ms-start'), '')
    expect(saveBtn().disabled).toBe(true)
  })
})

describe('编辑', () => {
  it('③ 预填服务端那份数据；只提交改过的字段；没改动时不可点', async () => {
    render(MANUAL)
    expect(input('lc-ms-title').value).toBe('歌回')
    expect(input('lc-ms-vod').value).toBe(MANUAL.vod_url)
    expect(saveBtn().disabled).toBe(true)                 // 什么都没改

    type(input('lc-ms-title'), '深夜歌回')
    expect(saveBtn().disabled).toBe(false)
    await click(saveBtn())
    expect(updateMock).toHaveBeenCalledWith(1, 'manual-abc', { title: '深夜歌回' })
  })

  it('清空结束时间 → end_at: null（"改回进行中"，与"没传"不是一回事）', async () => {
    render(MANUAL)
    type(input('lc-ms-end'), '')
    await click(saveBtn())
    expect(updateMock.mock.calls[0][2]).toEqual({ end_at: null })
  })

  it('④ 自动抓来的场次：时间/标题不可改 + 说明；录播可改；没有删除按钮', async () => {
    render(AUTO)
    expect(input('lc-ms-start').disabled).toBe(true)
    expect(input('lc-ms-end').disabled).toBe(true)
    expect(input('lc-ms-title').disabled).toBe(true)
    expect(input('lc-ms-vod').disabled).toBe(false)
    expect(document.querySelector('.lc-ms-note')?.textContent).toContain('只能补录播地址')
    expect(delBtn()).toBeNull()

    type(input('lc-ms-vod'), 'BV1xx411c7mD')
    await click(saveBtn())
    expect(updateMock).toHaveBeenCalledWith(1, 'uuid-a', { vod_url: 'BV1xx411c7mD' })
  })

  it('⑤ 冲突（409）的中文原因显示在表单里，不当成"保存失败"吞掉', async () => {
    updateMock.mockRejectedValue(
      new Error('这段时间已有场次：深夜杂谈 10-08 20:00–22:00（来源 danmakus，live_id=uuid-a）'))
    render(MANUAL)
    type(input('lc-ms-title'), '换个名字')
    await click(saveBtn())
    expect(errorText()).toContain('这段时间已有场次：深夜杂谈')
    expect(errorText()).toContain('live_id=uuid-a')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('⑥ 删除要两步确认，确认后回调把这一场从界面上摘掉', async () => {
    render(MANUAL)
    await click(delBtn()!)                                  // 第一步：只是展开确认
    expect(deleteMock).not.toHaveBeenCalled()
    await click(document.querySelector<HTMLButtonElement>('.lc-ms-btn.danger')!)
    expect(deleteMock).toHaveBeenCalledWith(1, 'manual-abc')
    expect(onDeleted).toHaveBeenCalledWith('manual-abc')
  })
})

describe('⑦ 退场动画的前提（与详情弹窗同一条纪律）', () => {
  it('真 CSS 里声明了 `.lc-ms` 的退场动画 —— 没有它 Radix 会当场卸载（"一闪就没了"）', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/posts.css'), 'utf8')
    expect(
      /\.lc-ms\[data-state='closed'\]\s*\{[^}]*animation:/.test(css),
      '缺这条 ⇒ Radix 的 Presence 找不到 animationend ⇒ 关闭瞬间卸载',
    ).toBe(true)
  })
})
