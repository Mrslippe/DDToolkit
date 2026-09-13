/**
 * 「账号信息历史」弹窗的**纯逻辑**（R9，devlog/080）。
 *
 * 用户口径（2026-09-13）：曾用名/曾用签名属于「**账号信息历史快照**」这一类，
 * 要的是"V **在平台上**曾经用过的值"（抓取覆盖前记账），不是本地手改入库的字符串。
 * 这里只做三件可断言的小事，渲染留给组件：
 *   ① 把 V 级曾用值**按账号过滤**（弹窗是按账号打开的）；
 *   ② 快照的来源标注（self / 第三方）—— R4 的合并口径就吃 `source` 字段；
 *   ③ 直播状态的中文标注（0 离线 / 1 直播中 / null 未记录）。
 */
import type { AccountStatSnapshot, FormerValueItem, VTuberFormerValues } from '../api/types'

export interface AccountFormerValues {
  names: FormerValueItem[]
  signs: FormerValueItem[]
  /** 该 V 上属于**其它账号（含已移除账号）**的旧值条数 —— 用于一句灰色说明 */
  otherCount: number
}

/** 按账号过滤 V 级曾用值；`accountId` 为空时返回全部（调用方自会处理） */
export function formerForAccount(
  former: VTuberFormerValues | null,
  accountId: number | null,
): AccountFormerValues {
  const all = [...(former?.names ?? []), ...(former?.signs ?? [])]
  if (!former) return { names: [], signs: [], otherCount: 0 }
  if (accountId == null) {
    return { names: former.names, signs: former.signs, otherCount: 0 }
  }
  const names = former.names.filter((f) => f.account_id === accountId)
  const signs = former.signs.filter((f) => f.account_id === accountId)
  return {
    names,
    signs,
    otherCount: all.length - names.length - signs.length,
  }
}

/** 快照来源标注（P4：self=本工具直采；zeroroku=第三方回填） */
export function snapshotSourceLabel(source: string): string {
  if (source === 'self') return '自采'
  if (source === 'zeroroku') return 'zeroroku'
  return source || '未知来源'
}

/** 直播状态标注：null = 该次抓取没记录（老快照），不要渲染成"离线" */
export function liveStatusLabel(status: number | null): string | null {
  if (status == null) return null
  return status === 1 ? '直播中' : '离线'
}

/** 快照列表的展示行（时间倒序由后端保证；这里只做"要不要显示"的判断） */
export function snapshotVisibleFields(s: AccountStatSnapshot): {
  followers: string | null
  live: string | null
  title: string | null
} {
  return {
    followers: s.followers_count == null
      ? null
      : s.followers_count.toLocaleString('zh-CN'),
    live: liveStatusLabel(s.live_status),
    // 开播标题只在"直播中"时才有意义（离线快照带的是上一次的残留标题）
    title: s.live_status === 1 ? (s.live_title ?? null) : null,
  }
}
