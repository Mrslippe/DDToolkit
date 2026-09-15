/**
 * 未来直播预约的取数（R13，devlog/088）。
 *
 * 为什么单独一个小 hook 而不是塞进 `useLiveSessions`：后者的 **effect 顺序与依赖数组是契约**
 * （文件顶部写明了，devlog/057 那批的教训）—— 往里加一条取数会动到那份顺序。
 *
 * 数据来源：`GET /vtuber/{id}/future-reservations`（**per-V**，一次请求）。
 * 日历本身是单 V 的（`accountId` → 该 V 的主账号），所以不需要"全部 V 聚合端点"；
 * 预约是 V 级的（同一 V 的多个账号共用），因此按 `vtuberId` 而不是账号取。
 *
 * 失败**不清空**已有数据：预约是"锦上添花"的信息，上游/网络出问题时日历照常可用，
 * 只是没有预约标记（下次 `refreshTick` 会再试）。
 */
import { useEffect, useRef, useState } from 'react'

import type { UpcomingReservation } from '../../api/types'
import { api } from '../../api/api'

export function useReservations(
  vtuberId: number | null,
  refreshTick: number,
): UpcomingReservation[] {
  const [list, setList] = useState<UpcomingReservation[]>([])
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (vtuberId == null) {
      setList([])
      return
    }
    void api
      .futureReservations(vtuberId)
      .then((rows) => {
        if (aliveRef.current) setList(rows ?? [])
      })
      .catch(() => {
        /* 取不到就保持现状（不清空）：日历不因预约请求失败而变空 */
      })
  }, [vtuberId, refreshTick])

  return list
}
