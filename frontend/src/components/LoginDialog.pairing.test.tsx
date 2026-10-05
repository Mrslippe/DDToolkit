// @vitest-environment jsdom
/**
 * 登录浮窗里的「浏览器扩展」那一栏（E3，2026-10-06）。
 *
 * 守的是四件用户能看到的事：
 * ① 配对 token **默认打码**（凭据不该一开窗就摊在屏幕上），点「显示」才进 DOM；
 * ② 「复制」真的写剪贴板；剪贴板被拒时**退化成显示**（不是"点了没反应"）；
 * ③ 「重置配对」要**二次确认**（点错了扩展当场失效）；
 * ④ 「上次同步」只显示**键名与时间**；从没同步过时说"还没有同步过"（不是 1970 年）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LoginDialog from './LoginDialog'
import type { PairingInfo } from '../api/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const PAIRING: PairingInfo = {
  token: 'TOKEN-VALUE-MUST-NOT-SHOW-UNTIL-ASKED-0123456789',
  last_sync: {
    platform: 'xiaohongshu', label: '小红书', keys: ['a1', 'web_session'],
    cookie_keys: 2, verified: false, at: Date.now() - 60_000,
  },
}

const statusMock = vi.fn()
const pairingMock = vi.fn()
const resetMock = vi.fn()
const writeTextMock = vi.fn()

vi.mock('../api/api', () => ({
  api: {
    authStatus: (...a: unknown[]) => statusMock(...a),
    startQrLogin: vi.fn().mockResolvedValue({ qr_id: 'q1', url: 'https://example.invalid/qr' }),
    checkQrLogin: vi.fn().mockResolvedValue({ status: 'waiting' }),
    getPairing: (...a: unknown[]) => pairingMock(...a),
    resetPairing: (...a: unknown[]) => resetMock(...a),
  },
}))

// `platformLogin` 的文案表照旧走真实现（它有自己的用例）；这里只关心这一栏。
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  statusMock.mockReset().mockResolvedValue(
    { logged_in: false, needs_login: true, uid: null, name: null })
  pairingMock.mockReset().mockResolvedValue(PAIRING)
  resetMock.mockReset().mockResolvedValue({ ...PAIRING, token: 'FRESH-TOKEN-abcdefghijklmnop' })
  writeTextMock.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

async function render() {
  await act(async () => {
    root.render(<LoginDialog open onOpenChange={() => {}} />)
  })
}

const block = () => document.querySelector<HTMLElement>('[data-ext-pairing]')
const tokenEl = () => document.querySelector<HTMLElement>('[data-ext-token]')
const byData = (name: string) => document.querySelector<HTMLElement>(`[data-${name}]`)

describe('浏览器扩展那一栏', () => {
  it('token 默认**打码**，点「显示」才进 DOM', async () => {
    await render()
    expect(block()).toBeTruthy()
    expect(tokenEl()!.getAttribute('data-ext-token')).toBe('masked')
    expect(tokenEl()!.textContent).not.toContain('TOKEN-VALUE')
    // 打码态下整个浮窗里都不该出现 token 明文（截图/录屏是最常见的泄露途径）
    expect(document.body.textContent).not.toContain('TOKEN-VALUE')

    await act(async () => { byData('ext-toggle')!.click() })
    expect(tokenEl()!.getAttribute('data-ext-token')).toBe('shown')
    expect(tokenEl()!.textContent).toContain('TOKEN-VALUE')
  })

  it('「复制」写进剪贴板并给出反馈', async () => {
    await render()
    await act(async () => { byData('ext-copy')!.click() })
    expect(writeTextMock).toHaveBeenCalledWith(PAIRING.token)
    expect(byData('ext-copy')!.textContent).toContain('已复制')
  })

  it('剪贴板被拒 ⇒ **退化成显示**，不是"点了没反应"', async () => {
    writeTextMock.mockRejectedValue(new Error('NotAllowedError'))
    await render()
    await act(async () => { byData('ext-copy')!.click() })
    expect(tokenEl()!.getAttribute('data-ext-token')).toBe('shown')
  })

  it('「重置配对」要**二次确认**，确认后才真的换 token', async () => {
    await render()
    await act(async () => { byData('ext-reset')!.click() })
    expect(resetMock).not.toHaveBeenCalled()          // 第一次点只是展开确认
    expect(block()!.textContent).toContain('扩展要重新贴一次')

    await act(async () => { byData('ext-reset-confirm')!.click() })
    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(tokenEl()!.textContent).toContain('FRESH-TOKEN')   // 换完自动显示出来给用户贴
  })

  it('取消二次确认 ⇒ 不换 token', async () => {
    await render()
    await act(async () => { byData('ext-reset')!.click() })
    await act(async () => { byData('ext-reset-cancel')!.click() })
    expect(resetMock).not.toHaveBeenCalled()
    expect(byData('ext-reset')).toBeTruthy()          // 回到初始那一颗按钮
  })

  it('「上次同步」显示平台、时间与**键名**（没有值）', async () => {
    await render()
    const line = byData('ext-last-sync')!
    expect(line.getAttribute('data-ext-last-sync')).toBe('xiaohongshu')
    expect(line.textContent).toContain('小红书')
    expect(line.textContent).toContain('未在线验证')   // 小红书不做在线探活 ⇒ 如实标注
    expect(block()!.textContent).toContain('a1')
    expect(block()!.textContent).toContain('web_session')
    expect(block()!.textContent).toContain('共 2 个键')
  })

  it('从没同步过 ⇒ 说「还没有同步过」（不是 1970 年）', async () => {
    pairingMock.mockResolvedValue({ token: 't', last_sync: null })
    await render()
    expect(block()!.textContent).toContain('还没有同步过')
    expect(byData('ext-last-sync')).toBeNull()
  })

  it('读不到配对信息（后端没起来）⇒ 说清楚，而不是空白或崩', async () => {
    pairingMock.mockRejectedValue(new Error('401'))
    await render()
    expect(block()).toBeTruthy()
    expect(block()!.textContent).toContain('读不到配对信息')
  })

  it('平台 Tab 与「凭据仅保存在本机」照旧还在（这一栏是**追加**，不是替换）', async () => {
    await render()
    for (const p of ['bilibili', 'weibo', 'xiaohongshu', 'douyin']) {
      expect(document.querySelector(`[data-auth-tab="${p}"]`)).toBeTruthy()
    }
    expect(document.body.textContent).toContain('仅保存在本机')
  })
})
