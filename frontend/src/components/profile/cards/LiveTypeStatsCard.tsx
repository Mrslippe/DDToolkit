/**
 * 「场次类型」卡片（T4，2026-10-12，`devlog/467`）—— 用户口径：
 * 「按类型查询/统计是我们确实要做的」＋「两处都要」（另一处是日历上的类型筛选）。
 *
 * 数据：`GET /account/{id}/live-type-stats`（**类型已落库**：f016 加列，**f017 起真的能
 * 按列聚合** —— 代表行的 `session_key` + 兜底也落库，见 `devlog/471`）。
 *
 * ⚠️ 三条口径（都在 `utils/liveTypeStats.ts` 里，纯函数、有单测）：
 * 1. 计数是**生效值**（校正 > 落库值 > 同一口径现算）—— 与日历上显示的类型同源，
 *    所以卡片上的数字**数得回来**（用户在日历上数一遍应当一致）；
 * 2. `classified`（**定稿过**的场次数）与 `total` 的差要**如实说出来**：差的那部分是
 *    "规则还没定出来"的场次（它们读的时候显示成中性的「直播」）；
 * 3. 一场都没有 ⇒ 说"没有记录"，不画一排 0 长的柱子（那看起来像"全是 0"）。
 *
 * 为什么是**行 + 横条**而不是饼图：9 个品类的占比用饼图读不出个数，而这张卡要回答的
 * 恰恰是"各类各多少场"；横条还能把标签、计数、占比三样排在同一行里。
 */
import { useEffect, useState } from 'react'

import { api } from '../../../api/api'
import type { LiveTypeStats } from '../../../api/types'
import type { CardContext } from '../cardRegistry'
import { liveTypeLabel } from '../../../utils/liveType'
import { typeBreakdown, unclassifiedNote } from '../../../utils/liveTypeStats'

export default function LiveTypeStatsCard({ account, refreshTick }: CardContext) {
  const [stats, setStats] = useState<LiveTypeStats | null>(null)
  const [failed, setFailed] = useState(false)
  /* ⚠️ 依赖要写**取出来的 id**（同 `GiftDaysCard` 的理由：`exhaustive-deps` 证明不了
     `account?.id` 与 effect 体里的 `account` 同源）。 */
  const accountId = account?.id ?? null

  useEffect(() => {
    if (accountId === null) return
    let cancelled = false
    setStats(null)
    setFailed(false)
    api.liveTypeStats(accountId)
      .then((d) => { if (!cancelled) setStats(d) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [accountId, refreshTick])

  if (!account) return <p className="pcard-empty">这个 V 还没有账号</p>
  if (failed) return <p className="pcard-empty">类型统计没取到（本地库读失败）—— 切走再切回来会重试</p>
  if (stats === null) {
    return (
      <div className="lts" data-card-body="live-type-stats" data-pending="1">
        <span className="lc-skel lts-skel" />
      </div>
    )
  }
  const rows = typeBreakdown(stats)
  if (!rows.length) {
    return <p className="pcard-empty">还没有直播场次记录 —— 收录该 V 之后会自动回填历史场次</p>
  }
  const note = unclassifiedNote(stats)

  return (
    <div className="lts" data-card-body="live-type-stats"
         data-lts-total={stats.total} data-lts-classified={stats.classified}
         data-lts-kinds={rows.length}>
      {rows.map((r) => (
        <div key={r.key} className="lts-row" data-lts-row={r.key} data-lts-count={r.count}>
          <span className={`lc-stat-pill lts-pill lc-stat-pill--${r.key}`}>{r.label}</span>
          <span className="lts-bar" aria-hidden="true">
            <span className={`lts-fill lc-stat-pill--${r.key}`} style={{ width: `${r.percent}%` }} />
          </span>
          <span className="lts-num">{r.count}</span>
          <span className="lts-pct">{r.percent}%</span>
        </div>
      ))}
      {note && <p className="lts-note" data-lts-note="">{note}</p>}
    </div>
  )
}

/** 卡片抬头要用到的标签映射（导出给单测对账：卡片上的标签必须来自这一处）。 */
export { liveTypeLabel }
