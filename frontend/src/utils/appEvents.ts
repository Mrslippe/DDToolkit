/**
 * 全站跨组件事件表：**名字 + payload 形状**集中在这一个文件（M4，批次 12 第五刀，devlog/223）。
 *
 * 为什么值得集中：这些事件是**隐式契约** —— 右栏改了签名要通知左栏（R33 那条"改了左栏没同步"
 * 的事故）、顶栏抓取完成要通知侧栏与列表。今天它们散在 12 个文件里写成裸字符串，
 * 监听侧一律 `(e as CustomEvent<X>).detail` 手写断言 —— 改名或改 payload 时**编译器一声不吭**，
 * 只在运行时静默断开（正是 R33 那类事故的形态）。
 *
 * 现在：`emit` / `on` 都由这张表推导，改名或改 payload ⇒ **当场编译错误**；
 * 事件名本身还有一条用例逐条钉住（`scripts/ui_probe.py` 与 dev 探针仍按裸字符串派发/监听 ——
 * 那是**外部消费者**，表是给产品代码用的）。
 *
 * ⚠️ **只集中"名字与类型"，不换机制**：仍是 `window` 上的 `CustomEvent`，
 * 老的裸 `addEventListener('ddtoolkit:xxx', fn)` 写法照旧可用。
 */
import type { AccountSnapshot, VTuber } from '../api/types'
import type { StreamMessage } from './eventStream'
import type { FetchIdleKind } from './fetchIdle'

/** 事件名（唯一真源）。老的常量（`FETCH_IDLE_EVENT` / `VTUBER_UPDATED_EVENT`）现在是这里的
 *  **再导出**，避免第二份字面量。 */
export const EVENTS = {
  /** 顶栏胶囊提示（`utils/pill.ts` 是主入口） */
  pillMessage: 'ddtoolkit:pill-message',
  /** 数据变了（侧栏列表重拉） */
  dataChanged: 'ddtoolkit:data-changed',
  /** 抓取任务跑完（kind 口径见 `utils/fetchIdle.ts`） */
  fetchIdle: 'ddtoolkit:fetch-idle',
  /** 账号快照增量（就地合并，零请求刷新） */
  accountProgress: 'ddtoolkit:account-progress',
  /** 单个 V 被就地更新（左右栏同步） */
  vtuberUpdated: 'ddtoolkit:vtuber-updated',
  /** 能力/登录态变化 ⇒ 立刻重取 */
  capabilitiesRefresh: 'ddtoolkit:capabilities-refresh',
  /** 后端推送来的**一条消息**（M0b，devlog/242；信封见 `utils/eventStream.ts`） */
  message: 'ddtoolkit:message',
  /** 开播边沿（M1，devlog/243）：后端推 `domain.live.edge` ⇒ 这里转成顶栏告警 */
  liveEdge: 'ddtoolkit:live-edge',
  /** 手动任务开始（M2，devlog/244）：后端推 `notice.progress` ⇒ 点按钮的人**立刻**看到进度 */
  progress: 'ddtoolkit:progress',
} as const

/**
 * 手动任务进度（M2，devlog/244）—— 与后端 `routers/vtuber.py` 的发布点逐字对应。
 *
 * ⚠️ 它是**"抢在轮询前面"的那一份**：`fetch-status` 仍是进度的最终真源，
 * 前端只在轮询还没报到（`manual_running` 仍为 false）时用它顶上（见 TopBar 的 `pushedProgress`）。
 */
export interface PushedProgressPayload {
  /** 机器口径的任务名（`full` / `quick` / `account` / `update`…），与状态通道同一套 */
  task: string
  /** 给人看的一行文案（后端组好；前端不自己拼） */
  text: string
  /** 谁点的（`main` / `widget`；空串 = 自动档或老客户端） */
  originator?: string
}

/**
 * 开播边沿的 payload（M1，devlog/243）—— 与后端 `scheduler.py` 发布点**逐字对应**
 * （snake_case = API/表字段口径；改名要两边同时改，`messageBus.test.ts` 有一条对账用例）。
 */
export interface LiveEdgePayload {
  vtuber_id: number
  account_id: number
  platform: string
  platform_uid: string
  name: string
  live_title: string
  live_url: string
}

/** 名字 → payload。`undefined` = 该事件不带 detail（老代码派发的是裸 `Event`）。 */
export interface AppEventMap {
  'ddtoolkit:pill-message': { text: string }
  'ddtoolkit:data-changed': undefined
  'ddtoolkit:fetch-idle': { kinds: FetchIdleKind[] }
  'ddtoolkit:account-progress': AccountSnapshot[]
  'ddtoolkit:vtuber-updated': VTuber
  'ddtoolkit:capabilities-refresh': undefined
  /** 后端推送来的一条消息（原样信封：`type` / `payload` / `ts` / `seq` / `replay`） */
  'ddtoolkit:message': StreamMessage
  /** 开播边沿（已解成结构化 payload，消费方不必自己解析信封） */
  'ddtoolkit:live-edge': LiveEdgePayload
  /** 手动任务开始（抢在轮询前面的那一份进度） */
  'ddtoolkit:progress': PushedProgressPayload
}

export type AppEventName = keyof AppEventMap

/** 冻结的名单（用例逐条钉住 —— 改名要么同时改这里与用例，要么红） */
export const APP_EVENT_NAMES: readonly AppEventName[] = [
  'ddtoolkit:pill-message',
  'ddtoolkit:data-changed',
  'ddtoolkit:fetch-idle',
  'ddtoolkit:account-progress',
  'ddtoolkit:vtuber-updated',
  'ddtoolkit:capabilities-refresh',
  'ddtoolkit:message',
  'ddtoolkit:live-edge',
  'ddtoolkit:progress',
]

/** 默认宿主：`window`（调用时取，不在模块加载时取 —— 单测跑在 node 环境时没有 `window`） */
const defaultHost = (): EventTarget => window

/** 无 detail 的事件允许 `emit(name)`；有 detail 的必须把 payload 传全 */
type EmitArgs<K extends AppEventName> =
  AppEventMap[K] extends undefined
    ? [detail?: undefined, host?: EventTarget]
    : [detail: AppEventMap[K], host?: EventTarget]

/**
 * 派发。`host` 可注入（`utils/fetchIdle.ts` 的单测就是这么跑 node 环境的）。
 *
 * ⚠️ **无 payload 的事件照旧派发裸 `Event`**（今天 `data-changed` /
 * `capabilities-refresh` 就是这么发的）：`new CustomEvent(name, { detail: undefined })`
 * 会把 `detail` 归一成 **`null`**（jsdom 实测），而裸 `Event` 上根本没有 `detail`。
 * 虽然现有监听方都不读它，但"搬进集中表"不该顺手改掉这个可观察差异。
 */
export function emit<K extends AppEventName>(name: K, ...rest: EmitArgs<K>): void {
  const [detail, host = defaultHost()] = rest as [unknown, EventTarget?]
  host.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }))
}

/**
 * 订阅；返回**退订函数**（照 `utils/fetchIdle.ts::onFetchIdle` 的形状）。
 * 无 detail 的事件的监听方可以写成 `() => void`（少写参数在 TS 里是允许的）。
 */
export function on<K extends AppEventName>(
  name: K,
  cb: (detail: AppEventMap[K]) => void,
  host: EventTarget = defaultHost(),
): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<AppEventMap[K]>).detail)
  host.addEventListener(name, handler)
  return () => host.removeEventListener(name, handler)
}
