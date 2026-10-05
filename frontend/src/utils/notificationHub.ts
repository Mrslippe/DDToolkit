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

/** 面板里的动作（由渲染层映射到具体回调）
 *
 *  `ack-all`（L1）：「一键已读」—— 只清「需要处理」那一组（面板里那一组标题右侧的按钮）。 */
export type NoticeActionKind = 'open-report' | 'open-limits' | 'login' | 'dismiss' | 'ack-all'

export interface NoticeAction {
  label: string
  kind: NoticeActionKind
}

export interface Notice {
  id: string
  kind: NoticeKind
  text: string
  /**
   * **活数据**槽位（M5-1，devlog/253）：倒计时 / 进度这类"自己刷新、不重排文案"的值。
   * 后端 `GET /vtuber/notices` 的契约里就有它（目标架构 §2.2），前端先接上类型 ——
   * M5-2 切换供数方时，`text` 保持稳定、只有 `value` 在跳。
   */
  value?: string
  /**
   * **形态**（L1，2026-10-05）：`state` 现在有什么在发生 / `notice` 刚刚发生了什么 /
   * `action` 需要用户决定。分组、时长、已读方式都由它推导（`utils/noticeBoard.ts`）。
   *
   * ⚠️ 与 `kind` **正交**：`kind` 管长相（字形/点色），`form` 管行为。别拿 `kind` 推 `form`：
   * 两者今天恰好一一对应是巧合（报告曾是 alert、进度也曾经要和报告抢胶囊）。
   * 老后端没有这个字段 ⇒ 当 `state` 处理（保守：状态不自动消失、不自动已读）。
   */
  form?: 'state' | 'notice' | 'action'
  /**
   * 条目**创建时刻**（ms，服务端 `now` 口径）—— 面板要显示"3 分钟前"。
   * 状态类给的是"状态开始成立"的时刻（读作"进行中 N 分钟"）。
   * ⚠️ 缺失时**不显示相对时间**（`noticeBoard.relTime` 返回空串），不许用渲染时刻糊一个。
   */
  createdAt?: number
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

/**
 * 胶囊上的**类型字形**（D1 内容契约，2026-09-27）。
 *
 * ## 为什么类型必须有自己的通道（这是一处真缺陷的修复，不是装饰）
 *
 * 胶囊原先只有**点色**表达 kind，而渲染侧的判定是
 * `progress→busy / alert→warn / 其余→ok` —— `report` 与 `message` **落在同一个颜色上**；
 * 更要命的是胶囊**根本不渲染图标**（`KIND_ICON` 只在面板里用）。
 * ⇒ 今天"全量抓取完成"(report) 与"已复制诊断信息"(message) 在胶囊上**长得一模一样**。
 *
 * 一个字形的成本换来"类型"这个维度：`点色 = 紧迫度`、`字形 = 类型`，两者正交。
 *
 * ⚠️ 用**文本字符**而不是 lucide 图标：小窗的独立入口不加载 Tailwind，
 * `size-[12px]` 这类类名在那里无效 —— lucide 会按默认 **24px** 画（探针在小窗坐标系里
 * 实测到 `chevron=[24,24]`，比半个胶囊还高）。文本字符的尺寸只受 `font-size` 控制。
 *
 * ⚠️ 字形**必须两两不同**（`KIND_GLYPH` 有唯一性用例）：重复就等于没修。
 */
export const KIND_GLYPH: Record<NoticeKind, string> = {
  alert: '⚠',
  progress: '◔',
  report: '✓',
  message: '✦',
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

/**
 * 开播告警（M1，devlog/243）：后端推 `domain.live.edge` ⇒ 这是"该不该现在去看直播"的提示，
 * 按 R12a 的口径属于 **alert**（会影响用户下一步动作）。
 *
 * ⚠️ **必须带 TTL，不能 sticky**：alert 的优先级（4）高于 progress（3），常驻就等于
 * "开播过的那次会一直压住顶栏的任务进度"。取 2 分钟：够用户看见并决定，又不长期占位。
 * ⚠️ 面板里的顺序仍由 `pickPrimary` 决定：同一时刻多条 alert 取**最新**那条。
 *
 * L1（2026-10-05）：它是**告知类里唯一带时窗的**（`form='notice'` + 2 分钟）——
 * 胶囊与面板都会为它画倒计时（`noticeBoard.countdownFraction`）。
 */
export const LIVE_NOTICE_MS = 2 * 60_000

/**
 * **告知类**的默认展示时长（L1，设计案 §3.1）："已同步完成 / 发现新版本"这种
 * **过期无损失**的消息，读到就行；有时窗的（开播、磁盘快满）另给 `LIVE_NOTICE_MS`。
 *
 * 为什么从 4s 提到 6s：4s 的可见性其实很低 —— toast 在顶部居中且同屏 3 条，
 * 胶囊上又常常被进度占着；"看到它"需要一次主动的视线移动。6s 是"足够被看到、
 * 又不至于赖着不走"的折中，仍短于空闲轮询（10s），所以不会积压。
 * ⚠️ 后端 `services/notices.MSG_TTL_MS` 与 `noticeStream.PILL_MS` 必须同值（有用例对账）。
 */
export const EVENT_TTL_MS = 6_000

export function liveNotice(opts: {
  id: string
  name: string
  title?: string
  now: number
  ttlMs?: number
}): Notice {
  return {
    id: opts.id,
    kind: 'alert',
    form: 'notice',
    text: `${opts.name} 开播了`,
    detail: opts.title || undefined,
    source: '开播',
    createdAt: opts.now,
    expiresAt: opts.now + (opts.ttlMs ?? LIVE_NOTICE_MS),
  }
}

/** 瞬时消息（`ddtoolkit:pill-message`）：ttl 后自动消失
 *
 *  `id` / `source` 可覆盖（L3，`devlog/343`）：客户端自己发现的事实（发现新版本、磁盘快满）
 *  需要**稳定 id**（同一条不重复堆）与自己的来源标注（面板里写「磁盘」而不是「操作结果」）。
 */
export function messageNotice(text: string, now: number, ttlMs: number,
                              id?: string, source?: string): Notice {
  return {
    id: id ?? `msg-${now}`,
    kind: 'message',
    form: 'notice',
    text,
    source: source ?? '操作结果',
    createdAt: now,
    expiresAt: now + ttlMs,
  }
}
