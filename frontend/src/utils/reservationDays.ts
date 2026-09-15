/**
 * 直播预约 → 日历格（R13，devlog/088）的**纯逻辑**。
 *
 * 为什么单独抽出来：这三条判错了界面不会报错，只会"少显示一个预约"或"把预约说成待定"——
 * 而预约恰恰是用户**唯一**能提前知道"明天几点开播"的信息（动态里那张预约卡片，
 * 服务端已解析成时刻）。
 *
 * 口径（与后端 `VtuberEventRepo.future_reservations` 对齐）：
 * - 服务端**已经**过滤掉「已结束」「时刻已过」「超出 days 天」，所以前端不再重复过滤；
 * - `start_at` 是北京 wall-clock（naive）：`new Date("YYYY-MM-DDTHH:mm:ss")` 按本地时区解析；
 * - 一天的多个预约按时刻升序，格内只展示**最早那一条**（与场次口径一致：单场呈现 + 计数）。
 */
import type { UpcomingReservation } from '../api/types'
import { dayKeyIso, fmtTime } from '../components/live/liveCalendarFmt'

/** 按天分组（键 = `dayKeyIso`，与场次分组同一口径，两边才能对上同一格） */
export function groupReservationsByDay(
  list: UpcomingReservation[],
): Map<string, UpcomingReservation[]> {
  const m = new Map<string, UpcomingReservation[]>()
  for (const r of list) {
    const d = new Date(r.start_at)
    if (Number.isNaN(d.getTime())) continue
    const k = dayKeyIso(d)
    const arr = m.get(k)
    if (arr) arr.push(r)
    else m.set(k, [r])
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.start_at.localeCompare(b.start_at))
  }
  return m
}

/**
 * 格子右上角徽章文案。**优先级：场次类型 > 预约 > 休息/待定**。
 *
 * 「预约」要盖过「待定」：没有场次但**有预约**的日子，其实是"确定会开播"，
 * 报「待定」等于把已知信息藏起来（这正是本需求要解决的问题）。
 */
export function cellBadge(opts: {
  hasSession: boolean
  typeLabel: string
  hasReservation: boolean
  isPast: boolean
}): string {
  if (opts.hasSession) return opts.typeLabel
  if (opts.hasReservation) return '预约'
  return opts.isPast ? '休息' : '待定'
}

export interface ReservationLine {
  /** HH:MM（本地解析 wall-clock） */
  time: string
  title: string
  /** 同日多条时的「另有 N 条」提示；单条为空串 */
  more: string
  /** 计数槽文案：预约人数（**不再重复"预约"二字** —— 徽章已经写了）；
   *  人数未知且只有一条时为空串（不占位、不写废话） */
  totalLabel: string
}

/** 格内/浮层用的预约展示行（取最早一条） */
export function reservationLine(list: UpcomingReservation[]): ReservationLine | null {
  const first = list[0]
  if (!first) return null
  const d = new Date(first.start_at)
  const time = Number.isNaN(d.getTime()) ? '' : fmtTime(d)
  const total = first.reserve_total ?? 0
  return {
    time,
    title: first.title || '预约',
    more: list.length > 1 ? `另有 ${list.length - 1} 条` : '',
    totalLabel: total > 0 ? `${total.toLocaleString('zh-CN')} 人预约` : '',
  }
}
