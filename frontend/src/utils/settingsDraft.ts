/**
 * 设置弹窗的输入处理（R14a，devlog/091）—— 纯函数，有单测。
 *
 * 为什么值得单独一个模块：这几条判定的错法**都在界面上看不出来**。
 * - 把"输入框清空"当成 0：用户删掉内容去倒杯水，回来点保存 —— 间隔变成 0 秒，
 *   于是一轮抓取变成"贴着风控跑"（这正是后端范围校验想拦的东西，前端不该先把它造出来）。
 * - 把 "1." / "abc" 这类中间态当成 NaN 直接写回受控输入框：输入框会自己清空，
 *   用户看到光标一跳、数字消失（React 受控组件的经典坑）。
 * - 校验用硬编码阈值而不是后端下发的 spec：两边慢慢分叉，界面允许 999、后端 400。
 */

export type SettingKind = 'int' | 'float' | 'bool'

/** 草稿值：`''` = 输入框被清空或当前是非法中间态（**不当成 0**） */
export type DraftVal = number | boolean | ''

/** 校验只需要这几个字段（`SettingSpec` 结构上兼容它） */
export interface RangeSpec {
  kind: SettingKind
  min: number | null
  max: number | null
  unit: string
  default: number | boolean
  value: number | boolean
}

/** 输入框文本 → 草稿值 */
export function parseField(raw: string, kind: SettingKind): DraftVal {
  if (raw.trim() === '') return ''
  const n = kind === 'int' ? Number.parseInt(raw, 10) : Number.parseFloat(raw)
  return Number.isNaN(n) ? '' : n
}

/** 单字段校验（**范围来自后端 spec**）；合法返回 null */
export function fieldError(spec: RangeSpec, value: DraftVal): string | null {
  if (spec.kind === 'bool') return null
  if (value === '' || typeof value === 'boolean') return '需要一个数字'
  const n = Number(value)
  if (Number.isNaN(n)) return '需要一个数字'
  if (spec.min !== null && n < spec.min) return `不能小于 ${spec.min}${spec.unit}`
  if (spec.max !== null && n > spec.max) return `不能大于 ${spec.max}${spec.unit}`
  return null
}

/** 显示值 = 草稿 → 后端给的当前生效值 */
export function valueOf(spec: RangeSpec, draft: Record<string, DraftVal>, key: string): DraftVal {
  return draft[key] !== undefined ? draft[key] : spec.value
}

// ── 数字步进（R21 批 2，devlog/101）────────────────────────────────────
// 数字框改成"左减右加"的整行步进条。这三条判定同样"错了界面上看不出来"：
// 步子太大 → 3 秒想调到 3.5 秒调不到；不夹范围 → 一路按到 999 再等后端 400；
// 空值/布尔也给箭头 → 点一下把 `''` 变成 NaN，输入框自己清空（另一个经典坑）。

/**
 * 一步走多少。
 *
 * 整数按 1；小数**按跨度分档**：跨度 < 30 的按 0.5（0.5~10 秒的账号间隔，用户就是想调半秒），
 * 跨度大的按 1（0~3600 秒的直播轮询，0.5 秒的步子等于没步）。
 */
export function stepOf(spec: RangeSpec): number {
  if (spec.kind === 'int') return 1
  const lo = spec.min ?? 0
  const hi = spec.max ?? 0
  return hi - lo < 30 ? 0.5 : 1
}

/** 箭头该不该置灰：到界了、当前值不是数字（空串 / 中间态）、或者这是布尔项 */
export function atBound(spec: RangeSpec, current: DraftVal, dir: 1 | -1): boolean {
  if (spec.kind === 'bool' || current === '' || typeof current === 'boolean') return true
  const v = Number(current)
  if (!Number.isFinite(v)) return true
  return dir > 0 ? (spec.max !== null && v >= spec.max) : (spec.min !== null && v <= spec.min)
}

/**
 * 点一次箭头后的新值（夹在 `[min,max]` 内，并按 0.1 消除浮点噪声 ——
 * 否则 3.0 + 0.5 会写出 3.5 但 0.1+0.2 那一类会变成 0.30000000000000004，
 * 输入框里就会显示一长串）。
 * 当前值不可用时返回 null（调用方忽略这次点击；按钮此时本来就是置灰的）。
 */
export function bump(spec: RangeSpec, current: DraftVal, dir: 1 | -1): number | null {
  if (spec.kind === 'bool' || current === '' || typeof current === 'boolean') return null
  const v = Number(current)
  if (!Number.isFinite(v)) return null
  const next = Math.round((v + dir * stepOf(spec)) * 10) / 10
  const lo = spec.min ?? -Infinity
  const hi = spec.max ?? Infinity
  return Math.min(hi, Math.max(lo, next))
}

/** 与"当前生效值"不同的键（只有这些会被提交；空串也算改过，由校验拦住不让存） */
export function dirtyKeys(
  specs: { key: string }[],
  draft: Record<string, DraftVal>,
): string[] {
  return specs.filter((s) => draft[s.key] !== undefined && draft[s.key] !== (s as unknown as RangeSpec).value)
    .map((s) => s.key)
}

/** 提交体（`''` 不会被提交：调用方在 `fieldError` 有值时会禁用保存） */
export function buildPayload(
  dirty: string[],
  draft: Record<string, DraftVal>,
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {}
  for (const key of dirty) {
    const v = draft[key]
    if (v !== '' && typeof v !== 'undefined') out[key] = v as number | boolean
  }
  return out
}

/**
 * 跨字段约束（R17）：**与后端 `runtime_settings.PAIRS` 同一套**，前端这层只是
 * "提前提示 + 拦住保存按钮"，**真判定仍在后端**（越界/跨字段一律 400，detail 是中文原因）。
 *
 * 为什么值得在前端也写一遍：R17 起设置窗口分成多页，跨字段冲突（上限 < 下限）
 * 涉及的两个字段在**同一页**、但用户可能已经翻到别的页去点保存 —— 后端报错会落在
 * 底部错误条上，而那一页看不见。有这一层，"上限不能小于下限"就会出现在出问题的那一行。
 *
 * `[被约束的键, 依赖的键, 说明]`：约束是"第一个键不能小于第二个键"。
 */
export const PAIRS: [string, string, string][] = [
  ['REQUEST_INTERVAL_MAX', 'REQUEST_INTERVAL_MIN', '账号间隔上限不能小于下限'],
  ['MANUAL_FAST_INTERVAL_MAX', 'MANUAL_FAST_INTERVAL_MIN', '收录间隔上限不能小于下限'],
]

export interface PairProblem {
  /** 报在哪一行（＝第一个键，也就是"上限"那一行） */
  key: string
  message: string
}

/**
 * 在**合并后的最终值**上查跨字段冲突。
 * `values` 要给"当前显示值"（草稿优先），这样用户改到一半就能看到提示；
 * 任一键拿不到合法数字（清空/非法中间态）时跳过 —— 那种情况已由 `fieldError` 报了。
 */
export function pairProblems(
  values: Record<string, DraftVal>,
): PairProblem[] {
  const out: PairProblem[] = []
  for (const [higher, lower, why] of PAIRS) {
    const a = values[higher]
    const b = values[lower]
    if (a === '' || b === '' || a === undefined || b === undefined) continue
    if (typeof a === 'boolean' || typeof b === 'boolean') continue
    const na = Number(a)
    const nb = Number(b)
    if (Number.isNaN(na) || Number.isNaN(nb)) continue
    if (na < nb) out.push({ key: higher, message: `${why}（${na} < ${nb}）` })
  }
  return out
}
