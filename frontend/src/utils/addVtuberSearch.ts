/**
 * 「添加 V」各来源的合并与判定（R11，devlog/083；多平台 B1，`devlog/463`）。
 *
 * 来源：本地 `csv 候选池` / 本地 `danmakus 索引` / **在线检索**（B 站 + 微博 + 小红书 + 抖音）。
 * 这里只做**纯逻辑**（渲染留给 `AddVtuberDialog`），因为下面每条判错了界面都不会报错：
 *
 * - **同 uid 去重**：本地命中优先（池内名称更规范，且本地条目能直接走池内收录路径）；
 * - **已订阅**：本地接口已剔除已入库条目，但**在线结果是实时的**，必须按 `in_library` 置灰
 *   ——标错的代价是"看着能加、点了 409"；
 * - **输入分流**：纯数字且 ≥5 位按 UID 直查（B 站搜索接口**搜不到 uid**，
 *   实测 `keyword=1265680561` → 0 条），判定必须与后端 `bili_search.looks_like_uid` 一致。
 */
import type { BiliSearchItem, NameSearchGroup, PoolItem } from '../api/types'

/** 展示行（两个来源归一化后的统一形状） */
export interface AddCandidate {
  key: string
  platform: string
  platform_uid: string
  name: string
  /** 来源：pool=候选池 · index=danmakus 索引 · 其余 = 平台名（在线检索命中的那个平台） */
  origin: 'pool' | 'index' | 'bilibili' | 'weibo' | 'xiaohongshu' | 'douyin'
  /** 收录时要带给后端的 source（本地两类都是池内路径；在线条目就是它自己的平台名） */
  adoptSource: 'pool' | 'bilibili' | 'weibo' | 'xiaohongshu' | 'douyin'
  /** 能否收录（索引里的非 B 站条目走不了池外通道 → false，置灰并给原因） */
  adoptable: boolean
  /** 不能收录的原因（`adoptable=false` 时给 title 用） */
  blockedReason?: string
  followers?: number
  verified?: string
  group?: string
  /** 「他还在 …」的展示串（喂 `extraPlatforms`；不可点，见该函数的说明） */
  extra?: string
  avatar?: string
  isLive?: boolean
  /** 已在库里（在线结果才需要判；本地接口已剔除） */
  inLibrary: boolean
  exact?: boolean
}

/**
 * 输入是否应走 UID 直查（与后端 `bili_search.looks_like_uid` 同口径）。
 *
 * ⚠️ 上界必须跟着后端一起放宽（2026-10-06，`devlog/378`）：B 站新账号是 **16 位 mid**
 * （例 `3537112928356578`）。这里卡在 12 位时，16 位输入会被当成**关键词**去搜 ——
 * 而 B 站搜索接口搜不到 uid ⇒ 界面上表现为"这个名字搜不到任何结果"。
 */
export function inputLooksLikeUid(kw: string): boolean {
  const s = (kw || '').trim()
  return /^\d{5,20}$/.test(s)
}

function keyOf(platform: string, uid: string | number): string {
  return `${platform}:${uid}`
}

/** 本地两类来源 → 展示行（池优先去重）
 *
 * ⚠️ **索引来源不能走池内路径**（2026-09-15 用户实测踩到）：`thirdparty_vtubers` 是
 * danmakus 周级索引，覆盖"池快照之后新出现的 V"—— 实测抽样 200 条里有 3 条**不在
 * `vtubers.csv` 里**，而这正是用户最想加的那类新 V。索引行若带 `source='pool'`，
 * 后端 `find_in_pool` miss ⇒ 404「候选池中不存在该 platform_uid」，点一下就是一句红字。
 * 所以：索引 + bilibili → 走**池外通道**（后端实查 `acc/info` 复核后建库）；
 * 索引 + 其它平台 → 池外通道不支持（后端 400），行**置灰并说明原因**，别让用户白点。
 */
export function poolToCandidates(pool: PoolItem[]): AddCandidate[] {
  const seen = new Set<string>()
  const out: AddCandidate[] = []
  for (const it of pool) {
    const key = keyOf(it.platform, it.platform_uid)
    if (seen.has(key)) continue          // 同 uid 只留第一条（后端已让池优先）
    seen.add(key)
    const origin = it.origin === 'index' ? 'index' : 'pool'
    // 只有 csv 池里的条目才能走池内路径；索引条目在池外
    const outsidePool = origin === 'index'
    const adoptable = !outsidePool || it.platform === 'bilibili'
    out.push({
      key,
      platform: it.platform,
      platform_uid: String(it.platform_uid),
      name: it.name,
      origin,
      adoptSource: outsidePool && it.platform === 'bilibili' ? 'bilibili' : 'pool',
      adoptable,
      blockedReason: adoptable
        ? undefined
        : `「${it.name}」来自本地索引、不在候选池快照里，目前只有 B 站支持池外收录`,
      group: it.group || undefined,
      extra: it.extra || undefined,
      inLibrary: false,
    })
  }
  return out
}

/** 平台名 → 展示名（`extra` 列里是 vdb 的机器名） */
const EXTRA_LABELS: Record<string, string> = {
  twitter: 'Twitter', youtube: 'YouTube', youtubeat: 'YouTube', weibo: '微博',
  acfun: 'AcFun', twitch: 'Twitch', pixiv: 'Pixiv', userlocal: 'userlocal',
  peing: 'Peing', marshmallow: 'マシュマロ', instagram: 'Instagram',
  github: 'GitHub', booth: 'BOOTH', afdian: '爱发电', bilibili: 'B 站',
  other: '其它',
}

/**
 * `extra_accounts`（`platform:id|platform:id`）→ 去重后的**平台展示名**（最多 4 个）。
 *
 * 用途：候选行里加一句「他还在 Twitter / YouTube」—— 用户据此判断"这是不是我要找的那个人"
 * （同名小号很多，这一句比粉丝数还管用）。
 *
 * ⚠️ **刻意不做成链接**：壳的外链白名单（`lib.rs::EXTERNAL_HOSTS`）只放行 B 站/微博/小红书/
 * 抖音四个域，twitter/youtube/acfun 这些点开就是一句"这个主机不在允许打开的名单里"
 * —— 与其给一个点了报错的入口，不如只把**事实**说出来（`title` 里带完整账号）。
 */
export function extraPlatforms(extra: string | null | undefined, limit = 4): string[] {
  const out: string[] = []
  for (const part of (extra || '').split('|')) {
    const platform = part.split(':')[0]?.trim().toLowerCase()
    if (!platform) continue
    const label = EXTRA_LABELS[platform] ?? platform
    if (!out.includes(label)) out.push(label)
    if (out.length >= limit) break
  }
  return out
}

/** B 站结果 → 展示行（保留粉丝/认证/直播态，供用户辨别同名小号） */
export function biliToCandidates(items: BiliSearchItem[]): AddCandidate[] {
  return items.map((it) => ({
    key: keyOf(it.platform, it.platform_uid),
    platform: it.platform,
    platform_uid: String(it.platform_uid),
    name: it.name,
    origin: it.platform as AddCandidate['origin'],
    adoptSource: it.platform as AddCandidate['adoptSource'],
    adoptable: true,
    followers: it.followers,
    verified: it.verified || undefined,
    avatar: it.avatar || undefined,
    isLive: it.is_live,
    inLibrary: it.in_library,
    exact: it.exact,
  }))
}

/**
 * **多平台检索结果 → 展示行**（B1，`devlog/463`）。
 *
 * 平台顺序**照后端给的 `groups` 顺序**（= 设置界面里那四家的顺序），不在这里重排
 * —— 顺序的真源只有一处（后端 `platform_switches.PLATFORMS`）。
 *
 * ⚠️ 四个平台**都能一键收录**：池外收录那条路（后端实查主页信息复核后才建库）
 * 从 2026-10-11 起支持 bilibili / weibo / xiaohongshu / douyin（见 `_VERIFY_BY_PROFILE`）。
 * 所以这里 `adoptable` 恒为真 —— 真正的"不能收录"由后端按平台能力决定（会回 4xx + 人话）。
 */
export function groupsToCandidates(groups: NameSearchGroup[]): AddCandidate[] {
  return groups.flatMap((g) => biliToCandidates(g.items || []))
}

/**
 * 全部平台**都没有结果**（⇒ 界面显示那一行「没找到」）。
 *
 * ⚠️ 与"还没来得及搜"、"平台关着"、"平台报错"都要分开：
 * 后三种情况下说「没找到」都是**把系统状态的锅甩给用户**（本仓最忌讳的那类静默误导）。
 * 所以只有"发了请求、没报错、也没被跳过、但一条都没有"才算真·没找到。
 */
export function allGroupsEmpty(groups: NameSearchGroup[] | null | undefined): boolean {
  if (!groups || groups.length === 0) return false
  return groups.every((g) => !g.items?.length && !g.error && !g.skipped)
}

/** 一个平台那一行的状态文案（纯函数，供用例钉住；null = 不必说话） */
export function groupNote(g: NameSearchGroup): { text: string; tone: 'err' | 'muted' | 'ok' } | null {
  if (g.skipped) return { text: g.hint || `${g.label}的抓取已关闭`, tone: 'muted' }
  if (g.error) {
    // ⚠️ 结论一律以后端 `hint` 为准（风控/没登录/网络各不同），前端不自己编原因
    return { text: g.hint || `${g.label}检索没取到结果`, tone: 'err' }
  }
  if (!g.items?.length) return { text: `${g.label}没有匹配`, tone: 'muted' }
  // 微博的建议型接口**只回最匹配的一条**：说清是"接口只给一条"，别让人以为"全网就一个"
  if (g.best_match_only) return { text: `${g.label}命中 1 条（该接口只给最匹配的一个）`, tone: 'ok' }
  return { text: `${g.label}命中 ${g.items.length} 条`, tone: 'ok' }
}

/** 合并两组展示行：本地优先（同 uid 时在线结果被丢弃），保持各自原顺序 */
export function mergeCandidates(local: AddCandidate[], online: AddCandidate[]): AddCandidate[] {
  const seen = new Set(local.map((c) => c.key))
  return [...local, ...online.filter((c) => !seen.has(c.key))]
}

/** 粉丝数展示（0 不显示成 "0 粉"，看起来像小号；缺失就不显示） */
export function followerLabel(n: number | undefined): string | null {
  if (!n) return null
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万粉`
  return `${n.toLocaleString('zh-CN')} 粉`
}

/** 来源徽标文案（在线条目按平台给名；平台名以后端 `label` 为准，这里只兜底老路径） */
export function originLabel(origin: AddCandidate['origin']): string {
  if (origin === 'pool') return '候选池'
  if (origin === 'index') return '索引'
  if (origin === 'bilibili') return 'B 站'
  if (origin === 'weibo') return '微博'
  if (origin === 'xiaohongshu') return '小红书'
  if (origin === 'douyin') return '抖音'
  return origin
}
