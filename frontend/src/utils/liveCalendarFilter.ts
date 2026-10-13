/**
 * 日历的类型筛选派生（T4，2026-10-12，`devlog/467`）—— **纯函数**，可单测。
 *
 * 为什么从 `LiveCalendar.tsx` 里搬出来：这三条规则都是"界面上看不出对错"的那类 ——
 * 计数用筛前还是筛后的集合、空日子算不算一场、筛选空间该不该跟着收窄，
 * 在屏幕上都只差几个数字，而用户是**拿这些数字做判断**的。
 */
import type { LiveSession } from '../api/types'
import { keyOf } from '../components/live/liveCalendarFmt'

/** 按类型筛选场次（空选择 = 不筛，返回原引用：别为了"没筛"白白造一个新数组）。
 *
 *  ⚠️ **2026-10-13 起日历不再用它渲染**（用户口径：筛掉的类型不要变成「休息」，
 *  而是**保留场次、只降低那些格子的透明度**）。它仍然用于"按类型取数"这类真筛选场景
 *  （例如测试与将来的 services 侧）。日历用的是下面的 `cellMatchesTypes` /
 *  `dimmedKeys` —— 那两个才是"筛选即强调"的口径。 */
export function filterByTypes<T extends { category?: string }>(
  sessions: T[], types: string[],
): T[] {
  if (!types.length) return sessions
  const want = new Set(types)
  return sessions.filter((s) => want.has(s.category ?? 'live'))
}

/** 这一格里**有没有**命中选中类型的场次（空选择 = 全都算命中）。
 *
 *  ⚠️ 判据是"任意一场命中"而不是"全部命中"：一天里可能既有歌回又有游戏，
 *  用户选了歌回 ⇒ 那一格该**保持高亮**（它含他要看的东西），
 *  而不是因为"还混着别的类型"被判成不匹配。
 */
export function cellMatchesTypes<T extends { category?: string }>(
  sessions: T[], types: string[],
): boolean {
  if (!types.length) return true
  const want = new Set(types)
  return sessions.some((s) => want.has(s.category ?? 'live'))
}

/** 需要**降透明度**的日期格 key（空选择 ⇒ 空集 = 谁都不降）。
 *
 *  只有"有场次、但一场都没命中"的格子降 —— 空日子本来就没内容，降了反而像坏了。
 */
export function dimmedKeys<T extends { category?: string }>(
  cells: { key: string; sessions: T[] }[], types: string[],
): Set<string> {
  if (!types.length) return new Set()
  const out = new Set<string>()
  for (const c of cells) {
    if (c.sessions.length && !cellMatchesTypes(c.sessions, types)) out.add(c.key)
  }
  return out
}

export interface TypeCount {
  key: string
  n: number
}

/**
 * 当月各类型场次数（按 `order` 排；0 场的不出现）。
 *
 * ⚠️ 入参应当是**全量**场次：用筛过的集合会导致"选中「歌回」之后其余类型的计数凭空消失"，
 * 用户就再也切不到别的类型了（筛选空间被自己的选择吃掉）。
 *
 * `order` 由调用方给（日历用 `LIVE_TYPE_ORDER`）—— 本函数不认识任何具体类型，
 * 这样以后加/减品类只需要改一处顺序表。
 */
export function countByType(
  sessions: LiveSession[], order: readonly string[],
): TypeCount[] {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const k = keyOf(s)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return order
    .map((key) => ({ key, n: counts.get(key) ?? 0 }))
    .filter((t) => t.n > 0)
}
