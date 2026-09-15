/**
 * 顶栏通知中心（R12a，devlog/089）：把"顶栏该显示什么"从散落的 if 里收成**纯逻辑**。
 *
 * 背景：改造前顶栏是**三套并存**——轮询算出来的任务胶囊、`ddtoolkit:pill-message` 瞬时覆写、
 * 全量抓取完成的 AlertDialog；风控冷却甚至**只在日志里**。于是"什么信息该出现、谁压过谁"
 * 全靠散在组件里的分支，谁也没法单测。
 *
 * 这里只做**判定**（渲染留给 `StatusIsland`）：条目模型、优先级、过期、命名规则。
 * 三类错法都是"界面说错话"，肉眼很难发现，所以每条规则都有用例：
 *   ① **自动节拍占顶栏**：动态流每轮 ~80s 一直跑，若当"进度"显示，顶栏会永远亮着
 *      （2026-09-10 用户口径：频繁轮询不必占顶栏）→ `progressNotice` 对 `auto` 直接返回 null；
 *   ② **瞬时消息压过正在跑的任务**：用户在抓取途中会看不到进度 → 优先级把 progress 放在 message 之上；
 *   ③ **过期条目不清**：瞬时消息到点必须自己消失，否则面板越堆越长。
 */

export type NoticeKind = 'alert' | 'progress' | 'report' | 'message'

/** 面板里的动作（由渲染层映射到具体回调） */
export type NoticeActionKind = 'open-report' | 'open-limits' | 'login' | 'dismiss'

export interface NoticeAction {
  label: string
  kind: NoticeActionKind
}

export interface Notice {
  id: string
  kind: NoticeKind
  text: string
  /** 面板里的补充说明（可选） */
  detail?: string
  /** 来源标注（面板里显示，如「风控冷却」「登录态」），让用户知道话是谁说的 */
  source?: string
  /** 常驻：不因时间过期，只能被来源撤回或用户确认 */
  sticky?: boolean
  /** 过期时刻（ms，`Date.now()` 口径）；未设 = 不过期 */
  expiresAt?: number
  action?: NoticeAction
}

/** 优先级：数值越大越优先（`pickPrimary` 用） */
export const KIND_PRIORITY: Record<NoticeKind, number> = {
  alert: 4,      // 风控冷却、登录失效、能力受限 —— 会影响用户下一步动作
  progress: 3,   // 正在跑的任务（手动/收录/外部批次）：有起点有终点
  report: 2,     // 完成报告（全量抓取）：要用户看一眼，但不挡路
  message: 1,    // 操作成功的瞬时提示
}

/** 是否还该显示（非 sticky 且过期的条目自动淡出） */
export function isLive(n: Notice, now: number): boolean {
  if (n.sticky) return true
  return n.expiresAt === undefined || n.expiresAt > now
}

export function liveNotices(list: Notice[], now: number): Notice[] {
  return list.filter((n) => isLive(n, now))
}

/** 面板外那一行显示谁：优先级最高的；同级取**最新**（数组后者，来源按时间追加） */
export function pickPrimary(list: Notice[], now: number): Notice | null {
  let best: Notice | null = null
  for (const n of liveNotices(list, now)) {
    if (!best || KIND_PRIORITY[n.kind] >= KIND_PRIORITY[best.kind]) best = n
  }
  return best
}

/** 顶栏容器是否该「亮起」（有事发生）——空闲时只有一个绿点 */
export function shouldLightUp(list: Notice[], now: number): boolean {
  const p = pickPrimary(list, now)
  return !!p && p.kind !== 'message' ? true : !!p
}

/**
 * 任务文案：`任务名 - V名 - i/N`（P8-C 格式，2026-09-10 用户定）。
 * 空段自动跳过；`total<=0` 时不显示进度。
 */
export function composeTaskText(
  taskLabel: string,
  who?: string | null,
  index?: number | null,
  total?: number | null,
): string {
  const parts = [taskLabel]
  if (who) parts.push(String(who))
  if (total && total > 0) parts.push(`${index ?? 0}/${total}`)
  return parts.join(' - ')
}

/**
 * 进度条目（**自动节拍直接返回 null** —— 见文件头 ①）。
 * `auto=true` 表示本次运行由定时档发起（动态流/自动账号流）：没有终局，不该占顶栏。
 */
export function progressNotice(opts: {
  id: string
  running: boolean
  auto: boolean
  text: string
}): Notice | null {
  if (!opts.running || opts.auto) return null
  return { id: opts.id, kind: 'progress', text: opts.text, source: '任务进度' }
}

/** 风控冷却告警（后端 `fetch_status.rate_limit`）：冷却结束自动消失（用 expiresAt 表达） */
export function rateLimitNotice(
  rl: { active: boolean; reason: string; seconds_left: number } | null | undefined,
  now: number,
): Notice | null {
  if (!rl?.active) return null
  const secs = Math.max(0, Math.round(rl.seconds_left))
  return {
    id: 'rate-limit',
    kind: 'alert',
    text: `上游限流：冷却中（还剩 ${secs}s）`,
    detail: rl.reason || undefined,
    source: '风控冷却',
    expiresAt: now + secs * 1000,
  }
}

/** 登录失效告警（B 站会话过期）：常驻到用户重新登录 */
export function loginNotice(needsLogin: boolean): Notice | null {
  if (!needsLogin) return null
  return {
    id: 'login-expired',
    kind: 'alert',
    text: 'B 站登录已失效',
    detail: '抓取会跳过需要登录的部分；重新扫码后自动恢复',
    source: '登录态',
    sticky: true,
    action: { label: '去登录', kind: 'login' },
  }
}

/** 完成报告（全量抓取）：常驻，直到用户查看或点「知道了」 */
export function reportNotice(opts: {
  id: string
  text: string
  detail?: string
}): Notice {
  return {
    id: opts.id,
    kind: 'report',
    text: opts.text,
    detail: opts.detail,
    source: '完成报告',
    sticky: true,
    action: { label: '查看详情', kind: 'open-report' },
  }
}

/** 瞬时消息（`ddtoolkit:pill-message`）：ttl 后自动消失 */
export function messageNotice(text: string, now: number, ttlMs: number): Notice {
  return {
    id: `msg-${now}`,
    kind: 'message',
    text,
    source: '操作结果',
    expiresAt: now + ttlMs,
  }
}
