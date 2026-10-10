// @vitest-environment jsdom
/**
 * 封面取值口径的**接线判据**（2026-10-10 自审 F3，`devlog/461`）。
 *
 * ## 分歧长什么样
 *
 * 帖子列表走 `resolveCoverSources`（**本地优先**，理由写在 `utils/coverSource.ts`：
 * 图床常被防盗链拦、老帖的图会被删），而**档案页「随机投稿」**压根不读 `cover_local`
 * ⇒ 同一张帖"列表里有封面、这张卡上是空的"（详情抽屉那处同病，同一批修的）。
 *
 * 纯函数那半边没什么可测的（`resolveCoverSources` 早就对了）—— 这里钉的是
 * **"调用点真的用了它"**：只测纯函数的话，"组件压根没调那个函数"照样绿。
 *
 * ⚠️ mock 路径是 `../../api/api`（本文件在 `src/components/profile/`）——
 * 写成 `../api/api` **不报错，但也不生效**：组件照旧调真 `api`，
 * 而 jsdom 里没有后端 ⇒ 卡片进 error 态，用例红在一个与被测逻辑无关的地方
 * （第一版就是这么红的，查了半天）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listPosts = vi.fn()
vi.mock('../../api/api', async (orig) => {
  const real = await orig<typeof import('../../api/api')>()
  return {
    ...real,
    api: { ...real.api, listPosts: (...a: unknown[]) => listPosts(...a) },
  }
})

import TopPostsCard from './cards/TopPostsCard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ACCOUNT = { id: 99, platform: 'bilibili', platform_uid: '1' } as never
const VTUBER = { id: 23, name: 'V', accounts: [] } as never

/** 本地副本 + 远端都有的那条帖：断言"首选源必须是本地那份" */
const post = {
  id: 101, vtuber_id: 23, account_id: 99, platform: 'bilibili', type: 'video',
  platform_post_id: 'BV1', title: '一条投稿', body_json: '{}', stats_json: '{}',
  permalink: null, published_at: '2026-10-01T12:00:00+08:00',
  cover_url: 'https://i0.hdslb.com/a.jpg', cover_local: 'static/covers/a.jpg',
  images_local: [], deleted_detected_at: null,
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  listPosts.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

async function mount(posts: unknown[]) {
  // ⚠️ `listPosts` 回的是**分页信封**（`{items}`），不是裸数组
  listPosts.mockResolvedValue({ items: posts, total: posts.length, page: 1, page_size: 50 })
  await act(async () => {
    root.render(<TopPostsCard vtuber={VTUBER} account={ACCOUNT} onOpenPost={() => {}}
                              refreshTick={0} editing={false} />)
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

const coverImg = () => host.querySelector<HTMLImageElement>('.rp-cover')

describe('档案页「随机投稿」的封面', () => {
  it('★ 有本地副本时首选源必须是**本地那份**（远端只当兜底）', async () => {
    await mount([post])
    const img = coverImg()
    expect(img, '封面没渲染出来（卡片进了 error 态 / 选择器变了？）').toBeTruthy()
    expect(img!.getAttribute('src'), '直接读 cover_url ⇒ 图床拦 Referer 时这张卡是空的')
      .toContain('static/covers/a.jpg')
  })

  it('只有远端、没有本地副本时照样显示远端（别把没固化的帖变成空卡）', async () => {
    await mount([{ ...post, cover_local: null }])
    expect(coverImg()!.getAttribute('src')).toContain('hdslb.com')
  })

  it('两端都没有才退成首字占位（正对照：说明上面两条读的不是一个空元素）', async () => {
    await mount([{ ...post, cover_url: null, cover_local: null }])
    expect(coverImg()).toBeNull()
    expect(host.querySelector('.rp-cover-ph')?.textContent).toBe('一')
  })
})
