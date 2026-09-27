/**
 * 推送通道的**传输层**（M0b，devlog/242；方案 `docs/design/notices/message-hub-execution.md` §2.1）。
 *
 * ## 为什么是 `fetch` + `ReadableStream`，而不是 `EventSource`
 *
 * 后端每个业务端点都要 `X-DDToolkit-Token`（`app/core/api_auth.py`），而浏览器原生
 * `EventSource` **不支持自定义请求头** ⇒ 它只能把 token 拼进 URL，那正是母计划 §9 的
 * **停止条件**（token 会进日志/历史）。所以这里读的是同一个 `text/event-stream`，
 * 只是换成 `fetch`：**token 走 header**，且走的是全站唯一那条 `authFetch()`
 * （`api/api.ts`）—— 不新增第二套 token 口径、不新增泄露面。
 *
 * ## 帧格式（与 `app/routers/messages.py` 对得上）
 *
 * ```
 * : connected        ← 注释行：流建起来了（心跳 `: ping` 也是注释行，都直接跳过）
 * id: 42             ← 消息序号；重连时回填到 `Last-Event-ID`
 * data: {"type":…}
 *                    ← 空行 = 一帧结束
 * ```
 *
 * ⚠️ **只有在"重连"时才带 `Last-Event-ID`**：首次打开不补发（否则每开一次窗都会重播
 * 整段历史，前端弹一串历史 toast —— 方案 §8.5 D 的定稿语义）。补发的帧里 `replay: true`，
 * 由 `messageBus.ts` 决定"不弹提示"。
 *
 * ⚠️ **本模块不认业务**：它只把帧变成 `StreamMessage`。谁关心哪种类型、谁弹提示，
 * 都在 `messageBus.ts`（这样这一层能单独测，不用拉起整个事件总线）。
 */
import { authFetch } from '../api/api'

/** 推送端点（**不带 query** —— 别给它起带 `token` 的参数名，方案 §2.1 的假红警告）。 */
export const MESSAGE_STREAM_PATH = '/messages/stream'

/** 一条消息（与后端 `services/messages.py::Message.to_json()` 同形状）。 */
export interface StreamMessage {
  type: string
  payload: Record<string, unknown>
  ts: number
  /** 进程内单调序号 —— 就是重连要回填的那个 `Last-Event-ID` */
  seq: number
  /** `true` = **重连补发**的历史消息（不是刚发生的） */
  replay: boolean
}

export type StreamState = 'connecting' | 'open' | 'closed'

/**
 * 把一段 SSE 文本切成「完整的帧」+「还没收完的尾巴」（**纯函数**，好测）。
 *
 * 尾巴必须交回调用方：网络会把一个帧切在两个 chunk 里（实测常见），
 * 自己缓存半个 JSON 去 parse 会得到一个"永远解析失败"的流。
 */
export function parseSseFrames(buffer: string): { messages: StreamMessage[]; rest: string } {
  const messages: StreamMessage[] = []
  // SSE 规范允许 \r\n / \r / \n；后端发 \n，但中间层可能改写
  const text = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lastBreak = text.lastIndexOf('\n')
  if (lastBreak < 0) return { messages, rest: text }   // 一行都没收全

  let id: string | null = null
  let data: string[] = []
  const flush = () => {
    if (data.length) {
      const parsed = toMessage(data.join('\n'), id)
      if (parsed) messages.push(parsed)
    }
    id = null
    data = []
  }

  for (const line of text.slice(0, lastBreak + 1).split('\n')) {
    if (line === '') { flush(); continue }        // 空行 = 帧边界
    if (line.startsWith(':')) continue            // 注释行（`: connected` / `: ping`）
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'id') id = value
    // `event:` / `retry:` 本项目不用 —— 忽略而不是报错（前向兼容）
  }
  return { messages, rest: text.slice(lastBreak + 1) }
}

/** 一帧的 data → `StreamMessage`；坏帧返回 `null`（**丢弃它，不打断整条流**）。 */
function toMessage(raw: string, id: string | null): StreamMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (typeof o.type !== 'string' || !o.type) return null
  const seq = typeof o.seq === 'number' ? o.seq : Number(id)
  return {
    type: o.type,
    payload: (o.payload && typeof o.payload === 'object' ? o.payload : {}) as Record<string, unknown>,
    ts: typeof o.ts === 'number' ? o.ts : 0,
    seq: Number.isFinite(seq) ? Number(seq) : 0,
    replay: o.replay === true,
  }
}

export interface StartMessageStreamOptions {
  onMessage: (msg: StreamMessage) => void
  /** 连接状态变化（探针要能区分"连上了"与"在重连"） */
  onState?: (state: StreamState) => void
  /** 第一次重连的等待；之后按 2 倍退避，封顶 `maxRetryMs` */
  retryMs?: number
  maxRetryMs?: number
  path?: string
}

export interface MessageStreamHandle {
  stop(): void
  state(): StreamState
}

/**
 * 开一条推送连接（**自动重连**）。返回句柄，`stop()` 之后不再重连。
 *
 * ⚠️ 断线是常态而不是异常（后端重启 / 更新 / 网络抖动），所以这里**不抛错**：
 * 失败就按退避重连，并把状态经 `onState` 报出去。
 */
export function startMessageStream(options: StartMessageStreamOptions): MessageStreamHandle {
  const retryMs = options.retryMs ?? 1000
  const maxRetryMs = options.maxRetryMs ?? 30_000
  const path = options.path ?? MESSAGE_STREAM_PATH

  let stopped = false
  let state: StreamState = 'connecting'
  let lastEventId: number | null = null
  let ctrl: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const setState = (s: StreamState) => {
    state = s
    options.onState?.(s)
  }

  const reconnect = (attempt: number) => {
    if (stopped) return
    // 退避封顶：后端长时间不可用时不该变成"每秒敲一次"
    const wait = Math.min(maxRetryMs, retryMs * 2 ** Math.min(attempt, 6))
    timer = setTimeout(() => { void connect(attempt + 1) }, wait)
  }

  const connect = async (attempt = 0): Promise<void> => {
    if (stopped) return
    const ac = new AbortController()
    ctrl = ac
    setState('connecting')
    let buffer = ''
    let opened = false
    let received = 0
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      // ⚠️ 只有"重连"才带它：首连带上就等于每次都重播历史（方案 §8.5 D）
      if (lastEventId !== null) headers['Last-Event-ID'] = String(lastEventId)
      const res = await authFetch(path, { headers, signal: ac.signal, cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error(`推送通道不可用（HTTP ${res.status}）`)
      opened = true
      setState('open')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { messages, rest } = parseSseFrames(buffer)
        buffer = rest
        for (const msg of messages) {
          if (msg.seq) lastEventId = msg.seq
          received += 1
          options.onMessage(msg)
        }
      }
    } catch {
      // 网络错 / 被 abort / 后端 500：都走下面的重连（stop() 时另有分支）
    }
    ctrl = null
    if (stopped) { setState('closed'); return }
    // 收到过东西 = 这一轮算"连通过"，退避归零（否则一次成功后的短暂抖动会越等越久）
    reconnect(received > 0 || opened ? 0 : attempt)
  }

  void connect(0)

  return {
    state: () => state,
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      ctrl?.abort()
      setState('closed')
    },
  }
}
