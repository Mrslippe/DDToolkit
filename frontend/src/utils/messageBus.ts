/**
 * 消息中心的**前端桥**（M0b，devlog/242）：把推送来的消息接到应用事件总线上。
 *
 * ## 分工
 *
 * - `utils/eventStream.ts`：**传输层**（SSE over fetch、重连、帧解析）—— 不认业务；
 * - 本模块：**分发层** —— 认类型、发事件、决定"要不要弹提示"；
 * - `appEvents.ts`：事件名与 payload 的**唯一真源**（改名字当场编译错）。
 *
 * ## 三条定稿语义（都有判据，别顺手改）
 *
 * 1. **每条消息都发 `ddtoolkit:message`**（原样信封，含 `replay`）：M1–M5 的订阅方挂在这上面，
 *    以后加消费者不用动本模块。
 * 2. **`replay: true` 的消息不弹提示**（方案 §8.5 D）：重连补发的是历史，
 *    弹出来就是"每次断线重连重播一串旧 toast"。
 * 3. **类型字符串是跨语言契约**：后端 `app/services/messages.py::KNOWN_TYPES` 与这里的
 *    `KNOWN_MESSAGE_TYPES` 必须逐字一致 —— 后端拼错会当场 `ValueError`，
 *    前端拼错只会**静默没人理**，所以对账落在 `messageBus.test.ts`。
 *
 * ⚠️ 与 `fetch-status` 轮询**并存**：推送会漏（重连窗口），轮询是兜底。本模块不退役任何轮询。
 */
import { authFetch } from '../api/api'
import { EVENTS, emit, type LiveEdgePayload } from './appEvents'
import { startMessageStream, type MessageStreamHandle, type StreamMessage } from './eventStream'

export type BusMessage = StreamMessage

/** 后端 `KNOWN_TYPES` 的镜像（八类：四个领域事件 + 四个派生通知）。 */
export const KNOWN_MESSAGE_TYPES = [
  'domain.vtuber.updated',
  'domain.account.snapshot',
  'domain.posts.changed',
  'domain.live.edge',
  'notice.progress',
  'notice.alert',
  'notice.report',
  'notice.message',
] as const

/** 瞬时消息：今天走顶栏胶囊（`utils/pill.ts` 那条路），所以它就是"该弹提示"的那一类。 */
const MSG_NOTICE_MESSAGE = 'notice.message'

/** 开播边沿（M1）：后端 `scheduler.py` 在 T0 检测到 `live_status` 0→1 时发。 */
const MSG_LIVE_EDGE = 'domain.live.edge'

/** 开播 payload 的**必需字段**（后端改名而这里没改 ⇒ 宁可当成"解不出来"也不发半个事件）。 */
const LIVE_EDGE_FIELDS = [
  'vtuber_id', 'account_id', 'platform', 'platform_uid', 'name', 'live_title', 'live_url',
] as const

/** 把信封的 payload 解成 `LiveEdgePayload`；缺字段返回 null（**不发半个事件**）。 */
export function parseLiveEdge(payload: Record<string, unknown> | undefined): LiveEdgePayload | null {
  if (!payload) return null
  for (const f of LIVE_EDGE_FIELDS) {
    if (payload[f] === undefined || payload[f] === null) return null
  }
  return {
    vtuber_id: Number(payload.vtuber_id),
    account_id: Number(payload.account_id),
    platform: String(payload.platform),
    platform_uid: String(payload.platform_uid),
    name: String(payload.name),
    live_title: String(payload.live_title ?? ''),
    live_url: String(payload.live_url ?? ''),
  }
}

type Host = EventTarget

/** 事件宿主：默认 `window`；测试注入一个干净的 `EventTarget`（同 `fetchIdle.ts` 的路数）。 */
function defaultHost(): Host {
  return window
}

/**
 * 一条消息 → 应用事件。**纯分发**（不碰网络、不碰 DOM），所以能在 node 环境里逐条测。
 */
export function bridgeMessage(msg: BusMessage, host: Host = defaultHost()): void {
  emit(EVENTS.message, msg, host)
  if (msg.replay) return                      // 补发：不弹提示（定稿语义 ②）
  if (msg.type === MSG_LIVE_EDGE) {
    // 开播边沿（M1）：解成结构化 payload 再发 —— 消费方（TopBar → 状态岛）不该自己解析信封。
    // ⚠️ 补发（replay）在上一行就返回了：重连不该把"几小时前就开播了"再播一遍。
    const edge = parseLiveEdge(msg.payload)
    if (edge) emit(EVENTS.liveEdge, edge, host)
    return
  }
  if (msg.type !== MSG_NOTICE_MESSAGE) return // 别的类型各有消费者，M2–M5 里接
  const text = typeof msg.payload?.text === 'string' ? msg.payload.text : ''
  if (text) emit(EVENTS.pillMessage, { text }, host)
}

// ── 进程内单例（应用启动时开一条，别开第二条）─────────────────────────────

let handle: MessageStreamHandle | null = null
let received = 0
let last: BusMessage | null = null

/**
 * 告诉后端"客户端**真的读到流了**"（M1，devlog/243）。
 *
 * 每条连接发一次（由 `eventStream` 的 `onFirstChunk` 触发）。为什么需要它：M0 的停止条件
 * 是"真机 WebView2 里读得出流吗"，而**服务端看不见这件事** —— 连接建起来 ≠ 读得到字节。
 * 这条 ack 让真机验收在日志里一句话可查：
 * `推送通道：客户端已确认读到流`。
 *
 * ⚠️ 失败**静默**：它只是见证，不该因为一次网络抖动弹错或影响任何业务流程。
 */
function ackStreamRead(): void {
  void authFetch('/messages/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: last?.seq ?? 0 }),
  }).catch(() => undefined)
}

/** 开推送连接（**幂等**：重复调用不会开第二条）。 */
export function startMessageBus(): void {
  if (handle) return
  handle = startMessageStream({
    onMessage: (msg) => {
      received += 1
      last = msg
      bridgeMessage(msg)
    },
    onFirstChunk: ackStreamRead,
  })
  installDevHook()
}

/** 收摊（HMR / 单测 / 卸载）。之后可以再 `startMessageBus()`。 */
export function stopMessageBus(): void {
  handle?.stop()
  handle = null
}

/** 当前连接状态（探针要能区分"连上了"和"在重连"）。 */
export function messageBusState(): string {
  return handle ? handle.state() : 'closed'
}

/**
 * dev 钩子（与 `__ddtoolkitAuthDiag` / `__ddtoolkitShellHidden` 同路数）。
 *
 * 为什么探针需要它：页面里"看起来有数据"与"推送真的到了"长得一模一样 ——
 * 没有这个钩子，探针只能断言"某个 DOM 变了"，而那可能来自轮询。
 * 生产构建里 `import.meta.env.DEV` 为 false ⇒ 这段被摇掉。
 */
function installDevHook(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  const w = window as unknown as {
    __ddtoolkitMessageStream?: () => Record<string, unknown>
  }
  w.__ddtoolkitMessageStream = () => ({
    state: messageBusState(),
    received,
    lastType: last?.type ?? null,
    lastSeq: last?.seq ?? null,
    lastReplay: last?.replay ?? null,
    lastPayload: last?.payload ?? null,
  })
}
