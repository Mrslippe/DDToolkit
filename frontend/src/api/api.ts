import type { Account, AccountStatSnapshot, AppSettings, AppSettingsSaved, BiliSearchResult, Capabilities, FanTrendPoint, FetchPostsResult, FetchResult, FetchStatus, LiveDanmakuInfo, LiveSession, LiveSessionDetail, LiveUpstream, PoolItem, PostPage, PostStats, Prefs, PrefsSaved, ProfileCardInput, ProfileCardRow, StorageActionResult, StorageInfo, ThirdpartyVtuber, UpcomingReservation, UpdatePostsResult, VTuber, VTuberFormerValues, VtuberEvent } from './types'

/**
 * API 基地址：
 * - Web 开发默认走 Vite 代理（/api → http://127.0.0.1:8000，见 vite.config.ts）
 * - 也可用 VITE_API_BASE 直连后端（如 http://127.0.0.1:8000）
 * - 桌面端（Tauri）启动时通过 setApiBase 注入 sidecar 实际端口
 */
export const DEFAULT_API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

let apiBase = DEFAULT_API_BASE

/** 桌面端引导完成后注入真实后端基地址 */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, '')
}

export function getApiBase(): string {
  return apiBase
}

// ── S1（devlog/202）：会话 token 与启动闸门 ─────────────────────────────────
//
// ## token
// 后端每个业务端点都要求 `X-DDToolkit-Token`（`app/core/api_auth.py`），
// 而 token 由 Tauri **每次启动生成** —— 前端只能经 `get_api_token` 命令拿到。
// 开发态（浏览器/探针，没有 Tauri）则用构建期注入的固定值，见下面的 `DEV_API_TOKEN`。
//
// ## 为什么要"闸门"
// `main.tsx` 的 `Root` 在 `state !== 'pending'` 时就挂载 `<Main/>`，而 `setApiBase` /
// token 都在**异步**的 `tauriBootstrap` 里。原先能工作靠的是"启动幕那 750ms 里没有业务
// 请求自动发出"这个**时序巧合**；加 token 之后多一次 `invoke`，只会更晚 ⇒ 必须有闸门。
// 表现上：任何在挂载时自动发请求的组件（`useUpdateCheck` / 状态岛轮询 / 列表取数）
// 都会在闸门开之前**挂住**，而不是打出一个必然 401 的请求。
const TOKEN_HEADER = 'X-DDToolkit-Token'

/**
 * 开发态固定 token（**只在 `import.meta.env.DEV` 下用得上**）。
 *
 * 环境变量经 `vite.config.ts` 的 `define` 注入；默认值与
 * `scripts/ui_probe.py` 的 `PROBE_DEV_TOKEN` **必须一致** ——
 * 两边不一致的症状是"探针页面所有数据为空 ⇒ 布局断言集体报红"，
 * 而看起来像布局坏了（2026-09-25 真实踩过一次，见 devlog/201 §四）。
 */
export const DEV_API_TOKEN: string =
  (import.meta.env.VITE_DEV_API_TOKEN as string | undefined) ?? 'dsh-ui-probe-dev-token'

let apiToken: string = import.meta.env.DEV ? DEV_API_TOKEN : ''

/** 注入本次启动的会话 token（桌面端由 `get_api_token` 拿到）。 */
export function setApiToken(token: string): void {
  apiToken = token
  openGate()
}

/**
 * 声明"这个环境不需要 token"（浏览器里**确实没有** token 时）。
 *
 * ⚠️ 它会**清空** `apiToken` —— 语义是"这个环境本来就不该带 token"。
 * 所以**不能无条件调它**：2026-09-25 实测踩到，`main.tsx` 的浏览器分支无条件调了一次，
 * 把开发态那份明明已经就位的 token 抹掉 ⇒ 后端逐条 401，
 * 而页面表现是"数据全空 ⇒ 布局断言集体报红"。
 * ⇒ 开发态已经有 token 时请用 `markTokenReady()`（只开闸、不动 token）。
 */
export function markNoTokenRequired(): void {
  apiToken = ''
  openGate()
}

/** 开闸但**不动** `apiToken`（开发态已经有 token 时用这个）。 */
export function markTokenReady(): void {
  openGate()
}

// ⚠️ **闸门只在桌面端（Tauri）关着**（2026-09-25 实测定的）。
//
// 闸门存在的唯一理由是"等 `tauriBootstrap` 把端口与 token 注入进来" —— 那是**异步**的。
// 浏览器里没有任何东西要等（`apiBase` 是 `/api` 或 `VITE_API_BASE`，token 是构建期常量），
// 所以**一开始就该是开的**。
//
// 实测踩到：原先两个入口都在模块加载时无条件 `holdApiUntilReady()`，而
// `frontend/src/dev/probe.ts` 是**模块加载就 `runUiProbe()`**（不等 React effect）
// ⇒ 它那几个 `authFetch` 卡在闸门上**永远不返回**（虚拟时间下更明显），
// 表现为"探针没量到 fetch-status ⇒ 顶栏展示策略判不了"，
// 而看起来像产品坏了。修法是让"需不需要等"由环境本身决定，而不是靠调用方记得。
//
// ⚠️ 必须 `typeof window !== 'undefined'` 兜一层：`api.ts` 也被 vitest 在 **node 环境**
// 下 import（本仓没有 jsdom），直接写 `window` 会让**整个测试文件收集失败**
// （`ReferenceError: window is not defined`）。
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * 测试专用：让 `holdApiUntilReady()` 在非 Tauri 环境里也生效。
 *
 * 为什么要它：闸门**只对桌面端有意义**（见上），而 vitest 跑在 node 环境下 ——
 * 直接测"关闸后请求挂住"就永远测不到那条分支（`holdApiUntilReady` 会直接 return）。
 * 有了这个开关，那条契约仍有机器判据；**生产代码从不调它**。
 */
let tauriOverrideForTest = false
export function __setTauriForTest(v: boolean): void {
  tauriOverrideForTest = v
}

function inTauri(): boolean {
  return isTauri || tauriOverrideForTest
}

let releaseGate: () => void = () => {}
/**
 * 闸门初始**开着**（2026-09-25 定的）。
 *
 * 第一版是关的、靠 `setApiToken` / `markNoTokenRequired` 去开 —— 结果**测试里第一条用例
 * 直接挂死 5 秒**（`afterEach` 还没跑过，没人开闸）。这暴露的是真实风险：
 * 任何**新的调用方**（或新的测试文件）只要忘了开闸，症状就是"请求静静地挂着"，
 * 比 401 更难查（没有报错、没有日志）。
 *
 * 契约改成：**默认放行；`holdApiUntilReady()` 才是"我要等注入"的显式声明**，
 * 由两个入口（`main.tsx` / `widgetMain.tsx`）在**最早期**调用。
 * 这样"忘了开闸"最多退化成旧行为（可能打一个 401），而不会把应用挂死。
 *
 * ⚠️ **`gate` 与 `gateOpen` 必须一起维护**：第二版把它们写岔了 —— `gateOpen` 初值 true
 * 而 `gate` 是一个**永不 resolve** 的 pending promise ⇒ `request()` 里的 `await gate`
 * **永远不返回**，整个应用所有请求全部挂死（实测：调试用例 5 秒超时）。
 * 所以下面用 `newGate()` 一处构造，初值直接 `Promise.resolve()`。
 */
let gateOpen = true
let gate: Promise<void> = Promise.resolve()

function newGate(): Promise<void> {
  return new Promise<void>((resolve) => { releaseGate = resolve })
}

/** 关闸：在注入完成前挂住所有请求。**只有桌面端需要**（见上面的说明）。 */
export function holdApiUntilReady(): void {
  // 浏览器里**直接忽略**：没有异步注入可等，关闸只会把探针自己的请求挂死。
  if (!inTauri()) return
  gateOpen = false
  gate = newGate()
}

function openGate(): void {
  if (gateOpen) return
  gateOpen = true
  releaseGate()
}

/** 测试用：复位成"开着"（生产代码不该调它；两个入口用 `holdApiUntilReady`）。 */
export function resetApiReady(): void {
  gateOpen = true
  gate = Promise.resolve()
}

// dev 钩子（与 `__ddtoolkitShellHidden` 同路数）：让探针能**从页面里**读到
// "token 注入成什么样了"以及"请求带没带上头"。没有它，S1 出问题时只能靠猜
// —— 2026-09-25 实测：探针 60 条 401，而后端日志显示 `presented=''`，
// 到底是"没注入"还是"注入了没带"分不出来。
//
// ⚠️ 同样要守 `typeof window`：vitest 在 node 环境下 import 本模块。
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const diagWindow = window as unknown as { __ddtoolkitAuthDiag?: () => unknown }
  diagWindow.__ddtoolkitAuthDiag = () => ({
    hasToken: apiToken.length > 0,
    tokenLen: apiToken.length,
    devBrowser: Boolean(import.meta.env.DEV),
    base: apiBase,
    // 原始输入一并带出去：`hasToken=false` 时，是"define 没替换"还是"替换成了空值"，
    // 光看 hasToken 分不出来（这一批已经在这一步上猜了一轮）。
    rawEnvToken: String(import.meta.env.VITE_DEV_API_TOKEN ?? '<undefined>'),
    devTokenConst: DEV_API_TOKEN,
  })
}

/** 等"基地址与 token 都注入完成"。`request()` 内部会 await 它。 */
export function awaitApiReady(): Promise<void> {
  return gate
}

/**
 * 给需要**裸 HTTP 语义**的调用方用的 fetch：会带上会话 token，但**保留原始响应**
 * （要读 `.ok` / `.status` / 直接 `.json()` 的场景 —— 例如探针的诊断调用，
 * 它需要区分"没在跑"与"问不到"，那正是 `request()` 会抛错的两种情形）。
 *
 * ⚠️ 为什么需要它（2026-09-25 实测）：`dev/probe.ts` 里有十余处**裸 `fetch`**
 * （写于 S1 之前），它们不走 `request()` ⇒ 没有 token ⇒ 后端逐条 401。
 * 症状极具误导性：**探针自己那些"你没在跑吧？"的断言全部拿到 401**，
 * 于是布局/状态断言集体报红，看起来像 S1 把产品打坏了。
 *
 * 判据：**任何打后端的 fetch 都必须经过这里或 `request()`** ——
 * 前者要原始响应，后者要解析过的结果，没有第三种。
 */
export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  await gate
  const headers = new Headers(init?.headers)
  if (apiToken) headers.set(TOKEN_HEADER, apiToken)
  // ⚠️ 容忍**绝对 URL**（2026-09-25 踩到）：探针那几处写的是
  //    `` `${(import.meta.env.VITE_API_BASE) ?? '/api'}/xxx` `` —— 在探针里那已经是个完整地址。
  //    无脑拼 `apiBase` 会得到 `http://127.0.0.1:59321http://127.0.0.1:59321/xxx`，
  //    浏览器直接抛 `Failed to parse URL`（这一步的症状又是"探针没量到 fetch-status"，
  //    看起来像产品坏了）。
  const url = /^https?:\/\//.test(path) ? path : `${apiBase}${path}`
  return fetch(url, { ...init, headers })
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {  await gate
  // ⚠️ 用 `Headers` **合并**而不是直接塞一个对象：调用方可能已经带了 `Content-Type`
  //    （JSON 的那些），而 `uploadBackground` 走 `FormData`、**绝不能**设 Content-Type
  //    （设了浏览器就拼不出 multipart boundary）。合并两种都照顾到。
  const headers = new Headers(init?.headers)
  if (apiToken) headers.set(TOKEN_HEADER, apiToken)
  const resp = await fetch(`${apiBase}${path}`, { ...init, headers })
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`
    try {
      const body = await resp.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      /* 非 JSON 响应，保留默认信息 */
    }
    if (resp.status === 401) {
      // 401 单独提一句：它在本应用里**只可能是认证**（token 没注入 / 过期 / 壳与后端对不上），
      // 而默认文案只有"401 Unauthorized"，用户与排查者都看不出该往哪查。
      detail = `访问令牌无效或缺失（${detail}）—— 应用若刚重启，请重开窗口`
    }
    throw new Error(detail)
  }
  const text = await resp.text()
  return (text ? JSON.parse(text) : null) as T
}

export interface PostListParams {
  page: number
  page_size: number
  type?: string
  is_archived?: boolean
  is_deleted?: boolean
  q?: string
  date_from?: string
  date_to?: string
}

export const api = {
  /** 全部 VTuber（含嵌套 accounts） */
  listVtubers: () => request<VTuber[]>('/vtuber/list'),

  /** 抓取任务实时状态（TopBar 轮询用） */
  getFetchStatus: () => request<FetchStatus>('/vtuber/fetch-status'),

  /** 单个 VTuber */
  getVtuber: (id: number) => request<VTuber>(`/vtuber/${id}`),

  /** 上传卡片页自定义背景，返回更新后的 VTuber（含 background_path） */
  uploadBackground: (id: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<VTuber>(`/vtuber/${id}/background`, { method: 'POST', body: form })
  },

  /** 清除自定义背景，回退头像铺底，返回更新后的 VTuber */
  clearBackground: (id: number) =>
    request<VTuber>(`/vtuber/${id}/background`, { method: 'DELETE' }),

  /** 解除订阅：删除 VTuber（连带删其账号与全部帖子记录） */
  deleteVtuber: (id: number) => request<void>(`/vtuber/${id}`, { method: 'DELETE' }),

  /** 档案视图的卡片布局（空数组 = 还没排过，由前端用默认布局渲染）（R37-P2） */
  profileCards: (id: number) =>
    request<ProfileCardRow[]>(`/vtuber/${id}/profile-cards`),

  /** **整版**保存卡片布局（服务端 delete + insert 一个事务；越界 422）（R37-P2） */
  saveProfileCards: (id: number, cards: ProfileCardInput[]) =>
    request<ProfileCardRow[]>(`/vtuber/${id}/profile-cards`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards }),
    }),

  /** 重要日期 / 大型活动（vtuber_events）——「纪念日」与「大事记」两张卡的数据源。
   *  R42：两张卡共用这张表、各按 `kind` 取自己的条目（互不串）。 */
  listVtuberEvents: (id: number, kind?: 'anniversary' | 'event') =>
    request<VtuberEvent[]>(`/vtuber/${id}/events${kind ? `?kind=${kind}` : ''}`),

  createVtuberEvent: (id: number, data: {
    title: string; event_date: string
    kind?: 'anniversary' | 'event'; emoji?: string | null
  }) =>
    request<VtuberEvent>(`/vtuber/${id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  /** 局部更新（R42）：只传要改的字段；`emoji: null` = **清空**（不是"没传"） */
  updateVtuberEvent: (eventId: number, data: {
    title?: string; event_date?: string
    kind?: 'anniversary' | 'event'; emoji?: string | null
  }) =>
    request<VtuberEvent>(`/vtuber/event/${eventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  deleteVtuberEvent: (eventId: number) =>
    request<void>(`/vtuber/event/${eventId}`, { method: 'DELETE' }),

  /** 帖子列表（服务端分页 + 过滤）；可传 signal 取消在途请求（切换 VTuber 防回写） */
  listPosts: (platform: string, uid: string, params: PostListParams, signal?: AbortSignal) => {
    const q = new URLSearchParams()
    q.set('page', String(params.page))
    q.set('page_size', String(params.page_size))
    if (params.type) q.set('type', params.type)
    if (params.is_archived !== undefined) q.set('is_archived', String(params.is_archived))
    if (params.is_deleted !== undefined) q.set('is_deleted', String(params.is_deleted))
    if (params.q) q.set('q', params.q)
    if (params.date_from) q.set('date_from', params.date_from)
    if (params.date_to) q.set('date_to', params.date_to)
    return request<PostPage>(`/posts/${platform}/${uid}/paginated?${q.toString()}`, { signal })
  },

  /** 帖子统计概览（总数/类型分布/时间跨度） */
  postStats: (platform: string, uid: string) =>
    request<PostStats>(`/posts/${platform}/${uid}/stats`),

  // ── P5 档案视图 ────────────────────────────────────────────────

  /** 粉丝趋势点序列（服务端按天分桶降采样） */
  fanTrend: (accountId: number) =>
    request<FanTrendPoint[]>(`/account/${accountId}/fan-trend`),

  /** 账号信息快照（粉丝数/直播状态时间序列，时间倒序）。R9：账号信息历史弹窗用 */
  statSnapshots: (accountId: number, limit = 60) =>
    request<AccountStatSnapshot[]>(`/account/${accountId}/stat-snapshots?limit=${limit}`),

  /** 该 V 的曾用名 / 曾用签名（各最多 5 条，最近优先；只含**平台侧**旧值）。
   *  R9（devlog/080）：接入账号信息历史弹窗 —— 按账号过滤后展示。 */
  getFormerValues: (vtuberId: number) =>
    request<VTuberFormerValues>(`/vtuber/${vtuberId}/former-values`),

  /** 直播场次（由 self 快照转移推导） */
  liveSessions: (accountId: number) =>
    request<LiveSession[]>(`/account/${accountId}/live-sessions`),

  /** 单场次详情（详情弹窗）—— 只含本地库数据，不发起第三方请求（devlog/063） */
  liveSessionDetail: (accountId: number, liveId: string) =>
    request<LiveSessionDetail>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}`,
    ),

  /**
   * 场次详情里「必须打第三方」的那两格：弹幕词云 + 场次指标 + 直播动态（devlog/063）。
   *
   * 与详情端点分开：上游会间歇性变慢（实测 1.1s ↔ 15.6s，最坏 3×30s 重试），
   * 挂在详情里会让整个弹窗一起等。失败不抛错 —— 后端以降级字段如实回报
   * （`danmaku.wc_status='fetch_failed'` / `'no_danmaku'`），前端据此显示"没拉到"。
   *
   * `signal`：切场次/关弹窗时**取消在途请求**（上游最坏要等 90 多秒，
   * 用户早就不看这一场了）。走 `request()` 既有的 `init.signal`，见 devlog/064。
   */
  liveSessionUpstream: (accountId: number, liveId: string, signal?: AbortSignal) =>
    request<LiveUpstream>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}/upstream`,
      signal ? { signal } : undefined,
    ),

  /**
   * **按需**用原始弹幕自建词云（2026-09-13，danmakus 上游 `extra.wordCloud` 断供后）。
   *
   * 刻意与详情端点分开：自建要拉整场原始弹幕（实测单场可达 5 万条 / 数 MB），
   * 不能塞进"每次开弹窗"的请求里。用户点按钮才调（见 LiveSessionDialog）。
   *
   * `signal`：关弹窗 / 切场次时取消 —— 这条路径实测最长 **120s**（devlog/062 §四），
   * 用户早就不看它了，没必要让它在后台跑完（devlog/064 的同一套管道，devlog/069 补上）。
   */
  buildLiveSessionWordCloud: (accountId: number, liveId: string, signal?: AbortSignal) =>
    request<LiveDanmakuInfo>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}/wordcloud`,
      signal ? { signal } : undefined,
    ),

  /** 用户校正场次分类（v2 第⑦信号：override 最高优先，并反哺系列/词库） */
  setLiveSessionCategory: (accountId: number, liveId: string, category: string) =>
    request<{ category: string; category_from: string }>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}/category`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      },
    ),

  /** 撤除场次分类校正，恢复自动推断 */
  clearLiveSessionCategory: (accountId: number, liveId: string) =>
    request<void>(
      `/account/${accountId}/live-sessions/${encodeURIComponent(liveId)}/category`,
      { method: 'DELETE' },
    ),

  /** 第三方 VTuber 索引精确查询（企划/公会/房间号） */
  externalsVtuberByUid: (uid: string) =>
    request<ThirdpartyVtuber[]>(`/externals/vtubers/by-uid?uid=${encodeURIComponent(uid)}`),

  /** 更新 VTuber 元信息（P8-B：档案设置窗口 = 名称/头像/企划/生日/出道日/设定） */
  updateVtuber: (id: number, data: {
    name?: string
    avatar?: string | null
    faction?: string | null
    setting?: string | null
    notes?: string | null
    birthday?: string | null
    debut_date?: string | null
    /** 签名覆盖（null = 撤销覆盖，回落到"跟随来源账号"） */
    sign_override?: string | null
    /** 卡片签名跟随哪个账号（null = 主账号） */
    sign_source_account_id?: number | null
  }) =>
    request<VTuber>(`/vtuber/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  /** P8-B：部分更新账号（昵称 / 签名 / 顺序等）。
   *  2026-09-13（devlog/075）：`locked_fields` 已退役，且**本路径不再记曾用值**
   *  （手改不是"平台上曾经用过的"，见 `PUT /account` 的 docstring）。 */
  updateAccount: (accountId: number, data: {
    display_name?: string | null
    sign?: string | null
    avatar_url?: string | null
    url?: string | null
    sort_order?: number
  }) =>
    request<Account>(`/account/${accountId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  /** P8-B：删除账号（连带清理其帖子与从属数据） */
  deleteAccount: (accountId: number) =>
    request<void>(`/account/${accountId}`, { method: 'DELETE' }),

  /** P8-B：重排平台账号展示顺序（card 视图拖拽落库） */
  reorderAccounts: (vtuberId: number, accountIds: number[]) =>
    request<Account[]>(`/vtuber/${vtuberId}/account-order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_ids: accountIds }),
    }),

  /** 手动触发全量账号信息抓取（所有 VTuber） */
  triggerFetch: () =>
    request<FetchResult>('/vtuber/fetch', { method: 'POST' }),

  /** 抓取单个 VTuber 的账号信息 */
  fetchVtuber: (vtuberId: number) =>
    request<FetchResult>(`/vtuber/${vtuberId}/fetch`, { method: 'POST' }),

  /** 更新未归档动态贴文（先归档旧帖再抓取；name 省略 = 全部 VTuber） */
  updateUnarchivedPosts: (name?: string) => {
    const q = name ? `?name=${encodeURIComponent(name)}` : ''
    return request<UpdatePostsResult>(`/vtuber/update-posts${q}`, { method: 'POST' })
  },

  /** 按 VTuber 名字触发帖子抓取；full=true → 后台全量（视频+动态 -1，任务立即返回） */
  fetchPostsByName: (name: string, videoPages = 2, dynamicsPages = 3, full = false, platform = 'bilibili') => {
    const q = new URLSearchParams({
      name,
      platform,
      video_pages: String(videoPages),
      dynamics_pages: String(dynamicsPages),
    })
    if (full) q.set('full', 'true')
    return request<FetchPostsResult>(`/vtuber/fetch-posts?${q.toString()}`, { method: 'POST' })
  },

  /** 给 VTuber 添加平台账号（bilibili / weibo；添加后可触发账号信息抓取） */
  addAccount: (vtuberId: number, data: { platform: string; platform_uid: string; display_name?: string }) =>
    request<Account>('/vtuber/' + vtuberId + '/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // ── 候选池 / 收录（v0.5） ──────────────────────────────────────

  /** 本地候选检索：csv 池 + danmakus 索引合并，已入库条目自动剔除；
   *  signal 用于防抖取消在途请求（R11：返回项带 `origin` 标注来源） */
  searchPool: (kw: string, signal?: AbortSignal) =>
    request<PoolItem[]>(`/vtuber/pool/search?kw=${encodeURIComponent(kw)}`, { signal }),

  /** 直接从 B 站检索（R11，devlog/083）：纯数字按 UID 精确查，其余按名称搜。
   *  只在用户**显式触发**时调用（后端有 0.8s 串行 + 每分钟 20 次上限 + 5 分钟缓存）。 */
  biliSearch: (kw: string, page = 1, signal?: AbortSignal) =>
    request<BiliSearchResult>(
      `/vtuber/bili/search?kw=${encodeURIComponent(kw)}&page=${page}`, { signal }),

  /** 收录 VTuber（后端建库后自动调度单V账号抓取）。
   *  `source='bilibili'` = B 站直搜来源：池外条目后端会**实查 acc/info 复核**后才建库 */
  adoptVtuber: (platform: string, platformUid: string, faction?: string,
                source?: 'pool' | 'bilibili') =>
    request<VTuber>('/vtuber/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, platform_uid: platformUid, faction: faction || null,
                             source: source ?? null }),
    }),

  /** 当前能力矩阵：未登录时哪些能用、哪些受限（devlog/086）。前端提示的单一事实来源。 */
  capabilities: () => request<Capabilities>('/capabilities'),

  /** 某 V 的未来直播预约（R13；来自动态 reservation 帖的服务端解析）。
   *  `start_at` 是北京 wall-clock（naive），前端按本地时区解析即可。 */
  futureReservations: (vtuberId: number, days = 90) =>
    request<UpcomingReservation[]>(`/vtuber/${vtuberId}/future-reservations?days=${days}`),

  // ── 批量任务（拉取浮窗）────────────────────────────────────────

  /** 全量账号信息抓取（后台执行） */
  batchFetchAccounts: () =>
    request<{ status: string }>('/vtuber/fetch-accounts', { method: 'POST' }),

  /** 全量帖子抓取（视频+动态，后台执行） */
  batchFetchAllPosts: () =>
    request<{ status: string }>('/vtuber/batch/fetch-all-posts', { method: 'POST' }),

  /** 更新未归档帖（后台执行） */
  batchUpdateUnarchived: () =>
    request<{ status: string }>('/vtuber/batch/update-unarchived', { method: 'POST' }),

  /** 归档旧帖（默认 30 天前，同步返回归档数） */
  batchArchive: (days = 30) =>
    request<{ status: string; archived: number }>(`/vtuber/batch/archive?days=${days}`, {
      method: 'POST',
    }),

  // ── 登录（B 站 / 微博统一扫码 UI）─────────────────────────────────

  /** 生成扫码登录二维码：bilibili 返回 url；weibo 返回 image(base64 data URL) */
  startQrLogin: (platform: 'bilibili' | 'weibo') =>
    request<{ qr_id: string; url?: string; image?: string }>(`/auth/${platform}/qr/start`, {
      method: 'POST',
    }),

  /** 轮询扫码状态：waiting / scanned / confirmed / expired / failed */
  checkQrLogin: (platform: 'bilibili' | 'weibo', qrId: string) =>
    request<{ status: string; detail?: string }>(
      `/auth/${platform}/qr/check?qr_id=${encodeURIComponent(qrId)}`,
    ),

  /** 登录态（TopBar 徽章 / 登录对话框展示） */
  authStatus: (platform: 'bilibili' | 'weibo') =>
    request<{ logged_in: boolean; needs_login: boolean; uid: string | null; name: string | null }>(
      `/auth/${platform}/status`,
    ),

  // ── 应用设置（R14a，devlog/091）─────────────────────────────────────
  /** 设置规格表 + 当前生效值 + 只读信息 */
  appSettings: () => request<AppSettings>('/settings'),

  /** 保存一组改动（部分更新；`null` = 回默认值）。越界/未知键后端 400，detail 直接可显示 */
  saveAppSettings: (values: Record<string, number | boolean | null>) =>
    request<AppSettingsSaved>('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }),

  /** 全部恢复默认 */
  resetAppSettings: () => request<AppSettingsSaved>('/settings/reset', { method: 'POST' }),

  // ── 存储占用与维护（R22-B，devlog/104）──────────────────────────────
  /** 占用体检：库 / 图片缓存 / 日志 / 其余 + 磁盘剩余 + 遗留备份。
      后端要**真扫目录**，所以只在「关于」页打开时取一次，别拿它轮询。 */
  getStorage: () => request<StorageInfo>('/settings/storage'),

  /** 清空图片缓存（用户主动点；口径是全清，缓存可再生） */
  pruneImgCache: () => request<StorageActionResult>('/settings/storage/prune-cache',
    { method: 'POST' }),

  /** 整理数据库：回收 WAL + 把空闲页还盘 */
  runStorageMaintenance: () => request<StorageActionResult>('/settings/storage/maintenance',
    { method: 'POST' }),

  // ── 界面偏好（R14b，devlog/092）：主题 ──────────────────────────────
  /** 偏好值 + 允许取值 + 当前能力说明（说明由后端下发，界面不自己编） */
  getPrefs: () => request<Prefs>('/settings/prefs'),
  /**
   * 诊断包（批次 16，devlog/207）：用户"把这份发给开发者"。
   * 后端拼好纯文本返回（**不含凭据**），前端只负责复制/展示。
   */
  getDiagnostics: () =>
    request<{ filename: string; text: string; bytes: number; generated_at: string }>(
      '/settings/diagnostics'),

  /** 保存偏好（枚举白名单在后端；不在集合内 → 400） */
  savePrefs: (values: Record<string, string>) =>
    request<PrefsSaved>('/settings/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
}

/** 后端返回的相对资源路径（如 static/avatars/x.jpg）→ 可访问 URL */
export function resolveAsset(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return `${apiBase}/${path.replace(/^\/+/, '')}`
}

/** 图片代理 URL（直连 CDN 失败时的兜底链路，后端 /img-proxy 带磁盘缓存） */
export function imgProxyUrl(src: string): string {
  return `${apiBase}/img-proxy?url=${encodeURIComponent(src)}`
}
