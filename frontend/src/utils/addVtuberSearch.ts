/**
 * 「添加 V」两个来源的合并与判定（R11，devlog/083）。
 *
 * 三个来源：本地 `csv 候选池` / 本地 `danmakus 索引` / **在线 B 站检索**。
 * 这里只做**纯逻辑**（渲染留给 `AddVtuberDialog`），因为下面每条判错了界面都不会报错：
 *
 * - **同 uid 去重**：本地命中优先（池内名称更规范，且本地条目能直接走池内收录路径）；
 * - **已订阅**：本地接口已剔除已入库条目，但 **B 站结果是实时的**，必须按 `in_library` 置灰
 *   ——标错的代价是"看着能加、点了 409"；
 * - **输入分流**：纯数字且 ≥5 位按 UID 直查（B 站搜索接口**搜不到 uid**，
 *   实测 `keyword=1265680561` → 0 条），判定必须与后端 `bili_search.looks_like_uid` 一致。
 */
import type { BiliSearchItem, PoolItem } from '../api/types'

/** 展示行（两个来源归一化后的统一形状） */
export interface AddCandidate {
  key: string
  platform: string
  platform_uid: string
  name: string
  /** 来源：pool=候选池 · index=danmakus 索引 · bilibili=在线检索 */
  origin: 'pool' | 'index' | 'bilibili'
  /** 收录时要带给后端的 source（本地两类都是池内路径） */
  adoptSource: 'pool' | 'bilibili'
  /** 能否收录（索引里的非 B 站条目走不了池外通道 → false，置灰并给原因） */
  adoptable: boolean
  /** 不能收录的原因（`adoptable=false` 时给 title 用） */
  blockedReason?: string
  followers?: number
  verified?: string
  group?: string
  avatar?: string
  isLive?: boolean
  /** 已在库里（B 站结果才需要判；本地接口已剔除） */
  inLibrary: boolean
  exact?: boolean
}

/** 输入是否应走 UID 直查（与后端 `bili_search.looks_like_uid` 同口径） */
export function inputLooksLikeUid(kw: string): boolean {
  const s = (kw || '').trim()
  return /^\d{5,12}$/.test(s)
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
      inLibrary: false,
    })
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
    origin: 'bilibili' as const,
    adoptSource: 'bilibili' as const,
    adoptable: true,
    followers: it.followers,
    verified: it.verified || undefined,
    avatar: it.avatar || undefined,
    isLive: it.is_live,
    inLibrary: it.in_library,
    exact: it.exact,
  }))
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

/** 来源徽标文案 */
export function originLabel(origin: AddCandidate['origin']): string {
  if (origin === 'pool') return '候选池'
  if (origin === 'index') return '索引'
  return 'B 站'
}
