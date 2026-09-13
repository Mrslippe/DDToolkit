/**
 * 粉丝趋势的**数据合并口径**（2026-09-13，R4：自抓取优先）。
 *
 * 背景：`GET /account/{id}/fan-trend` 会同时返回两种来源的点 ——
 * - `self`：本工具每轮账号抓取记的快照（`account_stat_snapshots`，约 5 分钟一条）；
 * - 第三方（`zeroroku`）：收录该 V 时一次性回填的历史（日粒度，能回溯到 2019 年）。
 *
 * 同一天可能两者都有，而它们的取值时点不同（第三方不保证当天取满），
 * 所以口径是：**同一天以 self 为准；第三方只补 self 缺失的日子**（用户 2026-09-13 定）。
 * 这样既不会让"第三方当天的旧值"盖掉自己的记录，也不会丢掉第三方撑起的历史。
 *
 * ⚠️ 这条规则**逐日生效**，绝不能全局覆盖 —— self 只有本工具安装之后的点，
 * 全局优先会把 2019 年以来的历史整段抹掉。
 *
 * 抽成纯函数（而不是写在组件里）：这是"数据对不对"的规则，能脱离 ECharts 断言
 * （见 `fanTrend.test.ts`）。
 */
import type { FanTrendPoint } from '../api/types'

export interface TrendDay {
  date: string
  /** 当日采用的粉丝数（self 优先） */
  fans: number
  /** 该值来自哪个源：`self` = 本地快照，其余 = 第三方回填 */
  source: string
  /** 日增（首日/断档为 null） */
  delta: number | null
}

/** 源优先级：self 最高；其余同权（同日多源第三方取最后一条）。 */
function isSelf(source: string): boolean {
  return source === 'self'
}

/**
 * 按天合并趋势点（self 优先 + 第三方补空洞），并按日期升序算出日增。
 *
 * 同日多条的处理：
 * - 有 `self` → 取**最后一条 self**（后端已按 captured_at 升序给出）；
 * - 只有第三方 → 取最后一条第三方。
 */
export function mergeTrendDays(points: FanTrendPoint[]): TrendDay[] {
  const byDate = new Map<string, { fans: number; source: string; self: boolean }>()
  for (const p of points) {
    if (!p?.date) continue
    const self = isSelf(p.source)
    const cur = byDate.get(p.date)
    // 已有 self 时，后来的第三方不得覆盖；同类则后者覆盖前者（"最后一条"）
    if (cur && cur.self && !self) continue
    byDate.set(p.date, { fans: p.fans, source: p.source, self })
  }
  const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const out: TrendDay[] = []
  let prev: number | null = null
  for (const [date, v] of sorted) {
    out.push({
      date,
      fans: v.fans,
      source: v.source,
      delta: prev != null ? v.fans - prev : null,
    })
    prev = v.fans
  }
  return out
}

/** 趋势里的来源综述（给卡片右上角的来源标注用，R3）。
 *  只要求 `source`：调用方传 `TrendDay[]` 或图表侧的 `DailyPoint[]` 都行。 */
export function trendSourceLabel(days: { source: string }[]): string {
  const hasSelf = days.some((d) => isSelf(d.source))
  const hasThird = days.some((d) => !isSelf(d.source))
  if (hasSelf && hasThird) return '本地快照 + 第三方回填'
  if (hasSelf) return '本地快照'
  if (hasThird) return '第三方回填'
  return '暂无数据'
}
