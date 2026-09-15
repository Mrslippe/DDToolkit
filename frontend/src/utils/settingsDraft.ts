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
