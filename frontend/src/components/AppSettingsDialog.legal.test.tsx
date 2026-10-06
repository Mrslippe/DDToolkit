// @vitest-environment jsdom
/**
 * 设置 → 关于 → **「用户协议」那一栏**（2026-10-06 用户口径）：
 * 「在设置中的关于项里面添加一栏用户协议，给一个按钮来点击查看」。
 *
 * 三条契约：① 那一栏在（含当前声明版本与"同意到哪一版"）；
 * ② 「查看全文」点开的是**只读模式**（`data-legal-variant="view"`，能关、不写任何东西）；
 * ③ **同意动作只发生在启动闸门那一处** —— 设置页里那颗钮不许偷偷 POST（否则"看过"与
 *    "同意过"就混了，而闸门的意义正是"读没读过"）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAgreement = vi.fn()
const acceptAgreement = vi.fn()
const appSettings = vi.fn()

vi.mock('../api/api', () => ({
  api: {
    appSettings: (...a: unknown[]) => appSettings(...a),
    getStorage: () => Promise.resolve(null),
    getAssets: () => Promise.resolve(null),
    getAgreement: (...a: unknown[]) => getAgreement(...a),
    acceptAgreement: (...a: unknown[]) => acceptAgreement(...a),
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

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  getAgreement.mockReset().mockResolvedValue({
    required: '2026-10-06', accepted: '2026-10-06',
    accepted_at: '2026-10-06T05:32:30+00:00', needed: false, app_version: '1.1.0',
  })
  acceptAgreement.mockReset()
  appSettings.mockReset().mockResolvedValue({
    specs: [], readonly: [], overrides: {},
    info: {
      app_name: 'DDToolkit', version: '1.1.0', data_dir: 'E:\\test\\DDToolkit-data',
      database: 'vtuber.db', port: 8765, migration_head: 'f009',
      log_file: 'logs/app.log', cors_origins: '*', env_file: '.env', pid: 1,
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

async function openAbout() {
  await act(async () => {
    root.render(<AppSettingsDialog open onOpenChange={() => {}} />)
    await Promise.resolve()
  })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const nav = [...document.body.querySelectorAll<HTMLButtonElement>('.aps-nav-item')]
    .find((b) => (b.textContent || '').includes('关于'))!
  await act(async () => { nav.click(); await Promise.resolve() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('设置 · 关于 · 用户协议那一栏', () => {
  it('那一栏在，且如实说明"同意到哪一版 / 何时同意"', async () => {
    await openAbout()
    const sec = document.body.querySelector('[data-testid="aps-legal"]')
    expect(sec, '关于页没有「用户协议」这一栏').toBeTruthy()
    const text = sec!.textContent || ''
    expect(text).toContain('用户协议')
    expect(text).toContain('2026-10-06')
    expect(text).toContain('已于')
    expect(sec!.querySelector('[data-legal-state]')?.getAttribute('data-legal-state'))
      .toBe('accepted')
    expect(sec!.querySelector('[data-testid="aps-legal-view"]'), '缺少「查看全文」那颗钮')
      .toBeTruthy()
  })

  it('还没同意时那一栏照实说"尚未同意"（而不是装作已同意）', async () => {
    getAgreement.mockResolvedValue({
      required: '2026-10-06', accepted: null, accepted_at: null,
      needed: true, app_version: '1.1.0',
    })
    await openAbout()
    const sec = document.body.querySelector('[data-testid="aps-legal"]')!
    expect(sec.querySelector('[data-legal-state]')?.getAttribute('data-legal-state'))
      .toBe('pending')
    expect(sec.textContent).toContain('尚未同意')
  })

  it('「查看全文」打开的是**只读**那份：能关，且**绝不写库**', async () => {
    await openAbout()
    await act(async () => {
      document.body.querySelector<HTMLElement>('[data-testid="aps-legal-view"]')!.click()
      await Promise.resolve()
    })
    const modal = document.body.querySelector('[data-legal="1"]')
    expect(modal, '点了「查看全文」没有打开').toBeTruthy()
    expect(modal!.getAttribute('data-legal-variant')).toBe('view')
    expect(modal!.textContent).toContain('一、开源许可与本须知的效力')
    expect(document.body.querySelector('[data-testid="legal-agree"]'),
           '设置里这份是"查看"，不该出现同意钮').toBeNull()

    await act(async () => {
      document.body.querySelector<HTMLElement>('[data-testid="legal-close"]')!.click()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-legal="1"]'), '「关闭」没关上').toBeNull()
    expect(acceptAgreement, '查看全文竟然写了库 —— 那"同意"就没有意义了')
      .not.toHaveBeenCalled()
  })
})
