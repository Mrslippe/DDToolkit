/**
 * 推送通道的**传输层**判据（M0b，devlog/242；方案 `docs/design/notices/message-hub-execution.md` §2.1）。
 *
 * 这一层只回答三件事，**都不靠"看起来连着"**：
 * ① 帧解析（注释行/心跳、跨 chunk 切断、坏帧不许炸整条流）；
 * ② **token 走 header、不进 URL**（V5 的**行为**版判据 —— 直接量 fetch 的实参）；
 * ③ 断线重连要带 `Last-Event-ID`，`stop()` 之后不许再连。
 *
 * ⚠️ 跑在 node 环境（默认）：`window` 不存在，所以只用 Promise 驱动、不碰 DOM。
 *    `ReadableStream` / `TextEncoder` / `AbortController` 都是 Node 自带。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetApiReady, setApiBase, setApiToken } from '../api/api'
import { MESSAGE_STREAM_PATH, parseSseFrames, startMessageStream, type StreamMessage } from './eventStream'

const frame = (msg: Record<string, unknown>, id?: number) =>
  `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(msg)}\n\n`

/** 手工可控的 SSE 响应：测试自己决定什么时候推哪一段、什么时候断。 */
function sseResponse() {
  const encoder = new TextEncoder()
  let push!: (chunk: string) => void
  let close!: () => void
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk: string) => controller.enqueue(encoder.encode(chunk))
      close = () => controller.close()
    },
  })
  return { res: { ok: true, status: 200, body } as unknown as Response, push, close }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** `init.headers` 可能是对象也可能是 `Headers`（`authFetch` 传的是后者）—— 统一读法。 */
const hdr = (init: RequestInit, name: string): string | null =>
  new Headers(init.headers as HeadersInit).get(name)

afterEach(() => {
  vi.unstubAllGlobals()
  setApiBase('/api')
  resetApiReady()
})

describe('① 帧解析（纯函数）', () => {
  it('注释行（`: connected` / `: ping`）不是消息，也不影响后面的帧', () => {
    const { messages, rest } = parseSseFrames(
      ': connected\n\n: ping\n\n' + frame({ type: 'notice.message', payload: { text: '嗨' }, ts: 1, seq: 7 }),
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'notice.message', seq: 7, replay: false })
    expect(messages[0].payload).toEqual({ text: '嗨' })
    expect(rest).toBe('')
  })

  it('半个帧留在 rest 里，补齐后才是消息（跨 chunk 会被网络切开）', () => {
    // ⚠️ 切点必须在**第一帧之后、第二帧中间**，否则切出来的那半段一个换行都没有
    //    （走的是"一行都没收全"那条早退分支，测不到 `rest` 的交回逻辑 —— 反向验证实测踩到）。
    const a = frame({ type: 'notice.alert', payload: {}, ts: 1, seq: 3 })
    const b = frame({ type: 'domain.posts.changed', payload: { uid: '1' }, ts: 2, seq: 4 })
    const cut = a.length + Math.floor(b.length / 2)
    const first = parseSseFrames((a + b).slice(0, cut))
    expect(first.messages.map((m) => m.type)).toEqual(['notice.alert'])
    expect(first.rest).toBe(b.slice(0, cut - a.length)), '第二帧的残余必须原样交回'

    const second = parseSseFrames(first.rest + b.slice(cut - a.length))
    expect(second.messages.map((m) => m.type)).toEqual(['domain.posts.changed'])
    expect(second.rest).toBe('')
  })

  it('一行都没收全时也把整段交回（不做任何解析）', () => {
    const half = 'data: {"type":"notice.mess'
    const { messages, rest } = parseSseFrames(half)
    expect(messages).toEqual([])
    expect(rest).toBe(half)
  })

  it('坏 JSON / 缺 type 的帧被丢掉，但**不打断**后面的好帧', () => {
    const { messages } = parseSseFrames(
      'data: {oops\n\n' + 'data: {"payload":{}}\n\n' + frame({ type: 'domain.posts.changed', payload: {}, ts: 2, seq: 9 }),
    )
    expect(messages.map((m) => m.type)).toEqual(['domain.posts.changed'])
  })

  it('`\\r\\n` 换行与多行 `data:`（SSE 规范允许）都能解析', () => {
    const { messages } = parseSseFrames(
      'id: 4\r\ndata: {"type":"notice.message",\r\ndata: "seq":4,"replay":true}\r\n\r\n',
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'notice.message', seq: 4, replay: true })
  })

  it('`seq` 缺失时用 `id:` 兜底（重连要靠它）', () => {
    const { messages } = parseSseFrames(frame({ type: 'notice.message', payload: {}, ts: 0 }, 12))
    expect(messages[0].seq).toBe(12)
  })
})

describe('② token 走 header，不进 URL（V5）', () => {
  it('实参里：URL 无 token 无 query，header 里才有', async () => {
    const fetchMock = vi.fn(async () => sseResponse().res as Response)
    vi.stubGlobal('fetch', fetchMock)
    setApiToken('secret-token-abc')

    const handle = startMessageStream({ onMessage: () => {}, retryMs: 5 })
    await tick(10)
    handle.stop()

    expect(fetchMock).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api${MESSAGE_STREAM_PATH}`)
    expect(url).not.toContain('secret-token-abc')
    expect(url).not.toContain('?')
    const headers = init.headers as Headers
    expect(headers.get('X-DDToolkit-Token')).toBe('secret-token-abc')
    expect(headers.get('Accept')).toBe('text/event-stream')
  })

  it('端点路径本身不带 query（别给新端点起带 token 的参数名，方案 §2.1）', () => {
    expect(MESSAGE_STREAM_PATH).toBe('/messages/stream')
    expect(MESSAGE_STREAM_PATH).not.toContain('?')
    expect(MESSAGE_STREAM_PATH).not.toContain('token')
  })
})

describe('③ 连接 / 重连 / 收摊', () => {
  it('把帧按顺序交给 onMessage，并把 replay 标记原样带出来', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const first = sseResponse()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return first.res as Response
    }))

    const got: StreamMessage[] = []
    const handle = startMessageStream({ onMessage: (m) => got.push(m), retryMs: 5 })
    await tick(10)
    first.push(frame({ type: 'notice.message', payload: { text: '现场' }, ts: 1, seq: 1 }))
    first.push(frame({ type: 'notice.message', payload: { text: '补发' }, ts: 1, seq: 2, replay: true }))
    await tick(20)
    handle.stop()

    expect(got.map((m) => [m.type, m.seq, m.replay])).toEqual([
      ['notice.message', 1, false],
      ['notice.message', 2, true],
    ])
    expect(calls).toHaveLength(1)
  })

  it('连接断掉 ⇒ 自动重连，且带 `Last-Event-ID`（重连才补发，方案 §8.5 D）', async () => {
    const first = sseResponse()
    const second = sseResponse()
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return (calls.length === 1 ? first.res : second.res) as Response
    }))

    const got: StreamMessage[] = []
    const handle = startMessageStream({ onMessage: (m) => got.push(m), retryMs: 5, maxRetryMs: 20 })
    await tick(10)
    first.push(frame({ type: 'notice.message', payload: { text: 'a' }, ts: 1, seq: 41 }))
    await tick(10)
    first.close()                       // 连接断（服务重启 / 网络抖动）
    await tick(80)

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(hdr(calls[1].init, 'Last-Event-ID')).toBe('41')
    handle.stop()
  })

  it('首次连接**不带** `Last-Event-ID`（否则每开一次窗都会重播历史）', async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init)
      return sseResponse().res as Response
    }))
    const handle = startMessageStream({ onMessage: () => {}, retryMs: 5 })
    await tick(10)
    handle.stop()
    expect(hdr(calls[0], 'Last-Event-ID')).toBeNull()
  })

  it('`stop()` 会 abort 并**不再重连**（收摊要收干净）', async () => {
    const signals: AbortSignal[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal)
      return sseResponse().res as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const handle = startMessageStream({ onMessage: () => {}, retryMs: 5 })
    await tick(10)
    handle.stop()
    expect(signals[0].aborted).toBe(true)
    await tick(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(handle.state()).toBe('closed')
  })

  it('状态回调按 connecting → open 走（探针要能区分"连上了"和"在重连"）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse().res as Response))
    const states: string[] = []
    const handle = startMessageStream({
      onMessage: () => {},
      onState: (s) => states.push(s),
      retryMs: 5,
    })
    await tick(10)
    handle.stop()
    expect(states[0]).toBe('connecting')
    expect(states).toContain('open')
    expect(states[states.length - 1]).toBe('closed')
  })

  it('**第一块字节**回调一次（每条连接）—— 它是"真的读得出流"的唯一见证（M1）', async () => {
    const first = sseResponse()
    const second = sseResponse()
    vi.stubGlobal('fetch', vi.fn(async () => {
      const which = fetchMockCount++ === 0 ? first : second
      return which.res as Response
    }))
    let fetchMockCount = 0
    let chunks = 0
    const handle = startMessageStream({
      onMessage: () => {},
      onFirstChunk: () => { chunks += 1 },
      retryMs: 5,
      maxRetryMs: 10,
    })
    await tick(10)
    first.push(': connected\n\n')            // 注释行也算"读到了字节"
    first.push(': ping\n\n')
    await tick(20)
    expect(chunks, '同一条连接里只许回调一次').toBe(1)

    first.close()                            // 断线 ⇒ 重连 ⇒ 新一代连接再回调一次
    await tick(80)
    second.push(': connected\n\n')
    await tick(20)
    handle.stop()
    expect(chunks, '重连后的新连接应当再报一次').toBe(2)
  })

  it('HTTP 不 ok（后端还没起 / token 不对）⇒ 不当成"连上了"，走重连', async () => {
    const states: string[] = []
    // ⚠️ 401 **带一个真的流**：只回 `body: null` 的话，`!res.body` 那一半也能拦下它
    //    ⇒ "必须看 `res.ok`"这条就没被验到（反向验证实测踩到）。
    const body = sseResponse()
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, body: body.res.body }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const handle = startMessageStream({
      onMessage: () => {},
      onState: (s) => states.push(s),
      retryMs: 5,
      maxRetryMs: 10,
    })
    await tick(60)
    handle.stop()
    expect(states).not.toContain('open')
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
