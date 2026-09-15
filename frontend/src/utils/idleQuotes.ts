/**
 * 空闲轮播（R12b，devlog/090）：顶栏状态岛在**没事发生**时轮着说点什么。
 *
 * 用户口径（R12 期望③）：「后续可能的自定义内容，例如空闲时轮播经典语录」。
 *
 * 三条设计约束：
 * 1. **状态文案仍在轮播里**（`statusText` 作为第 0 格）：全换成语录之后，
 *    "服务到底在不在跑"这个信息就没地方看了 —— 而那是顶栏的看家职责；
 * 2. **确定性**：按"当前时刻 ÷ 间隔"取模选条目，不用随机数 —— 探针/单测才能断言"下一个是什么"，
 *    也让同一时刻重渲染不闪字；
 * 3. **不许出现会被既有口径误判的词**：`_assert_topbar` 断言自动节拍期间顶栏文案里
 *    不能有「轮询」「账号信息抓取中」—— 语录是长期不变的文案，混进这类词就会让那条护栏
 *    永久红灯（有单测 `test_quotes_avoid_words_that_break_the_topbar_rule` 拦着）。
 *
 * 扩展点：`registerIdleProvider(() => string[])` —— 将来接弹幕热词/名场面时不用改本模块。
 */

/**
 * 轮播间隔。取值的两侧都有代价（所以有单测钉住这个区间）：
 * - 太短（<4s）：顶栏在余光里一直在动，比静止更抢注意力；
 * - 太长（>15s）：一圈 8 格要两分钟，观感上等于"卡住了"。
 *
 * 6s 是"一轮 48s、每分钟换 10 次"的折中。注意它**独立于**抓取轮询的节奏
 * （`TopBar.POLL_IDLE_MS=10s`）：轮播由 `StatusIsland` 自己的定时器驱动 ——
 * 否则把轮播的可见性挂在轮询周期上，将来有人调大轮询间隔，轮播会静默变慢/停住。
 */
export const IDLE_TICK_MS = 6_000

/** 内置语录（短、克制、不抢注意力；太长会被胶囊截断） */
export const IDLE_QUOTES: readonly string[] = [
  '记录会一直留着，慢慢看',
  '档案已就绪，随时可以翻',
  '今天也在安静地守着',
  '想看谁，点左边的名字',
  '数据都在本地，不连外网也在',
  '删掉的帖子也留了痕',
  '空闲中 · 下一场直播会自己进来',
]

/**
 * **空闲语录轮播：暂时下线**（R19，devlog/096）。
 *
 * 用户口径（2026-09-15）：「顶栏状态栏空置的时候轮播的语录集暂时下线，等之后库中真有了
 * 条目再上线」。也就是说，现在那几句内置语录（"档案已就绪，随时可以翻"…）是**文案占位**，
 * 而不是库里真有的东西 —— 与其让顶栏转着几句与数据无关的话，不如老实显示状态文案。
 *
 * 下线**不是删掉**：池子照建（`data-idle-pool` 照挂）、取模选格照实现（单测用 `enabled: true`
 * 覆盖着测，逻辑不会烂），`registerIdleProvider` 扩展点也留着 —— 将来库中真有了条目
 * （弹幕热词 / 名场面 / 直播倒计时）就走这个口子接进来，然后把这里翻成 `true`。
 *
 * ⚠️ 翻这个开关是**两处一起改**：本常量 + 探针 `ui_probe --status-island` 的
 * "空闲文案不轮播 / 必须轮播"那组断言（探针读 DOM 上的 `data-idle-carousel`，
 * 会对不上就红 —— 故意的：省得哪天悄悄开了或关了没人知道）。
 */
export const IDLE_CAROUSEL_ENABLED = false

export type IdleProvider = () => string[]

const providers: IdleProvider[] = []

/** 注册一个空闲内容来源（返回若干条文案）。返回**注销函数**，便于模块卸载/测试清理。 */
export function registerIdleProvider(p: IdleProvider): () => void {
  providers.push(p)
  return () => {
    const i = providers.indexOf(p)
    if (i >= 0) providers.splice(i, 1)
  }
}

/** 清空所有来源（测试用；运行时不该调） */
export function clearIdleProviders(): void {
  providers.length = 0
}

/** 当前轮播池：状态文案 + 内置语录 + 各来源贡献（去重、按序） */
export function idlePool(statusText = '数据服务运行中'): string[] {
  const out: string[] = [statusText]
  const push = (t: string) => {
    const s = (t || '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  for (const q of IDLE_QUOTES) push(q)
  for (const p of providers) {
    try {
      for (const t of p() ?? []) push(t)
    } catch {
      /* 来源抛错不影响顶栏（宁可不显示，也不能把顶栏搞挂） */
    }
  }
  return out
}

/**
 * 当前该显示哪一条 + 它在池里的位置。
 *
 * 位置要露出来是因为**探针只能看 DOM**：`data-idle-index` / `data-idle-size` 让
 * `ui_probe --status-island` 能断言"索引在池内、并且真的在往前走"，
 * 而"第 0 格是状态文案"由本模块的单测钉住 —— 两边合起来才是完整论证。
 */
export interface IdlePick {
  text: string
  index: number
  size: number
  /** 整个池子（含第 0 格状态文案）—— 探针把它读出来做"取到的词确实出自池子"的判定 */
  pool: string[]
}

/**
 * `floor(now / tickMs) % pool.length`；`tickMs<=0` 或轮播下线时退回第 0 格（状态文案）。
 *
 * `enabled` 显式可覆盖（默认取 `IDLE_CAROUSEL_ENABLED`）：运行时关着，
 * 但单测仍能用 `enabled: true` 把轮播逻辑完整测一遍 —— 关掉的是**显示**，不是实现。
 */
export function pickIdle(
  now: number,
  opts: { statusText?: string; tickMs?: number; enabled?: boolean } = {},
): IdlePick {
  const pool = idlePool(opts.statusText)
  const tick = opts.tickMs ?? IDLE_TICK_MS
  const on = opts.enabled ?? IDLE_CAROUSEL_ENABLED
  if (!on || !(tick > 0) || pool.length <= 1) {
    return { text: pool[0], index: 0, size: pool.length, pool }
  }
  const index = Math.floor(now / tick) % pool.length
  return { text: pool[index], index, size: pool.length, pool }
}

/**
 * 当前该显示哪一条：`pickIdle(...).text`。
 * 轮播下线或 `tickMs<=0` 时退回第 0 格（状态文案）—— 关掉轮播也不该显示空。
 */
export function pickIdleText(
  now: number,
  opts: { statusText?: string; tickMs?: number; enabled?: boolean } = {},
): string {
  return pickIdle(now, opts).text
}
