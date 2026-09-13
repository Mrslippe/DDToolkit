import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, setApiBase } from './api'

/**
 * 取消在途请求的**管道**契约（2026-09-13，devlog/064）。
 *
 * 背景：场次详情的上游取数最坏要等 90 多秒（30s × 3 次重试，devlog/062/063），
 * 而用户切场次/关弹窗后根本不再需要那一发。`useLiveUpstream` 用 AbortController 取消，
 * 但**取消能不能生效取决于 `signal` 有没有一路透传到 `fetch`** ——
 * 中间被吞掉时不会报错、只会"点了没反应"，所以在这里锁住。
 *
 * （hook 自身的状态机需要组件测试环境，本仓暂未引入 —— 见 devlog/064 §四。）
 */

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => JSON.stringify(body),
})

afterEach(() => {
  vi.unstubAllGlobals()
  setApiBase('/api')
})

describe('api.liveSessionUpstream 的取消管道', () => {
  it('把 signal 透传给 fetch（取消才可能生效）', async () => {
    const fetchMock = vi.fn(async () => okJson({ danmaku: null, metrics: null, events: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctrl = new AbortController()

    await api.liveSessionUpstream(7, 'uuid-a', ctrl.signal)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/account/7/live-sessions/uuid-a/upstream')
    expect(init?.signal).toBe(ctrl.signal)
  })

  it('live_id 仍要 encodeURIComponent（uuid 里的字符不得拼进路径）', async () => {
    const fetchMock = vi.fn(async () => okJson({}))
    vi.stubGlobal('fetch', fetchMock)

    await api.liveSessionUpstream(1, 'a/b c')

    expect((fetchMock.mock.calls[0] as unknown as [string])[0])
      .toBe('/api/account/1/live-sessions/a%2Fb%20c/upstream')
  })

  it('不传 signal 时不造 init.signal（其余调用方行为不变）', async () => {
    const fetchMock = vi.fn(async () => okJson({}))
    vi.stubGlobal('fetch', fetchMock)

    await api.liveSessionUpstream(1, 'uuid-a')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init).toBeUndefined()
  })

  it('取消时抛出 AbortError（调用方据此区分"主动取消"与"请求失败"）', async () => {
    // 用真实 fetch 的语义模拟：signal abort → reject(AbortError)
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal
        if (!sig) return
        if (sig.aborted) return reject(new DOMException('Aborted', 'AbortError'))
        sig.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const ctrl = new AbortController()

    const p = api.liveSessionUpstream(7, 'uuid-a', ctrl.signal)
    ctrl.abort()

    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('自建词云同样透传 signal（这条路径最长 120s，取消同样靠它）', async () => {
    const fetchMock = vi.fn(async () => okJson({ wc_status: 'self_built' }))
    vi.stubGlobal('fetch', fetchMock)
    const ctrl = new AbortController()

    await api.buildLiveSessionWordCloud(7, 'uuid-a', ctrl.signal)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/account/7/live-sessions/uuid-a/wordcloud')
    expect(init?.signal).toBe(ctrl.signal)
  })
})
