/**
 * 「场次类型」卡片的派生（T4，2026-10-12）—— **纯函数**，可单测。
 *
 * 放在 utils 而不是卡片里，是为了让"标签 / 占比 / 那句如实说明"这三件事有判据：
 * 它们在界面上看不出对错（少 1% 没人发现，标签写错要靠肉眼对着日历看）。
 */
import type { LiveTypeStats } from '../api/types'
import { liveTypeLabel } from './liveType'

export interface TypeRow {
  /** 类型 key（服务端给的，未改动） */
  key: string
  label: string
  count: number
  /** 占**已统计场次**的百分比（四舍五入到整数；`total` 为 0 时一律 0） */
  percent: number
}

/**
 * 响应 → 卡片行。
 *
 * ⚠️ 两条纪律：
 * 1. **不打乱服务端给的顺序** —— 它是固定的展示顺序（`live_type.TYPE_DISPLAY_ORDER`），
 *    卡片每次开都该长一样；按 count 排序会让"昨天最多的是游戏、今天变成杂谈"，
 *    用户的肌肉记忆就失效了。
 * 2. **百分比的分母是 `total`**（日历上能看到的场次总数），不是 `items` 的和 ——
 *    两者在"有虚拟场次"时会差一点，而用户能核对的数只有前者。
 */
export function typeBreakdown(stats: LiveTypeStats | null | undefined): TypeRow[] {
  if (!stats || !stats.items?.length) return []
  const total = Math.max(stats.total || 0, 1)
  return stats.items
    .filter((i) => i.count > 0)          // 0 场的类型不占一行（卡片高度不该随数据跳）
    .map((i) => ({
      key: i.category,
      label: liveTypeLabel(i.category),
      count: i.count,
      percent: Math.round((i.count / total) * 100),
    }))
}

/**
 * 「还有 N 场没定出来」那句说明；没有差额 ⇒ null（**不写"0 场未分类"**：那句废话会
 * 让卡片多一行，而它说的正好是"没有问题"）。
 *
 * 为什么值得写出来：兜底那一批（`category_from='fallback'`）是"规则没定出来"，
 * 读取时显示成中性的「直播」。不说明的话，用户会以为那几百场是统计丢了 ——
 * 而它其实是这一版规则的诚实结论。
 *
 * ⚠️ f017 起兜底**也落库**了（`category='live'` + `category_from='fallback'`），
 * 所以"没定出来"不再等于"列是 NULL" —— 服务端的 `classified` 按 `category_from`
 * 算，这里只管拿 `total - classified` 说人话（前端不重新定义什么叫"没定出来"）。
 */
export function unclassifiedNote(stats: LiveTypeStats | null | undefined): string | null {
  if (!stats) return null
  const gap = stats.total - stats.classified
  if (gap <= 0) return null
  return `${gap} 场还没定出类型（显示为「直播」）—— 规则改动只影响之后新入库的场次`
}
