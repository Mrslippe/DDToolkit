import { afterEach, describe, expect, it, vi } from 'vitest'

import { __setTauriForTest, api, holdApiUntilReady, markNoTokenRequired, resetApiReady, setApiBase, setApiToken } from './api'

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
  __setTauriForTest(false)   // 闸门只在 Tauri 里生效（见下面那组用例）
  setApiBase('/api')
  resetApiReady()
  markNoTokenRequired()   // 默认放行闸门：**认证本身由下面那组用例专门测**
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

  it('不传 signal 时**仍会**造 init（因为要放 token 头）—— 这是 S1 有意改变的契约', async () => {
    // ⚠️ 2026-09-25（devlog/202）**这条断言被有意改过**：原先是 `expect(init).toBeUndefined()`。
    //    S1 起每个请求都要带 `X-DDToolkit-Token` ⇒ `init` 必然存在。
    //    改这条断言要连着上面「signal 透传」那条一起看：**透传才是要守的东西**，
    //    `init` 是不是 undefined 只是当时的一个副作用。
    const fetchMock = vi.fn(async () => okJson({}))
    vi.stubGlobal('fetch', fetchMock)

    await api.liveSessionUpstream(1, 'uuid-a')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init).toBeDefined()
    expect(init?.signal).toBeUndefined()   // 没传就不该造 signal
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

// ── S1（devlog/202）：token 注入与启动闸门 ──────────────────────────────────
//
// 这一组守的是"**门真的关上了**"这件事。前端是唯一能出示 token 的一方，
// 所以下面每一条都对应一个"漏了就等于门没关"的失败模式。

const TOKEN = 'tok-0123456789abcdef'

describe('S1 会话 token 的注入', () => {
  it('每个请求都带 X-DDToolkit-Token', async () => {
    const fetchMock = vi.fn(async () => okJson({}))
    vi.stubGlobal('fetch', fetchMock)
    setApiToken(TOKEN)

    await api.listVtubers()

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init?.headers)
    expect(headers.get('X-DDToolkit-Token')).toBe(TOKEN)
  })

  it('**不得**给 FormData 请求设 Content-Type（否则 multipart boundary 会丢）', async () => {
    // 这是注入头最容易踩的坑：手写 `{'Content-Type': 'application/json', ...}` 覆盖上去，
    // 浏览器就再也拼不出 `multipart/form-data; boundary=...`，后端解析直接失败
    // （症状是"上传背景 422/400"，与认证毫无关系，很难联想到是 token 那行代码）。
    const fetchMock = vi.fn(async () => okJson({}))
    vi.stubGlobal('fetch', fetchMock)
    setApiToken(TOKEN)

    await api.uploadBackground(1, new File(['x'], 'a.png', { type: 'image/png' }))

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init?.headers)
    expect(headers.get('Content-Type')).toBeNull()
    expect(headers.get('X-DDToolkit-Token')).toBe(TOKEN)
  })

  it('调用方自带的头不会被合并丢掉', async () => {
    const fetchMock = vi.fn(async () => okJson({}))
    vi.stubGlobal('fetch', fetchMock)
    setApiToken(TOKEN)

    await api.saveAppSettings({} as never)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init?.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-DDToolkit-Token')).toBe(TOKEN)
  })

  it('没 token 时不造这个头（浏览器/探针开发态）', async () => {
    const fetchMock = vi.fn(async () => okJson({}))
    vi.stubGlobal('fetch', fetchMock)

    await api.listVtubers()

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init?.headers).get('X-DDToolkit-Token')).toBeNull()
  })

  it('401 的报错要能看出是认证问题（否则用户只看到"加载失败"）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, statusText: 'Unauthorized',
      text: async () => '', json: async () => ({ detail: '缺少或无效的访问令牌' }),
    })))
    setApiToken(TOKEN)

    await expect(api.listVtubers()).rejects.toThrow(/令牌|401/)
  })
})

describe('S1 启动闸门：注入完成前不发业务请求', () => {
  it('关闸后请求**挂着**，开闸才发出去', async () => {
    // 为什么需要它（2026-09-25）：`main.tsx` 的 `Root` 在 `state !== 'pending'` 时就挂载
    // `<Main/>`，而 `setApiBase` / token 都在**异步**的 `tauriBootstrap` 里 ——
    // 原先能工作靠的是"启动幕那 750ms 里没有业务请求自动发出"这个**时序巧合**；
    // 加 token 之后多一次 `invoke`，只会更晚。
    __setTauriForTest(true)   // 闸门只在桌面端生效（浏览器里没有异步注入可等）
    const fetchMock = vi.fn(async () => okJson([]))
    vi.stubGlobal('fetch', fetchMock)
    holdApiUntilReady()

    const pending = api.listVtubers()
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()   // ← 闸门关着，一个请求都不许发

    setApiBase('/api')
    setApiToken(TOKEN)
    await pending
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('**浏览器里关闸是空操作**（没有异步注入可等，关闸只会把探针的请求挂死）', async () => {
    // 实测这是真事故：探针是**模块加载就 `runUiProbe()`**，不等 React effect，
    // 于是它那几个 `authFetch` 卡在闸门上永不返回 ⇒ 表现为"探针没量到 fetch-status"，
    // 看起来像产品坏了。判据是"没在 Tauri 里时 `holdApiUntilReady` 不生效"。
    __setTauriForTest(false)
    const fetchMock = vi.fn(async () => okJson([]))
    vi.stubGlobal('fetch', fetchMock)
    holdApiUntilReady()

    await api.listVtubers()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('`markNoTokenRequired()` 也能开闸（浏览器/探针没有 Tauri）', async () => {
    __setTauriForTest(true)   // 同上：闸门只在桌面端生效
    const fetchMock = vi.fn(async () => okJson([]))
    vi.stubGlobal('fetch', fetchMock)
    holdApiUntilReady()

    const pending = api.listVtubers()
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()

    markNoTokenRequired()
    await pending
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('**默认不关闸**：没人调 `holdApiUntilReady()` 时请求照发（不许把应用挂死）', async () => {
    // 这条守的是"忘了开闸"这个失败模式：第一版闸门默认关着，靠调用方去开 ——
    // 实测后果是**测试里第一条用例挂死 5 秒**（afterEach 还没跑到），
    // 而在生产里就是"所有请求静静地挂着"：没有报错、没有日志，比 401 难查得多。
    const fetchMock = vi.fn(async () => okJson([]))
    vi.stubGlobal('fetch', fetchMock)
    resetApiReady()

    await api.listVtubers()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
