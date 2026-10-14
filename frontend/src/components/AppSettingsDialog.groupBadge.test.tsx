// @vitest-environment jsdom
/**
 * 设置 → 外观 → **「显示企划徽章」开关**（2026-10-14 用户口径：
 * 「把企划图标显示开关做到设置里」+ 明确**默认关**）。
 *
 * 判据钉三件事（少一件这个开关就是"假的"）：
 * ① 开关在，且默认读数是后端的 `off`（界面不写死 key，取 `specs` 里的 label/note）；
 * ② 点一下 ⇒ **真的写后端**（`savePrefs`）**且真的改界面**（根元素 `data-group-badge='on'`）——
 *    只改 state 不改根属性的症状是"开关开了、徽章没出来"，那是这个功能唯一要防的事；
 * ③ 落库失败 ⇒ 开关**退回**（根属性回 `off`，按钮回 `aria-checked=false`）——
 *    否则界面显示"开"、重启又变回"关"，用户以为设置没保存。
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
  imgProxyUrl: (src: string) => `/api/img-proxy?url=${encodeURIComponent(src)}`,
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
import { GROUP_BADGE_ATTR, GROUP_BADGE_DEFAULT, resetGroupBadge } from '../utils/groupBadgePref'

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

const SPEC = {
  key: 'group_badge', label: '显示企划徽章', group: '外观',
  options: [{ value: 'off', label: '关闭' }, { value: 'on', label: '开启' }],
  note: '左栏每一行名字右边那枚徽章；默认关闭',
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
  savePrefs.mockReset().mockResolvedValue({ ok: true, changed: [], values: {} })
  // ⚠️ 开关是**模块级**状态：不重置就会带着上一条用例的值进来
  resetGroupBadge()
  expect(GROUP_BADGE_DEFAULT).toBe('off')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''          // ⚠️ 设置窗是 portal 到 body 的，要连它一起清
  document.documentElement.removeAttribute(GROUP_BADGE_ATTR)
})

/** 渲染设置窗并等偏好读回来（默认页就是「外观」） */
async function render(prefValue = 'off') {
  getPrefs.mockResolvedValue({
    values: { theme: 'light', close_action: 'ask', group_badge: prefValue },
    defaults: { theme: 'light', close_action: 'ask', group_badge: 'off' },
    specs: [SPEC], changed: [],
  })
  await act(async () => {
    root.render(<AppSettingsDialog open onOpenChange={() => {}} />)
    await Promise.resolve()
  })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

/** ⚠️ 查 `document.body` 而不是 `host`：Radix 的 DialogContent portal 到 body */
const sw = () => document.body.querySelector<HTMLButtonElement>('[data-setting="group_badge"] .aps-switch')

describe('设置 · 外观 · 显示企划徽章（2026-10-14）', () => {
  it('★ 开关在「外观」页，文案来自后端 spec，默认读数是「关」', async () => {
    await render('off')
    const btn = sw()
    expect(btn, '开关没渲染出来（`data-setting="group_badge"` 或 `specs` 没接上）').toBeTruthy()
    expect(btn!.getAttribute('role')).toBe('switch')
    expect(btn!.getAttribute('aria-checked')).toBe('false')
    expect(btn!.textContent).toContain('关')
    // 文案来自后端（不写死）：label 与 note 都要在
    const row = document.body.querySelector('[data-setting="group_badge"]')!
    expect(row.textContent).toContain(SPEC.label)
    expect(row.textContent).toContain(SPEC.note)
  })

  it('★ 点一下 ⇒ 真的写后端**且**真的改界面（根元素属性）', async () => {
    await render('off')
    await act(async () => { sw()!.click() })
    await act(async () => { await Promise.resolve() })

    expect(savePrefs, '只改了界面没写后端 —— 重启就丢').toHaveBeenCalledWith({ group_badge: 'on' })
    expect(document.documentElement.getAttribute(GROUP_BADGE_ATTR),
           '只写了后端没改界面 —— 开关开了、徽章没出来').toBe('on')
    expect(sw()!.getAttribute('aria-checked')).toBe('true')
  })

  it('★ 落库失败 ⇒ 开关**退回**（界面不许显示一个没存下来的值）', async () => {
    await render('off')
    savePrefs.mockRejectedValueOnce(new Error('后端挂了'))
    await act(async () => { sw()!.click() })
    await act(async () => { await Promise.resolve() })

    expect(savePrefs).toHaveBeenCalled()
    expect(document.documentElement.getAttribute(GROUP_BADGE_ATTR),
           '落库失败但界面停在「开」—— 用户会以为设置保存了').toBe('off')
    expect(sw()!.getAttribute('aria-checked')).toBe('false')
  })

  it('后端已经存了「开」⇒ 打开设置窗时开关就是开着的', async () => {
    await render('on')
    expect(sw()!.getAttribute('aria-checked')).toBe('true')
    expect(sw()!.textContent).toContain('开')
  })
})
