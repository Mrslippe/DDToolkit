/**
 * API 层的两种错误（Q1，批次 13，devlog/216）。
 *
 * ## 为什么要有它们（改前的事实）
 * `api.ts` 失败时抛的是**裸 `Error(detail)`**：HTTP 状态、后端 detail、出错的路径全丢了。
 * 调用方只能靠"响应体里有没有 `status:'skipped'`"绕行（那 6 处走的是**成功响应体**，
 * 不是错误），而 409 / 422 / 风控这类**可判别的失败**在 HTTP 层完全分不出来 ——
 * 于是界面上的文案只能统一成"加载失败"。
 *
 * ## 兼容约束（改之前逐条审过调用方）
 * 全仓 `catch` 分支几乎只读 `(e as Error).message`（121 处命中里绝大多数是这个形态），
 * 还有几处判 `e.name === 'AbortError'`。所以：
 *   · 两个类都 **extends Error** ⇒ `instanceof Error` / `.message` 全部照旧；
 *   · `message` 的文案**与改前逐字一致**（含 401 那句"应用若刚重启，请重开窗口"）；
 *   · 取消（AbortError）**不经过这里**，`fetch` 直接 reject，`name` 仍是 `AbortError`。
 */

/** 后端返回了非 2xx：这是**可判别的**失败（status/detail/path 都在）。 */
export class ApiError extends Error {
  /** HTTP 状态码（401 令牌 / 403 / 404 / 409 冲突 / 413 过大 / 415 类型 / 422 校验 / 503 …） */
  readonly status: number
  /** 后端 `{"detail": …}` 的**原文**（拿不到时退回 `"<status> <statusText>"`）——机器可读那一份 */
  readonly detail: string
  /** 请求路径（排查时"哪一发失败了"的唯一线索） */
  readonly path: string

  /**
   * `message` 是**给人看的**那一份：默认等于 `detail`，401 会额外加一句排查提示
   * （"应用若刚重启，请重开窗口"）—— 与改前的文案逐字一致，旧调用方直接展示它。
   */
  constructor(status: number, detail: string, path: string, message?: string) {
    super(message ?? detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.path = path
  }

  /** 401 = 令牌没注入/过期（本应用里 401 **只可能**是认证）。 */
  get isAuth(): boolean {
    return this.status === 401
  }

  /** 409/422 = 业务上"不让你这么干"（冲突 / 校验），文案通常可直接展示给用户。 */
  get isClientRejection(): boolean {
    return this.status === 409 || this.status === 422
  }
}

/**
 * 服务端 **2xx 但响应形状不对**（或不是 JSON）。
 *
 * ⚠️ 它对应改前的两个真实毛病：① `JSON.parse` 没有 try/catch ⇒ 非 JSON 响应抛**裸
 * `SyntaxError`**，而调用方按 `e.name === 'AbortError'` 分流 ⇒ 会被当成业务错误弹 toast；
 * ② `JSON.parse(...) as T` 是**纯断言** ⇒ 后端把字段改名/改嵌套时，界面拿到 `undefined`
 * 继续渲染（空白/`NaN`），一路静默。
 */
export class ApiShapeError extends Error {
  readonly path: string
  readonly detail: string
  /** 实际拿到的值（**截断**过：诊断要，但别把整页数据塞进 toast/日志） */
  readonly received: string

  constructor(path: string, detail: string, received: unknown) {
    super(`${path} 的响应形状不对：${detail}`)
    this.name = 'ApiShapeError'
    this.path = path
    this.detail = detail
    this.received = describe(received)
  }
}

/** 把任意值压成一小段可读文本（诊断用）。 */
export function describe(value: unknown): string {
  let text: string
  if (typeof value === 'string') text = JSON.stringify(value)
  else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
