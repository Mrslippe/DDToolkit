/**
 * 帖子类型筛选分组（P2 分层收敛 A 批次：从 `PostsPage.tsx` 搬出，**只搬不改**）。
 *
 * 为什么值得单独成文件：这是**平台化分类**（P9-2 / v0.9.6，devlog/047）在前端的落点 ——
 * B 站与微博的分类规则**故意不再共用一套**（微博没有专栏/音乐，多了平台自动发帖单列的
 * 「系统」）。这类"规则表"最容易在后续调整里被改错，而它又是纯数据 + 纯函数，
 * 完全可以机器验证，所以从 1285 行的页面组件里提出来。
 *
 * 口径（与后端 `type` 取值一致，见 `app/services/platforms/{bilibili,weibo}.py`）：
 * - B 站：`video` / `video_dynamic` / `image` / `text` / `repost` / `article` / `music` / `live`
 * - 微博：`image` / `text` / `video` / `repost` / **`system`**（平台自动发帖）
 */

/** 分组 chip：key 为逗号合并类型（后端 `type` 参数支持逗号分隔多型 in 过滤）。
 *  高频型两两归组（投稿/图文）压缩 chips 宽度，保证不把右侧搜索栏挤到下一行；
 *  低频型保持单型 chip。计数求和、零计数组不显示。 */
export interface TypeGroup {
  key: string
  label: string
  types: string[]
}

export const TYPE_GROUPS_BILIBILI: TypeGroup[] = [
  { key: 'video,video_dynamic', label: '投稿', types: ['video', 'video_dynamic'] },
  { key: 'image,text', label: '图文', types: ['image', 'text'] },
  { key: 'repost', label: '转发', types: ['repost'] },
  { key: 'article', label: '专栏', types: ['article'] },
  { key: 'music', label: '音乐', types: ['music'] },
  { key: 'live', label: '直播', types: ['live'] },
]

/** 微博：没有专栏/音乐，多了平台自动发帖（会员升级/签到/推广）单列的「系统」。
 *  P9-2（v0.9.6 用户）：不同平台的分类规则不再共用一套。 */
export const TYPE_GROUPS_WEIBO: TypeGroup[] = [
  { key: 'image,text', label: '图文', types: ['image', 'text'] },
  { key: 'video', label: '视频', types: ['video'] },
  { key: 'repost', label: '转发', types: ['repost'] },
  { key: 'system', label: '系统', types: ['system'] },
]

/** 小红书（第 4 阶段 ④，devlog/231）：它没有投稿/专栏/音乐，也没有"转发"这一档；
 *  适配器把 `normal → image`、`video → video`（见 `platforms/xiaohongshu.py`）。 */
export const TYPE_GROUPS_XHS: TypeGroup[] = [
  { key: 'image,text', label: '图文', types: ['image', 'text'] },
  { key: 'video', label: '视频', types: ['video'] },
]

/** 按当前账号平台取分类分组（零计数组仍不显示，由调用方过滤）。
 *  未知/未选账号平台一律按 B 站处理（B 站是主平台，见 `PRIMARY_PLATFORM_ORDER`）。 */
export function typeGroupsFor(platform: string | undefined): TypeGroup[] {
  if (platform === 'weibo') return TYPE_GROUPS_WEIBO
  if (platform === 'xiaohongshu') return TYPE_GROUPS_XHS
  return TYPE_GROUPS_BILIBILI
}

/** 平台显示名（账号切换器 / 添加账号用）。未知平台**没有条目** —— 调用方按原型链取值，
 *  未收录平台会得到 `undefined`（渲染为空）。这是既有行为，本批次**只搬不改**，
 *  不要顺手给它加"原样回显"的回退（那会改变未知平台上的展示）。 */
export const PLATFORM_LABEL: Record<string, string> = {
  bilibili: 'B站', weibo: '微博', xiaohongshu: '小红书',
}

/**
 * 平台的**英文名**（给"本来就显示英文"的位置用；2026-10-03 用户口径：
 * 「原本用英文的地方就接着用英文」）。
 *
 * ⚠️ 为什么不能直接打印 `a.platform`：那是**库里的标识键**，`xiaohongshu` 露在界面上就是
 * 用户看到的那行 —— 品牌英文名是 **rednote**（与卡片药丸那张图同口径）。
 * 未知平台**原样回显标识键**（既不装懂，也不显示空白）。
 */
export const PLATFORM_EN: Record<string, string> = {
  bilibili: 'bilibili',
  weibo: 'weibo',
  xiaohongshu: 'rednote',
}

/** 平台英文名（空值 → 「平台」，未知平台 → 标识键原样） */
export function platformEn(platform: string | null | undefined): string {
  const p = (platform ?? '').trim()
  if (!p) return '平台'
  return PLATFORM_EN[p] ?? p
}

/* ── 平台账号的纯逻辑（P2 分层收敛 A 批次从 `PostsPage.tsx` 搬出，只搬不改） ── */

/** 账号主页 URL：优先用后端抓到的 `url`；为空时按平台兜底拼。
 *
 *  - B 站：`space.bilibili.com/{uid}`（实测后端 `accounts.url` 对 B 站常为空，见 devlog/048）
 *  - 微博：`weibo.com/u/{uid}`
 *  - 其它平台 / 缺 uid：`null`（调用方据此禁用「打开主页」）
 *
 *  不硬编码平台判断的话，新增平台会静默点到空链接 —— 所以这里用显式白名单。 */
export function accountHomeUrl(a: {
  url?: string | null
  platform?: string | null
  platform_uid?: string | null
}): string | null {
  if (a.url) return a.url
  if (!a.platform_uid) return null
  if (a.platform === 'bilibili') return `https://space.bilibili.com/${a.platform_uid}`
  if (a.platform === 'weibo') return `https://weibo.com/u/${a.platform_uid}`
  if (a.platform === 'xiaohongshu') return `https://www.xiaohongshu.com/user/profile/${a.platform_uid}`
  return null
}

/** 按已保存的拖拽顺序重排账号（P8-B）。
 *
 *  - `order` 为 null → 原样返回（未拖拽过，保持后端给的 `sort_order` 序）；
 *  - `order` 里的 id 可能在 `accounts` 里已不存在（账号被删）→ 跳过；
 *  - `accounts` 里可能有 `order` 未覆盖的新账号（拖拽后新增）→ **追加到尾部**，
 *    否则新账号会在卡片上凭空消失。 */
export function orderAccounts<T extends { id: number }>(
  accounts: T[],
  order: number[] | null,
): T[] {
  if (!order) return accounts
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const ordered = order.map((id) => byId.get(id)).filter(Boolean) as T[]
  for (const a of accounts) if (!order.includes(a.id)) ordered.push(a)
  return ordered
}

/** 平台粉丝徽章集：每集 `size` 枚切分（集内横排、集间纵向间隔）。 */
export function chunkBy<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
