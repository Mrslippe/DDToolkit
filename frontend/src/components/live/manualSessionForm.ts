/**
 * 手动记录/编辑场次表单的**纯逻辑**（B2，devlog/454）。
 *
 * 为什么单独成文件：这一批里最容易静默错的东西是**时间在"用户看到的墙上时间"与
 * "发给服务端的字符串"之间来回折**（差一个时区，用户看到的是"我填的 20:30 变成了 04:30"，
 * 而代码里两个方向都"看起来对"）。这类换算必须能被机器验证，所以从组件里搬出来，
 * 由 `manualSessionForm.test.ts` 钉住 —— 组件本身只剩渲染与请求。
 *
 * ## 时间口径（与后端 `app/domain/live_manual.py::to_utc_naive` 成对）
 *
 * `<input type="datetime-local">` 的 value 是**不带时区**的本地墙上时间（`2026-10-08T20:30`）。
 * 我们就**原样**发给后端，由它按本机时区换算成 UTC 落库。
 * ⚠️ 千万别在这里 `new Date(v).toISOString()`：那会按**浏览器**时区先折一次，
 * 服务端再按本机时区折第二次 —— 桌面端两者通常是同一个时区（所以"测不出来"），
 * 但探针/浏览器里跑就是两个时区，凭空偏掉一个时差。
 */
import type { LiveSession, LiveSessionWriteIn } from '../../api/types'

/** 表单的四个字段（都是字符串：`datetime-local` 的 value 就是字符串，不做中间转换） */
export interface ManualFormValues {
  title: string
  /** `YYYY-MM-DDTHH:mm`（本地墙上时间） */
  start: string
  /** 同上；空串 = 未记结束（进行中） */
  end: string
  /** 录播地址：BV 号或 B 站链接，原样交给服务端规范化 */
  vod: string
}

/** ISO 时间 → `datetime-local` 的 value（本地墙上时间）；空/非法 → 空串（输入框留空） */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 输入框的值 → 请求体里的值：空串 → `null`（"没有这个时间"），其余原样 */
export function fromLocalInput(v: string): string | null {
  const s = v.trim()
  return s === '' ? null : s
}

/**
 * 新建时的默认时段：**今天 20:00–22:00**（本地）。
 *
 * 为什么是晚八点而不是"现在"或"当前选中那格"：这个入口要补的多半是**已经播过**的场次，
 * 而"现在"通常还在播；20:00 是直播最常见的开播时段，改一下比从零填快。
 * 不跟随日历当前月份：日历翻页时"这一格属于哪个月"对用户并不明确，
 * 猜错反而会让记录落到看不见的月份里。
 */
export function defaultManualRange(now: Date): { start: string; end: string } {
  const day = toLocalInput(now.toISOString()).slice(0, 10)
  return { start: `${day}T20:00`, end: `${day}T22:00` }
}

/** 场次 → 表单初值（编辑模式；字段缺失就是空串，不做任何猜测） */
export function formFromSession(s: LiveSession): ManualFormValues {
  return {
    title: s.live_title ?? '',
    start: toLocalInput(s.start_at),
    end: toLocalInput(s.end_at),
    vod: s.vod_url ?? '',
  }
}

/**
 * 只把**改动过**的字段放进请求体（服务端按 `exclude_unset` 语义处理）。
 *
 * 为什么不能整份提交：`end_at: null` 在服务端的意思是"清空结束时间"，
 * 整份提交会把"用户只是改了标题"变成"顺手把结束时间也清了" —— 静默丢数据。
 * 空串的语义一并在这里定死：`vod` 清空 → `''`（服务端认它 = 清空），
 * `end` 清空 → `null`（服务端认它 = 改回进行中）。
 */
export function buildManualPatch(orig: ManualFormValues,
                                next: ManualFormValues): LiveSessionWriteIn {
  const patch: LiveSessionWriteIn = {}
  if (next.title.trim() !== orig.title.trim()) patch.title = next.title.trim()
  if (next.start !== orig.start) patch.start_at = next.start
  if (next.end !== orig.end) patch.end_at = fromLocalInput(next.end)
  if (next.vod.trim() !== orig.vod.trim()) patch.vod_url = next.vod.trim()
  return patch
}

/** 有没有改动（保存按钮的可用性判据；没有改动时服务端会 422，别让它白跑一趟） */
export function hasChanges(orig: ManualFormValues, next: ManualFormValues): boolean {
  return Object.keys(buildManualPatch(orig, next)).length > 0
}

/** 新建时是否填够了（开始时间必有；结束时间可空 = 进行中） */
export function canSubmitNew(next: ManualFormValues): boolean {
  return next.start.trim() !== ''
}

/**
 * 录播链接的**显示文字**：规范地址里那一段 BV 号（「录播 BV1xx411c7mD」比「打开录播」有信息量）。
 *
 * 认不出来就退回通用文案 —— 服务端入库前一定规范过（一定有 BV），所以这个兜底
 * 只在"数据是别处写进来的"时候生效，绝不能因为认不出就让链接点不了。
 */
export function vodLabel(url: string | null | undefined): string {
  const m = /BV[0-9A-Za-z]{10}/.exec(url ?? '')
  return m ? m[0] : '打开录播'
}
