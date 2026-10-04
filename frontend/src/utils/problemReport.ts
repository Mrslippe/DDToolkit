/**
 * 面向用户的错误报告（2026-10-02，devlog/279）。
 *
 * ## 为什么要它
 *
 * 原先的错误出口是 `bootDiag.ts` 那个红色面板：标题写「启动诊断 N 条」、内容是
 * `[promise] Promise shell:allow-open not allowed…` 这种**开发者语言**，压在右上角挡住界面，
 * 也没有版本/环境/提交入口 —— 用户能做的只有截图（2026-10-02 用户原话：
 * 「我觉得可以把这个报错 log 改造成面向用户的报错日志展示，当出现类似的报错就出现，
 * 让普通用户更容易提交 bug」）。
 *
 * 现在的分工：
 * - `bootDiag.ts` 继续负责**捕获**（未捕获异常 / Promise 拒绝 / console.error / 资源失败）；
 * - 本模块负责**判定 → 去重 → 脱敏 → 生成报告**（纯逻辑，可单测）；
 * - `ProblemPanel.tsx` 负责**呈现**（右下角、不遮挡、可展开、可忽略）；
 * - 完整体检材料仍走既有入口 `GET /settings/diagnostics`（版本/OS/迁移/库形态/日志尾部），
 *   本面板只在"复制报告"里按需附上它，不另造一份。
 *
 * ## 口径
 *
 * 1. **只有真错误才惊动用户**：资源级瞬时失败（图片抖一下）只记账、不弹（沿用 bootDiag 的分级）；
 * 2. **同一错误去重计数**：同一个 `where+detail` 反复发生只显示一条 + ×N，不刷屏；
 * 3. **报告必须脱敏**：cookie / token / session / 签名头一律打码 —— 报告会被粘到公开 issue 上；
 * 4. **报告自带上下文**：版本、界面、WebView、时间、perf 时间线（用户手打这些等于放弃报告）。
 */

export type ReportKind =
  | 'error'        // 未捕获异常
  | 'promise'      // 未处理的 Promise 拒绝（命令被拒就走这里）
  | 'console'      // console.error
  | 'resource'     // 资源加载失败（默认只记账）
  | 'action'       // 我们自己包装过的动作失败（如"打开链接失败"）

export interface ReportEntry {
  id: number
  /** 首次发生时刻（epoch ms） */
  at: number
  kind: ReportKind
  /** 人话：出问题的位置（"打开链接" / "页面脚本" / "后端请求"…） */
  where: string
  detail: string
  /** 同一错误发生次数（去重后） */
  count: number
  /** 要不要惊动用户（资源抖动 = false，只进报告） */
  reportable: boolean
}

export interface ReportEnv {
  /** 应用版本（`/healthz` 带回来的；拿不到就是 null） */
  version: string | null
  /** 当前路由（如 `/vtubers/14`） */
  route: string | null
  /** 当前视图（list / cards …） */
  view: string | null
}

/** 提单地址（GitHub issue 新建页；正文预填，用户还能自己改） */
export const ISSUE_BASE = 'https://github.com/Mrslippe/DDToolkit/issues/new'

const MAX_ENTRIES = 50
/** issue URL 不能太长（浏览器/GitHub 都有上限）——预填正文截到这个长度 */
const MAX_ISSUE_BODY = 5000

const entries: ReportEntry[] = []
/** `useSyncExternalStore` 要求快照**引用稳定**：变更时才重建这一份（不能每次现 map） */
let snapshot: ReportEntry[] = []
const listeners = new Set<() => void>()
let env: ReportEnv = { version: null, route: null, view: null }
let seq = 0

/** 启动期填环境（`main.tsx` 拿到 `/healthz` 后调用；路由变化时也可刷） */
export function setReportEnv(patch: Partial<ReportEnv>): void {
  env = { ...env, ...patch }
}

export function reportEnv(): ReportEnv {
  return { ...env }
}

export function subscribeReport(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(): void {
  snapshot = entries.map((e) => ({ ...e }))
  for (const fn of listeners) fn()
}

/**
 * 记一条错误。返回条目（去重时是已有那条，`count` 已 +1）。
 *
 * `reportable=false` 只入账不弹面板（资源抖动那类；`bootDiag` 用它）。
 */
export function reportUserError(
  where: string, detail: string,
  opts: { kind?: ReportKind; reportable?: boolean } = {},
): ReportEntry {
  const kind = opts.kind ?? 'action'
  const reportable = opts.reportable ?? true
  const text = String(detail ?? '').trim() || '（没有细节）'
  const hit = entries.find((e) => e.kind === kind && e.where === where && e.detail === text)
  if (hit) {
    hit.count += 1
    hit.at = Date.now()
    notify()
    return hit
  }
  const entry: ReportEntry = {
    id: ++seq, at: Date.now(), kind, where, detail: text, count: 1, reportable,
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.shift()
  notify()
  return entry
}

/**
 * 资源失败**按主机**归并 + 阈值（2026-10-04，devlog/318）。
 *
 * 原先 `bootDiag` 用一个**全局**计数器："资源失败 ≥3 次就报一条"，而且每条都带上
 * `（连续 N 次失败）` —— 后果（用户 2026-10-04 报的"打开小红书帖子详情报错"）：
 * 一个笔记详情页里 7 张签名过期的图、每张走"直连失败 → 代理失败"两级 = 14 次
 * ⇒ 报告里 **14 条** `[resource]`，计数还是 51…64 这种看不出所以然的全局序数。
 *
 * 现在的口径：**按主机计数**，同一个主机（同一类故障）到 `RESOURCE_REPORT_AT` 次才报一条，
 * 且 `detail` 只用主机名（**稳定 ⇒ 去重**，面板显示成 `×N`）。真正的逐条 URL 仍在
 * `bootDiag` 的启动时间线里（报告会自动附上），排查不缺材料。
 */
export const RESOURCE_REPORT_AT = 3

/** 从资源 URL 取主机（相对路径/坏 URL 都退化成原串，用作 key 也够） */
export function resourceHost(src: string): string {
  try {
    return new URL(src, 'http://local.invalid').host || src
  } catch {
    return src
  }
}

/** 记一次资源失败（`bootDiag` 调）。`count` = 这个主机**累计**失败次数（含本次）。 */
export function reportResourceFailure(src: string, count: number): void {
  // 只在**跨过阈值那一次**报（同主机后续失败不再刷条目：报告里一行 + 时间线里有全部）
  if (count !== RESOURCE_REPORT_AT) return
  reportUserError('资源加载', resourceHost(src), { kind: 'resource' })
}

/**
 * `bootDiag` 的行 → 结构化条目（保持"捕获"与"呈现"解耦）。
 *
 * 行形如 `[promise] Promise shell:allow-open not allowed…`；解析不出类别时按 `console` 记。
 */
export function reportFromBootLine(line: string): void {
  const m = /^\[(error|resource|console\.error|promise)\]\s*(.*)$/s.exec(line.trim())
  if (!m) return
  const tag = m[1]
  const kind: ReportKind = tag === 'console.error' ? 'console'
    : tag === 'resource' ? 'resource'
      : tag === 'promise' ? 'promise' : 'error'
  const where = kind === 'error' ? '页面脚本'
    : kind === 'promise' ? '未处理的异步错误'
      : kind === 'console' ? 'React 渲染'
        : '资源加载'
  reportUserError(where, m[2], { kind, reportable: kind !== 'resource' })
}

/** 当前条目快照（**引用稳定**，可直接喂 `useSyncExternalStore`） */
export function reportEntries(): ReportEntry[] {
  return snapshot
}

/** 有多少条**需要惊动用户**的条目（面板据此决定露不露面） */
export function reportableCount(): number {
  return entries.filter((e) => e.reportable).length
}

export function dismissReport(id: number): void {
  const i = entries.findIndex((e) => e.id === id)
  if (i >= 0) {
    entries.splice(i, 1)
    notify()
  }
}

export function clearReports(): void {
  entries.length = 0
  notify()
}

/**
 * 脱敏：报告会被粘到公开 issue 上，凭据一律打码。
 *
 * ⚠️ 只认**模式**不认字段名（凭据可能出现在 URL、请求头、错误文本里），
 * 且**宁多勿少**：多打掉一段诊断文本的代价，远小于把 `web_session` 贴到网上。
 */
export function redact(text: string): string {
  let out = String(text ?? '')
  // key=value / "key": "value" / key: value（cookie、token、session、签名头…）
  out = out.replace(
    /\b(web_session|webid|a1|sessdata|bili_jct|dedeuserid|buvid3|buvid4|refresh_token|access_token|id_token|xsec_token|authorization|cookie|set-cookie|token|secret|password|passwd|pwd|x-s|x-s-common|x-t|signature)\b(\s*["']?\s*[:=]\s*["']?)([^\s;"',&]+)/gi,
    (_all, key: string, sep: string) => `${key}${sep}***`,
  )
  // Bearer / Basic 认证串
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
  // 长 base64 / base64url 形状（签名字段、凭据片段）
  // ⚠️ 字符集**不含 `/`**：含了会把 Windows 路径（`C:/Users/.../diagnostics-….txt`）
  //    当凭据打掉 —— 路径正是排查要用的东西
  out = out.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***')
  // ⚠️ 阈值 60（不是 40）：URL 里 `ou=`/`oi=` 这类参数值是 20~40 字符的 **ID**，打掉它们
  //    会让报告里的链接**没法复现**（2026-10-03 用户那条视频 URL 就被打成了 `oi=***`）。
  //    真正敏感的签名/凭据由上面的**按键名**规则负责。
  out = out.replace(/(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{60,}={0,2}/g, '***')
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

export function fmtWhen(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** WebView / 系统的粗信息（报告里用来判断"是不是只有某个环境出问题"） */
export function environmentLine(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const shell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? '桌面端' : '浏览器'
  return `${shell} · ${ua}`
}

export interface ReportInput {
  entries: ReportEntry[]
  env: ReportEnv
  /** 用户填的"我当时在做什么" */
  note?: string
  /** `bootDiag` 的原始行（含 `[perf]` 启动时间线） */
  trail?: string[]
  /** 可选：诊断包全文（`GET /settings/diagnostics`），默认不附 */
  bundle?: { filename: string; text: string } | null
}

/** 生成报告（markdown）——**纯函数**，单测直接喂数据 */
export function buildReportMarkdown(input: ReportInput): string {
  const { entries: rows, env: e, note, trail, bundle } = input
  const first = rows.reduce((min, r) => Math.min(min, r.at), rows[0]?.at ?? Date.now())
  const lines: string[] = []
  lines.push('## 出了点问题（自动生成的报告）')
  lines.push('')
  lines.push(`- **发生时间**：${fmtWhen(first)}`)
  lines.push(`- **应用版本**：${e.version ?? '未知（没能从后端取到）'}`)
  lines.push(`- **当前界面**：${e.route ?? '未知'}${e.view ? `（${e.view} 视图）` : ''}`)
  lines.push(`- **运行环境**：${environmentLine()}`)
  lines.push('')
  lines.push('### 我当时在做什么')
  lines.push('')
  lines.push(note?.trim() ? note.trim() : '（没填 —— 补一句能省很多来回）')
  lines.push('')
  lines.push(`### 错误明细（${rows.length} 类）`)
  lines.push('')
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. [${r.kind}] **${r.where}**${r.count > 1 ? `（×${r.count}）` : ''}`)
    lines.push('')
    lines.push('   ```')
    lines.push('   ' + redact(r.detail).replace(/\n/g, '\n   '))
    lines.push('   ```')
  })
  if (trail?.length) {
    lines.push('')
    lines.push('<details><summary>启动时间线（点击展开）</summary>')
    lines.push('')
    lines.push('```')
    lines.push(redact(trail.join('\n')))
    lines.push('```')
    lines.push('')
    lines.push('</details>')
  }
  if (bundle) {
    lines.push('')
    lines.push(`<details><summary>诊断包 ${bundle.filename}（点击展开）</summary>`)
    lines.push('')
    lines.push('```')
    lines.push(redact(bundle.text))
    lines.push('```')
    lines.push('')
    lines.push('</details>')
  }
  return lines.join('\n')
}

/** 报告第一行的标题（issue 标题用；也方便用户自己写） */
export function reportTitle(input: ReportInput): string {
  const top = input.entries[0]
  const head = top ? `${top.where}：${top.detail.split('\n')[0]}` : '运行时报错'
  return `[报错] ${head}`.slice(0, 110)
}

/** 预填好的 issue 链接（正文截断到 `MAX_ISSUE_BODY`） */
export function issueUrl(markdown: string, title: string): string {
  const body = markdown.length > MAX_ISSUE_BODY
    ? `${markdown.slice(0, MAX_ISSUE_BODY)}\n\n…（过长已截断，完整内容见「复制报告」）`
    : markdown
  const q = new URLSearchParams({ title, body, labels: 'bug' })
  return `${ISSUE_BASE}?${q.toString()}`
}
