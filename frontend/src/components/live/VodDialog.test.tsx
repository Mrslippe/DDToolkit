// @vitest-environment jsdom
/**
 * 「添加录播」小窗的行为判据（2026-10-13，用户 3.2：封面上的 ＋ 打开它）。
 *
 * 这个窗把原先散在**场次详情右列那一行**里的三件事收拢到一处（用户 3.1 点名那一行
 * 「可以不需要」）：填地址 / 找录播 / 记住录播号。所以判据也就盯这三条线，外加两条
 * "踩过就会静默写错数据"的：
 *
 * | 判据 | 坏了会怎样 |
 * |---|---|
 * | 填 BV → `updateLiveSession(id, live_id, { vod_url })` | 录播存不上，而界面看着像存上了 |
 * | 没改动时保存不可点 | 白跑一趟 PATCH（服务端同值也回 200，但日历会白刷） |
 * | 候选「用它」→ 直接写那条 permalink | 点了没反应 |
 * | ★ 候选**连同场次记账**：换一场后旧候选必须消失 | 把**上一场的录播**写进这一场（C1 踩过的静默错数据） |
 * | 失败原文照显 | 静默失败 = 用户以为存上了 |
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveSession, VodCandidatesResult } from '../../api/types'

vi.mock('../../api/api', () => ({
  api: { updateLiveSession: vi.fn(), vodCandidates: vi.fn() },
}))

import { api } from '../../api/api'
import VodDialog from './VodDialog'

const saveMock = vi.mocked(api.updateLiveSession)
const candMock = vi.mocked(api.vodCandidates)

const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnv.IS_REACT_ACT_ENVIRONMENT = true

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

const SESSION = {
  live_id: 'sess-1', live_title: '歌回', start_at: '2026-10-08T20:00:00Z',
  vod_url: null, source: 'danmakus', manual: false,
} as unknown as LiveSession

const WITH_VOD = { ...SESSION, vod_url: 'https://www.bilibili.com/video/BV1xx411c7mD' } as unknown as LiveSession
const OTHER = { ...SESSION, live_id: 'sess-2', vod_url: null } as unknown as LiveSession

const CAND: VodCandidatesResult = {
  mids: ['123'], window: '2026-10-08 ~ 10-09', hint: '',
  items: [
    { bvid: 'BV1aa411c7mD', permalink: 'https://www.bilibili.com/video/BV1aa411c7mD',
      title: '【录播】歌回', published_at: '2026-10-09T01:20:00Z', duration_minutes: 128,
      reasons: ['开播后 1 小时内发布'], cautions: [],
      mid: '123', cover_url: '', score: 3, title_hits: [], in_window: true },
    { bvid: 'BV1bb411c7mD', permalink: 'https://www.bilibili.com/video/BV1bb411c7mD',
      title: '可能是剪辑', published_at: null, duration_minutes: 12,
      reasons: [], cautions: ['时长明显偏短'],
      mid: '123', cover_url: '', score: 1, title_hits: [], in_window: false },
  ],
}

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onSaved = vi.fn()
const onSaveVodAccount = vi.fn()

function render(session: LiveSession | null, uid: string | null = null) {
  act(() => {
    root.render(
      <VodDialog open accountId={1} session={session} vodAccountUid={uid}
                 onClose={onClose} onSaved={onSaved} onSaveVodAccount={onSaveVodAccount} />,
    )
  })
}

const urlInput = () => document.getElementById('vod-url') as HTMLInputElement
const saveBtn = () => document.querySelector<HTMLButtonElement>('[data-vod-save]')!
const findBtn = () => document.querySelector<HTMLButtonElement>('[data-find-vod]')!
const errorText = () => document.querySelector('[data-vod-error]')?.textContent ?? ''
const candidates = () => document.querySelectorAll('[data-vod-bvid]').length

function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue({ ...SESSION, vod_url: 'https://www.bilibili.com/video/BV1zz411c7mD' })
  candMock.mockReset().mockResolvedValue(CAND)
  onClose.mockReset(); onSaved.mockReset(); onSaveVodAccount.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('「添加录播」小窗', () => {
  it('① 初值 = 这一场已有的地址；没改动时保存不可点（别白跑一趟 PATCH）', () => {
    render(WITH_VOD)
    expect(urlInput().value).toBe(WITH_VOD.vod_url)
    expect(saveBtn().disabled).toBe(true)
    type(urlInput(), 'BV1xx411c7mD')
    expect(saveBtn().disabled).toBe(false)
    // 又改回去 → 重新不可点
    type(urlInput(), WITH_VOD.vod_url!)
    expect(saveBtn().disabled).toBe(true)
  })

  it('② 填 BV → PATCH 这一场（写路径与"手动填"是同一条）', async () => {
    render(SESSION)
    type(urlInput(), ' BV1zz411c7mD ')
    await click(saveBtn())
    expect(saveMock).toHaveBeenCalledWith(1, 'sess-1', { vod_url: 'BV1zz411c7mD' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('③ 没有目标场次（或没有账号）→ 保存不可点', () => {
    render(null)
    type(urlInput(), 'BV1zz411c7mD')
    expect(saveBtn().disabled).toBe(true)
  })

  it('④ 失败原因**原文**显示在窗里（不许吞成"保存失败"）', async () => {
    saveMock.mockRejectedValue(new Error('录播地址不在白名单主机里：evil.com'))
    render(SESSION)
    type(urlInput(), 'https://evil.com/v/1')
    await click(saveBtn())
    expect(errorText()).toContain('录播地址不在白名单主机里')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('⑤ 找录播 → 候选行出来（标题/时间/时长/依据/提醒都在）', async () => {
    render(SESSION)
    await click(findBtn())
    expect(candMock).toHaveBeenCalledWith(1, 'sess-1')
    expect(candidates()).toBe(2)
    const wrap = document.querySelector('[data-vod-candidates]')!.textContent!
    expect(wrap).toContain('扫了 1 个号：123')
    expect(wrap).toContain('【录播】歌回')
    expect(wrap).toContain('开播后 1 小时内发布')
    expect(wrap).toContain('时长明显偏短')
  })

  it('⑥ 点「用它」→ 直接写那条候选的地址（不用先复制再粘）', async () => {
    render(SESSION)
    await click(findBtn())
    await click(document.querySelector<HTMLButtonElement>('[data-vod-use="BV1bb411c7mD"]')!)
    expect(saveMock).toHaveBeenCalledWith(1, 'sess-1',
      { vod_url: 'https://www.bilibili.com/video/BV1bb411c7mD' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('⑦ 找录播失败也要**看得见**（"点了没反应"比一句失败更糟）', async () => {
    candMock.mockRejectedValue(new Error('上游 412'))
    render(SESSION)
    await click(findBtn())
    expect(document.querySelector('[data-vod-candidates]')!.textContent).toContain('上游 412')
  })

  it('★ 换一场之后**旧候选必须消失**（否则「用它」会把上一场的录播写进这一场）', async () => {
    render(SESSION)
    await click(findBtn())
    expect(candidates()).toBe(2)
    act(() => {
      root.render(
        <VodDialog open accountId={1} session={OTHER} vodAccountUid={null}
                   onClose={onClose} onSaved={onSaved} onSaveVodAccount={onSaveVodAccount} />,
      )
    })
    expect(candidates()).toBe(0)
  })

  it('⑧ 记住录播号：改过才可点，点了交给父组件存到 V 上', async () => {
    render(SESSION, '123')
    // ⚠️ 那个输入框住在**候选区里** ⇒ 先「找录播」把它展开（不是一打开就有）
    await click(findBtn())
    const box = document.querySelector<HTMLInputElement>('[data-vod-account-input]')!
    const saveAcct = document.querySelector<HTMLButtonElement>('[data-vod-account-save]')!
    expect(box.value).toBe('123')
    expect(saveAcct.disabled).toBe(true)          // 没改 → 不可点
    type(box, '123,456')
    expect(saveAcct.disabled).toBe(false)
    await click(saveAcct)
    expect(onSaveVodAccount).toHaveBeenCalledWith('123,456')
  })
})
