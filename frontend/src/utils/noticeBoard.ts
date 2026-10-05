/**
 * 通知的**三形态 / 分组 / 相对时间 / 同级合并**（L1，`docs/design/notices/channel-and-layering.md`）。
 *
 * ## 为什么要有这个模块（而不是继续往 `notificationHub` 里塞）
 *
 * `notificationHub` 管的是**一条通知是什么**（字段、优先级、过期判定）；
 * 这里管的是**一组通知怎么呈现**（分几组、胶囊上那句话怎么写、时间怎么念）。
 * 两者都会单独长：前者跟着后端契约走，后者跟着用户口径走 —— 混在一处的结果是
 * 每次调呈现都要动契约层的用例。
 *
 * ## 三个形态（与 `kind` 正交，别拿 `kind` 推）
 *
 * | 形态 | 回答 | 活多久 | 已读 |
 * |---|---|---|---|
 * | `state` | 现在有什么在发生 | 与事实同寿命（任务结束/冷却结束） | 无需已读（事实变了就没了） |
 * | `notice` | 刚刚发生了什么 | TTL（见 `EVENT_TTL_MS` / `LIVE_NOTICE_MS`） | 自动已读（到期即从胶囊撤） |
 * | `action` | 需要用户决定 | 常驻到用户确认 | **只能用户确认**（落库） |
 *
 * ⚠️ `state` **不许自动已读**：它消失是**事实变了**，不是"用户看过了" ——
 * 记成已读会在"同一条状态再次成立"时误判（例如再次限流）。
 */
import type { Notice } from './notificationHub'
import { isLive } from './notificationHub'

/** 三个形态（与后端 `services/notices.py` 的 `FORM_*` 逐字对齐） */
export type NoticeForm = 'state' | 'notice' | 'action'

/** 面板里的三组（顺序即显示顺序） */
export type NoticeGroup = 'doing' | 'todo' | 'recent'

export const GROUP_ORDER: readonly NoticeGroup[] = ['doing', 'todo', 'recent']

export const GROUP_LABEL: Record<NoticeGroup, string> = {
  doing: '正在进行',
  todo: '需要处理',
  recent: '最近',
}

/**
 * 形态 → 分组。
 *
 * 为什么要按**形态**分组而不是按 `kind`：`kind` 说的是"这条消息像什么"（告警/进度/报告/提示），
 * 而用户打开面板时问的是"**现在在发生什么**（doing）/ **有什么要我做的**（todo）/
 * **刚刚发生了什么**（recent）" —— 同一组里可以混着不同 `kind`（例如 doing 组里既有
 * progress 的抓取进度，也有 alert 的风控冷却）。分成三个列表之后，"状态被事件顶掉"
 * 这个问题从根上不存在了（它们不再竞争同一个位置）。
 */
export function groupOf(n: Notice): NoticeGroup {
  if (n.form === 'action') return 'todo'
  if (n.form === 'notice') return 'recent'
  return 'doing'
}

/**
 * 组内排序（数值越小越靠前）。**换过判据**（设计案 §3.2）：
 * 原判据是"类型"（alert>progress>report>message），后果是**同类互顶**且
 * "有时窗的"与"没时窗的"排不出先后；新判据是「过期会不会丢信息 / 用户要不要动手」。
 */
export const TIER: Record<string, number> = {
  'alert:live': 0,       // 有时窗：过期就没了（开播）
  'alert:limit': 1,      // 正在被限流（用户此刻做什么都会失败）
  'state': 2,            // 进行中的状态：用户要知道"有没有在跑"
  'action': 3,           // 需要用户决定（完成报告）
  'notice': 4,           // 告知：读到就行
  'message': 5,          // 回执（多数走 toast，留在面板里的排最后）
}

/** 一条通知的排序档（导出以便用例逐条钉住，而不是只看最终顺序） */
export function tierOf(n: Notice): number {
  if (n.id === 'rate-limit') return TIER['alert:limit']
  if (n.form === 'notice' && n.kind === 'alert') return TIER['alert:live']
  if (n.form === 'action') return TIER.action
  if (n.form === 'notice') return TIER.notice
  if (n.kind === 'message') return TIER.message
  return TIER.state
}

export interface NoticeSection {
  group: NoticeGroup
  label: string
  items: Notice[]
  /** 胶囊上代表这一组的那句话（多条时是合并后的） */
  headline: string
}

/** 按形态分组 + 组内排序（`now` 用来滤掉过期条目） */
export function sectionNotices(list: Notice[], now: number): NoticeSection[] {
  const live = list.filter((n) => isLive(n, now))
  const buckets: Record<NoticeGroup, Notice[]> = { doing: [], todo: [], recent: [] }
  for (const n of live) buckets[groupOf(n)].push(n)
  return GROUP_ORDER
    .map((group) => {
      // 档位相同的按**新的在前**（同级里用户最关心刚发生的）
      const items = buckets[group]
        .slice()
        .sort((a, b) => tierOf(a) - tierOf(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
      return { group, label: GROUP_LABEL[group], items, headline: headlineOf(items) }
    })
    .filter((s) => s.items.length > 0)
}

/**
 * 一组 → 胶囊上的一句话（**同级合并**，设计案 §3.2）。
 *
 * 为什么必须合并：原口径"同级取最新一条"会**白丢信息** —— 两个任务同时跑只显示一个，
 * 两场同时开播只显示后一场。用户关心的是"有东西在跑"，不是"哪一条在跑"。
 */
export function headlineOf(items: Notice[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0].text
  const first = items[0]
  // doing：全是进度时合并成"帖子·账号 抓取中 - V名 - 3/11"这种读法
  if (first.form === 'state') {
    if (items.every((n) => n.kind === 'progress')) {
      const kinds = mergeProgressKinds(items)
      const who = items.find((n) => n.text.includes(' - '))?.text.split(' - ')[1]
      const idx = items.find((n) => / \d+\/\d+$/.test(n.text))?.text.match(/ (\d+\/\d+)$/)?.[1]
      return [kinds, who, idx].filter(Boolean).join(' - ')
    }
    return `${items.length} 项状态 · ${first.text}`
  }
  if (first.form === 'notice' && first.kind === 'alert') {
    return `${items.length} 场开播 · ${items.map((n) => n.text.replace(/ 开播了$/, '')).join('、')}`
  }
  return `${items.length} 条 · ${first.text}`
}

/** 进度条目的任务名合并（`帖子抓取中` + `全量抓取中` → `帖子·全量 抓取中`） */
function mergeProgressKinds(items: Notice[]): string {
  const names = items.map((n) => n.text.split(' - ')[0].replace(/抓取中$/, '').trim())
  if (names.every((x) => x === names[0])) return `${names[0]} 抓取中`
  return `${[...new Set(names)].join('·')} 抓取中`
}

/** 胶囊显示哪一组的哪一条：**分组优先**（doing > todo > recent），组内取排好的第一条 */
export function pickHeadline(list: Notice[], now: number): Notice | null {
  const sections = sectionNotices(list, now)
  return sections[0]?.items[0] ?? null
}

/** 胶囊文案（取头部那条；多条时用合并句） */
export function capsuleText(list: Notice[], now: number): string {
  const s = sectionNotices(list, now)[0]
  return s ? s.headline : ''
}

/** 面板里"某一组有没有可一键已读的东西"（只有 todo 组有「一键已读」） */
export function todoIds(list: Notice[], now: number): string[] {
  const s = sectionNotices(list, now).find((x) => x.group === 'todo')
  return s ? s.items.map((n) => n.id) : []
}

// ── 相对时间 ────────────────────────────────────────────────────────────

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * 相对时间（面板 meta 行）。粒度按**读起来有没有用**定，不按"能不能更精确"：
 * 10s 内说"刚刚"（说"3 秒前"只会让人以为在倒计时），1 分钟内按秒，之后按分/时/天。
 * ≥7 天直接给日期 —— "9 天前"对用户没有信息量，日期反而能对上记忆。
 *
 * ⚠️ `at` 缺失（老后端没给 `createdAt`）⇒ 返回空串：**不猜**。
 * 用渲染时刻糊一个"刚刚"是最坏的做法 —— 它会让一条三天前的通知永远显示"刚刚"。
 */
export function relTime(at: number | null | undefined, now: number): string {
  if (!at || !Number.isFinite(at)) return ''
  const d = Math.max(0, now - at)
  if (d < 10_000) return '刚刚'
  if (d < MIN) return `${Math.floor(d / 1000)} 秒前`
  if (d < HOUR) return `${Math.floor(d / MIN)} 分钟前`
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时前`
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} 天前`
  const dt = new Date(at)
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`
}

/** 状态类的"进行中 N 分钟"（比"3 分钟前"贴事实：状态是从那时起一直在发生） */
export function relTimeFor(n: Notice, now: number): string {
  const base = relTime(n.createdAt, now)
  if (!base) return ''
  if (n.form === 'state') {
    return base === '刚刚' ? '进行中' : `进行中 ${base.replace(/前$/, '')}`
  }
  return base
}

// ── 倒计时（自动已读的可视化） ────────────────────────────────────────────

/**
 * 自动已读的剩余比例（1 → 0；`null` = **这条不会自动消失**）。
 *
 * ⚠️ 只有 `form === 'notice'` **且** 真的带 `expiresAt` 的条目才给比例：
 * 进度类/处置类**不许**画倒计时条 —— 那会误导成"任务会自己消失"（设计案 §10）。
 */
export function countdownFraction(n: Notice, now: number): number | null {
  if (n.form !== 'notice') return null
  if (n.expiresAt === undefined || n.expiresAt === null) return null
  if (!n.createdAt) return null
  const span = n.expiresAt - n.createdAt
  if (span <= 0) return null
  const left = n.expiresAt - now
  if (left <= 0) return 0
  return Math.min(1, left / span)
}

/** 胶囊左侧圆盘要不要画（同上：只有会自动消失的条目才画环） */
export function discFraction(n: Notice | null, now: number): number | null {
  return n ? countdownFraction(n, now) : null
}
