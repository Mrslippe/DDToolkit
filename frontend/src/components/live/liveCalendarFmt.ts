/**
 * 直播日历的**纯展示格式化**（P2 分层收敛 A 批次：从 `LiveCalendar.tsx` 搬出，**只搬不改**）。
 *
 * 为什么单独成文件而不是塞进 hooks：这些函数没有 React 依赖，是**可机器验证**的纯逻辑。
 * 本项目没有组件测试运行器，所以「能测的部分」和「只能靠 ui_probe + 肉眼的部分」要分开——
 * 搬出后由 `liveCalendarFmt.test.ts` 钉住（时长/金额/时间格式化与「刚结束」判定都是
 * 用户直接看到、且有真实边界 case 的东西）。
 *
 * 留在组件里的（**故意不搬**）：`WEEKDAYS_EN` / `MONTH_CN` / `POP_CLOSE_GRACE_MS`
 * 是渲染常量与交互时序常量，搬动只增加 diff 面积、不增加可验证性。
 */
import type { LiveSession } from '../../api/types'
import { inferLiveType } from '../../utils/liveType'

/**
 * 场次是否「刚结束」（<24h，按结束时间；未结束按开始时间）。
 *
 * 用途：第三方弹幕收录有数小时延迟（danmakus 侧 total 可能仍为 0），
 * 刚下播的场次「暂无弹幕」是常态而非异常——提示文案要区分这两种情形。
 */
export function isFreshSession(startAt: string, endAt: string | null | undefined): boolean {
  const ms = new Date(endAt || startAt).getTime()
  if (!Number.isFinite(ms)) return false
  return Date.now() - ms < 24 * 3600 * 1000
}

/** 本地日期 → "YYYY-MM-DD"（日历格子 key；**不经过 UTC**，避免东八区错一天） */
export function dayKeyIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 「2026年09月」（月份胶囊内文字）；m 为 0-based */
export function fmtMonth(y: number, m: number): string {
  return `${y}年${String(m + 1).padStart(2, '0')}月`
}

/** 「20:31」（真实分钟——M4 起数据为秒级起止，不再取整点） */
export function fmtTime(d: Date): string {
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 「3小时12分」；不足 1 分钟或空值 → 空串 */
export function fmtDur(min: number | null | undefined): string {
  if (min == null || min < 1) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}小时${m}分` : `${m}分`
}

/** 「¥10,501.5」；空值 → 空串（调用方负责回退「—」） */
export function fmtMoney(v: number | null | undefined): string {
  if (v == null) return ''
  return `¥${v.toLocaleString('zh-CN')}`
}

/** 类型 key（服务端）→ 展示；**服务端缺失时**按标题关键词兜底 */
export function keyOf(s: LiveSession): string {
  return s.category ?? inferLiveType(s.live_title).key
}

/**
 * 卡片右上角的**数据来源标注**（R3，2026-09-13 用户：要能看到"数据来自 danmakus"）。
 *
 * 按**实际场次的 `source` 组合标记**判定，而不是写死一句文案 —— 场次来源有三种：
 * `danmakus`（第三方索引）/ `danmakus+self`（含本地快照补段校正）/
 * `feed`（平台直播状态推导，无第三方收录）/ `self`（纯本地快照）。
 * 这样"这页数据到底谁给的"永远与列表内容一致。
 */
export function calendarSourceLabel(sessions: { source?: string | null }[]): string {
  const kinds = new Set<string>()
  for (const s of sessions) {
    for (const p of (s.source ?? '').split('+')) {
      const k = p.trim()
      if (k) kinds.add(k)
    }
  }
  if (kinds.size === 0) return '数据自动同步'
  const parts: string[] = []
  if (kinds.has('danmakus')) parts.push('danmakus')
  if (kinds.has('self')) parts.push('本地快照')
  if (kinds.has('feed')) parts.push('平台直播状态')
  return `数据来自 ${parts.join(' + ')}`
}
