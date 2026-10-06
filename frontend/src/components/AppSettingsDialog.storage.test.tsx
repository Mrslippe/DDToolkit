// @vitest-environment jsdom
/**
 * 「关于 → 存储占用」那一段的**排版契约**（2026-10-06，用户口径）：
 *
 * > 「存储占用一栏末尾的小字提醒太多太杂而且重复了，精简并且将多余的不必要的信息收纳起来，
 * >   让按钮行作为这一栏的收尾」
 *
 * 改前的样子是**同一段 JSX 写了两遍**：三条 note 在动作行前后各渲染一份 ⇒ 用户看到两坨重复小字
 * （`ui_probe.py::_assert_app_settings` 那条"动作行必须是最后一个元素"其实**空转**：
 *  探针的数据目录里没有备份/旧目录，那几条 note 根本不渲染 ⇒ 判据恒真）。
 * 所以这里**专门造出"有备份 + 有旧目录"那种数据**，把那条契约真的量一遍。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getStorage = vi.fn()
const getAssets = vi.fn()
const appSettings = vi.fn()

vi.mock('../api/api', () => ({
  api: {
    appSettings: (...a: unknown[]) => appSettings(...a),
    getStorage: (...a: unknown[]) => getStorage(...a),
    getAssets: (...a: unknown[]) => getAssets(...a),
    // 「用户协议」那一栏（2026-10-06）也住在关于页：本文件测的是存储占用，
    // 但组件会一并取协议状态 ⇒ 这个替身必须有（否则整个关于页渲染不出来）。
    getAgreement: () => Promise.resolve({
      required: '2026-10-06', accepted: '2026-10-06', accepted_at: null,
      needed: false, app_version: '1.1.0',
    }),
  },
}))
vi.mock('../utils/shellBridge', () => ({
  isDesktopShell: () => true,     // 「关于」页在桌面端才读 data-dir 来源 ⇒ 这里当桌面端
  storageInfo: () => Promise.resolve({
    dir: 'E:\\test\\DDToolkit-data', source: 'migrated', portable: false,
    pointerUnusable: null,
  }),
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

/** 一份**有备份、有手工备份、有旧目录**的存储读数（就是用户截图那台机器的形状） */
const STORAGE = {
  groups: {
    database: { bytes: 62_000_000, files: 1 },
    img_cache: { bytes: 1_400_000, files: 12 },
    logs: { bytes: 4_600_000, files: 3 },
    backups: { bytes: 235_000_000, files: 4 },
  },
  total_bytes: 303_000_000,
  disk: { free: 24_000_000_000, total: 500_000_000_000 },
  low_space: false,
  backup_dir: 'E:\\test\\DDToolkit-data\\backups',
  img_cache_max_bytes: 300 * 1024 * 1024,
  backups: [
    { name: 'vtuber-f009-20260929-205944.db', bytes: 60_000_000 },
    { name: 'vtuber-f009-20260929-205939.db', bytes: 59_000_000 },
    { name: 'vtuber-f008-20260929-010823.db', bytes: 58_000_000 },
  ],
  stale_backups: [
    { name: 'vtuber.db.bak-20260913-141254', bytes: 54_000_000 },
    { name: 'vtuber.db.bak-20260913-141254-shm', bytes: 32_768 },
  ],
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  getStorage.mockReset().mockResolvedValue(STORAGE)
  getAssets.mockReset().mockResolvedValue({
    total: { bytes: 622_000_000, files: 609 },
    kinds: { avatar: { files: 609, bytes: 622_000_000, pinned: 8, missing: 0 } },
  })
  appSettings.mockReset().mockResolvedValue({
    specs: [{ key: 'fetch_interval', group: 'fetch', label: '抓取间隔', type: 'int', value: 60 }],
    readonly: [],
    overrides: {},
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

/** 打开设置 → 切到「关于」页（与探针走同一条路：点导航项，不是直接塞状态） */
async function openAbout() {
  await act(async () => {
    root.render(<AppSettingsDialog open onOpenChange={() => {}} />)
    await Promise.resolve()
  })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const nav = [...document.body.querySelectorAll<HTMLButtonElement>('.aps-nav-item')]
    .find((b) => (b.textContent || '').includes('关于'))
  expect(nav, '导航里没有「关于」').toBeTruthy()
  await act(async () => { nav!.click(); await Promise.resolve() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const storageSection = () => document.body.querySelector<HTMLElement>('[data-testid="aps-storage"]')

describe('设置 · 关于 · 存储占用（2026-10-06 用户口径）', () => {
  it('按钮行是这一段的**最后一个元素**（小字不许再跑到它后面）', async () => {
    await openAbout()
    const sec = storageSection()
    expect(sec, '没渲染出存储占用段').toBeTruthy()
    const kids = [...sec!.children] as HTMLElement[]
    expect(kids[kids.length - 1]?.className).toContain('aps-storage-actions')
    // 反向：动作行之后不许再有任何 note / 折叠块
    expect(kids.slice(kids.findIndex((k) => k.className.includes('aps-storage-actions')) + 1))
      .toEqual([])
  })

  it('同一件事**只说一遍**：备份说明合成一行、文件名收进折叠', async () => {
    await openAbout()
    const sec = storageSection()!
    const text = sec.textContent || ''
    expect(text.match(/升级前自动留最近几份/g)?.length, '备份说明重复了').toBe(1)
    expect(text.match(/数据目录：/g)?.length, '数据目录那行重复了').toBe(1)
    // 文件名收进「查看文件」折叠：默认**不收内容**进可见文本这件事由 <details> 保证
    const fold = sec.querySelector<HTMLDetailsElement>('[data-storage="backups-note"] details')
    expect(fold, '备份文件名没折叠起来').toBeTruthy()
    expect(fold!.open, '折叠块默认应当是收起的').toBe(false)
    expect(fold!.querySelector('summary')?.textContent).toContain('查看文件（5）')
    expect(fold!.textContent).toContain('vtuber-f009-20260929-205944.db')
    // 手工备份那份只说"另有手工备份 <体积>"，不再重复一遍"确认没用可以自己删掉"
    expect(text.match(/可自行删除|可以自己删掉/g)?.length).toBe(1)
  })
})
