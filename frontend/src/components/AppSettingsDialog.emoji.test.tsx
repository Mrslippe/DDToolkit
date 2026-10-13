// @vitest-environment jsdom
/**
 * 设置 → 外观 → **「大表情大小」滑杆**（2026-10-14 用户口径，`devlog/486`）：
 * 「大表情的大小默认为 40px，然后在设置中给一个滑杆供用户调节」。
 *
 * 判据钉四件事（少一件这个偏好就是"假的"）：
 * ① 滑杆在，且**范围/档位来自后端 spec**（界面不写死）；
 * ② 默认读数是后端存的值（40）；
 * ③ 拖一格 ⇒ **真的写后端**（`savePrefs`）**且真的改界面**（根元素的 `--post-emoji-big`）——
 *    只改 state 不改 CSS 变量的症状是"滑杆动了、表情没动"，那是这个功能唯一要防的事；
 * ④ 落库失败 ⇒ 尺寸**退回**上一个有效值（不然界面显示一个没存下来的值，重启又变回去）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appSettings = vi.fn()
const getPrefs = vi.fn()
const savePrefs = vi.fn()

vi.mock('../api/api', () => ({
  api: {
    appSettings: (...a: unknown[]) => appSettings(...a),
    getPrefs: (...a: unknown[]) => getPrefs(...a),
    savePrefs: (...a: unknown[]) => savePrefs(...a),
    getStorage: () => Promise.resolve(null),
    getAssets: () => Promise.resolve(null),
    getAgreement: () => Promise.resolve({ required: 'v', accepted: 'v', accepted_at: null,
                                          needed: false, app_version: '1.0.0' }),
  },
}))
vi.mock('../utils/shellBridge', () => ({
  isDesktopShell: () => false,
  storageInfo: () => Promise.resolve(null),
  migrateDataDir: () => Promise.reject(new Error('n/a')),
  deleteOldDataDir: () => Promise.reject(new Error('n/a')),
  checkForUpdate: () => Promise.resolve(null),
  hasPendingUpdate: () => false,
  pendingUpdateInfo: () => null,
  installUpdate: () => Promise.resolve(),
  openReleasePage: () => Promise.resolve(),
}))
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }))

import AppSettingsDialog from './AppSettingsDialog'
import { EMOJI_BIG_DEFAULT, resetEmojiBigSize } from '../utils/emojiSize'

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

const PREFS_BODY = {
  values: { theme: 'light', close_action: 'ask', vod_player_window: 'off',
            post_emoji_big: '40' },
  defaults: { theme: 'light', close_action: 'ask', vod_player_window: 'off',
              post_emoji_big: '40' },
  specs: [{
    key: 'post_emoji_big', label: '大表情大小', group: '外观',
    kind: 'range', min: 24, max: 64, step: 2, unit: 'px',
    options: [], note: '正文里那种「大表情」画多大',
  }],
  changed: [],
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  appSettings.mockReset().mockResolvedValue({
    specs: [], readonly: [], overrides: {},
    info: { app_name: 'DDToolkit', version: '1.0.0', data_dir: 'E:\\d', database: 'vtuber.db',
            port: 1, migration_head: 'f017', log_file: 'l', cors_origins: '*',
            env_file: '.env', pid: 1 },
  })
  getPrefs.mockReset().mockResolvedValue(PREFS_BODY)
  savePrefs.mockReset().mockResolvedValue({ ok: true, changed: [], values: {} })
  // ⚠️ 尺寸是**模块级**状态：不重置就会带着上一条用例的值进来
  resetEmojiBigSize()
  expect(EMOJI_BIG_DEFAULT).toBe(40)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

/** 打开设置窗（默认页就是「外观」）并等偏好读完 */
async function openAppearance() {
  await act(async () => {
    root.render(<AppSettingsDialog open onOpenChange={() => {}} />)
    await Promise.resolve()
  })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const sliderIn = () => document.body.querySelector<HTMLInputElement>('[data-emoji-big-slider]')

/** 拖滑杆：React 的受控 input 要靠**原生 setter** 才认得出变化 */
function drag(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('设置 · 外观 · 大表情大小（滑杆）', () => {
  it('★ 滑杆在，范围与档位来自后端 spec，读数是存的值', async () => {
    await openAppearance()
    const el = sliderIn()
    expect(el, '外观页没有大表情滑杆').toBeTruthy()
    expect([el!.min, el!.max, el!.step]).toEqual(['24', '64', '2'])
    expect(el!.value).toBe('40')
    expect(document.body.querySelector('[data-emoji-big-out]')?.textContent).toBe('40px')
  })

  it('★ 拖一格 ⇒ 写后端 **且** 改界面（`--post-emoji-big`）', async () => {
    await openAppearance()
    drag(sliderIn()!, '48')
    await act(async () => { await Promise.resolve() })
    expect(savePrefs).toHaveBeenCalledWith({ post_emoji_big: '48' })
    expect(document.documentElement.style.getPropertyValue('--post-emoji-big'),
           '只存了后端没改界面 ⇒ 用户会看到"滑杆动了、表情没动"').toBe('48px')
    expect(document.body.querySelector('[data-emoji-big-out]')?.textContent).toBe('48px')
  })

  it('★ 落库失败 ⇒ 尺寸退回上一个有效值（别显示一个没存下来的值）', async () => {
    savePrefs.mockRejectedValue(new Error('后端炸了'))
    await openAppearance()
    drag(sliderIn()!, '56')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.documentElement.style.getPropertyValue('--post-emoji-big')).toBe('40px')
    expect(document.body.querySelector('[data-emoji-big-out]')?.textContent).toBe('40px')
  })

  it('后端没下发这个 spec ⇒ 不渲染滑杆（宁可不显示，也不画一个范围是 NaN 的控件）', async () => {
    getPrefs.mockResolvedValue({ ...PREFS_BODY, specs: [] })
    await openAppearance()
    expect(sliderIn()).toBeNull()
  })
})
