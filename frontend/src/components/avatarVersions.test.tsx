// @vitest-environment jsdom
/**
 * 档案设置窗的**头像多版本选择器**（R47，devlog/249）。
 *
 * ## 判据为什么必须有
 *
 * 用户口径（2026-09-28）：「新抓取下来的不要直接覆盖以前的，把这些都作为**可选项**
 * 保留下来，标记当前用的是哪个就行」。后端那半条由 `tests/test_vtuber_avatars.py`
 * 钉住；这里钉的是**接线**：窗口里到底列的是"历次头像"还是老样子的"账号现值"。
 *
 * 最要紧的一条是 ②：**只存在于历史里、账号现值已经不是它**的那张，必须照样出现在
 * 列表里 —— 老实现（从 `vtuber.accounts` 取 `avatar_url`）恰好会把它漏掉，而这个漏
 * 就是整个需求的反面。所以样本里故意放一张 accounts 里没有的 URL。
 *
 * 手法与 `live/LiveSessionDialog.test.tsx` 一致：jsdom + `react-dom/client` + `act`，
 * 零新依赖（本仓不引 Testing Library）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VTuber, VTuberAvatars } from '../api/types'

const BOOK: VTuberAvatars = {
  current_url: 'https://wx1.sinaimg.cn/mid.jpg',
  versions: [
    { id: 3, url: 'https://wx1.sinaimg.cn/new.jpg', path: null, platform: 'weibo',
      account_id: 9, first_seen_at: '2026-09-27T00:00:00Z', last_seen_at: null },
    // ② 这一张**只存在于历史里**（账号现值已是 new.jpg）—— 老实现必然漏掉它
    { id: 2, url: 'https://wx1.sinaimg.cn/mid.jpg', path: 'static/avatars/weibo_9_ab.jpg',
      platform: 'weibo', account_id: 9, first_seen_at: '2026-05-01T00:00:00Z',
      last_seen_at: null },
    { id: 1, url: 'https://i0.hdslb.com/old.jpg', path: null, platform: 'bilibili',
      account_id: 8, first_seen_at: '2024-01-02T00:00:00Z', last_seen_at: null },
  ],
}

const updateVtuber = vi.fn(async () => ({ id: 7, name: '七海' }) as unknown as VTuber)
const getVtuberAvatars = vi.fn(async () => BOOK)

vi.mock('../api/api', () => ({
  api: {
    getVtuberAvatars: (...a: unknown[]) => getVtuberAvatars(...(a as [])),
    updateVtuber: (...a: unknown[]) => updateVtuber(...(a as [])),
  },
  resolveAsset: (p: string | null | undefined) => (p ? `/api/${p}` : undefined),
  imgProxyUrl: (s: string) => `/api/img-proxy?url=${encodeURIComponent(s)}`,
}))

import VtuberSettingsDialog from './VtuberSettingsDialog'

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

const VT = {
  id: 7, name: '七海', faction: null, birthday: null, debut_date: null, setting: null,
  // 账号现值是 new.jpg（历史里必须仍能选到 mid.jpg）
  avatar: 'https://wx1.sinaimg.cn/mid.jpg', background_path: null, notes: null,
  sign_override: null, sign_source_account_id: null, created_at: null, updated_at: null,
  accounts: [{
    id: 9, vtuber_id: 7, platform: 'weibo', platform_uid: 'w9', display_name: '微博名',
    avatar_url: 'https://wx1.sinaimg.cn/new.jpg', avatar_path: null, sign: '微博签名',
    url: null, followers_count: 1, room_id: null, live_status: 0, live_title: null,
    live_url: null, last_fetched_at: null, sort_order: 0,
  }],
} as unknown as VTuber

let host: HTMLDivElement
let root: Root
const onSaved = vi.fn()

const opts = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.vd-avatar-opt'))

async function render() {
  await act(async () => {
    root.render(
      <VtuberSettingsDialog open onOpenChange={() => {}} vtuber={VT}
                             onSaved={onSaved} onPill={() => {}} />,
    )
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  getVtuberAvatars.mockClear()
  updateVtuber.mockClear()
  onSaved.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('档案设置 · 历次头像选择器（R47）', () => {
  it('① 列表来自历次头像端点（不是账号现值）', async () => {
    await render()
    expect(getVtuberAvatars).toHaveBeenCalledWith(7)
    expect(opts()).toHaveLength(3)
    // 账号现值那一枚（new.jpg）在，**只存在于历史里**的那一枚（mid.jpg）也在
    const titles = opts().map((b) => b.title)
    expect(titles.some((t) => t.includes('2026-09-27'))).toBe(true)
    expect(titles.some((t) => t.includes('2026-05-01'))).toBe(true)
    expect(titles.some((t) => t.includes('2024-01-02'))).toBe(true)
  })

  it('② 只存在于历史里的那张也在列表里（老实现会漏掉它）', async () => {
    await render()
    const urls = opts().map((b) => b.querySelector('img')?.getAttribute('src') ?? '')
    // mid.jpg 这一张只有历史里有（账号现值已是 new.jpg），它带着本地缓存 ⇒ 预览用本地文件
    expect(urls.some((u) => u.includes('/api/static/avatars/weibo_9_ab.jpg'))).toBe(true)
    // 只有远端 URL 的历史项（new.jpg，微博图床）⇒ 走代理（R46 那条规则）；
    // B 站那张可直连 ⇒ 原样
    expect(urls.some((u) => u.includes('img-proxy'))).toBe(true)
    expect(urls.some((u) => u === 'https://i0.hdslb.com/old.jpg')).toBe(true)
  })

  it('③ 当前用的那张被标出来（唯一的 .on）', async () => {
    await render()
    const on = opts().filter((b) => b.classList.contains('on'))
    expect(on).toHaveLength(1)
    expect(on[0].title).toContain('（当前）')
    // 当前 = vtuber.avatar（mid.jpg）——**不是**列表第一张（new.jpg）
    expect(on[0].title).toContain('2026-05-01')
    expect(on[0].querySelector('img')?.getAttribute('src'))
      .toContain('/api/static/avatars/weibo_9_ab.jpg')
  })

  it('④ 点一张就写它（且写的是 URL 原文，不是本地路径）', async () => {
    await render()
    await act(async () => {
      opts()[2].click()          // B 站的那张老头像
    })
    expect(updateVtuber).toHaveBeenCalledWith(7, { avatar: 'https://i0.hdslb.com/old.jpg' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('⑤ 平台名与"首次见到时间未知"都写进 title（历史行才显示日期）', async () => {
    const onlyNow: VTuberAvatars = {
      // 与 `vtuber.avatar` 同一张（没显式选过时后端也这么推）⇒ 应当被标成当前
      current_url: 'https://wx1.sinaimg.cn/mid.jpg',
      versions: [{ id: null, url: 'https://wx1.sinaimg.cn/mid.jpg', path: null,
                   platform: 'weibo', account_id: 9, first_seen_at: null,
                   last_seen_at: null }],
    }
    getVtuberAvatars.mockResolvedValueOnce(onlyNow)
    await render()
    expect(opts()).toHaveLength(1)
    expect(opts()[0].title).toContain('微博')
    expect(opts()[0].title).toContain('首次见到时间未知')
    expect(opts()[0].classList.contains('on')).toBe(true)     // 它就是当前那张
  })

  it('⑥ 端点取失败 ⇒ 退化成空态而不是崩（只少几个可选项，不阻断窗口）', async () => {
    getVtuberAvatars.mockRejectedValueOnce(new Error('500'))
    await render()
    expect(opts()).toHaveLength(0)
    expect(document.querySelector('.vd-avatar-row')?.textContent).toContain('暂无账号头像')
  })
})
