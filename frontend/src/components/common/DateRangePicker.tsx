import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  RANGE_PRESETS,
  fmtDate,
  matchPreset,
  monthGrid,
  parseDate,
  presetRange,
  shiftMonths,
  today,
  ymKey,
} from '../../utils/dateRange'
import type { DateRange, RangePreset } from '../../utils/dateRange'

export type { DateRange }

/** 星期表头：周一为首（与 P10-A 参考图一致） */
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

interface Props {
  /** 已应用的区间：每次挂载时作为草稿初值 → 关闭再打开自动回到已应用态（不泄漏草稿） */
  value: DateRange
  /** 点「确认」提交草稿（空区间也走这里 = 清除） */
  onConfirm: (r: DateRange) => void
  /** 草稿变化（供外层在分组标题上回显**草稿**——弹窗是草稿域，标题跟着草稿走才不打架） */
  onDraftChange?: (r: DateRange) => void
}

/**
 * 双月历日期区间选择器（P10-A，形式与功能参照用户 2026-09-10 参考图）。
 *
 * 形态：
 * - 左右两块月份面板**各自独立翻月**（跨年区间靠「左管起点 / 右管终点」两块分工，
 *   参考图里 2022年7月 与 2026年9月 同时在场即此设计）；
 * - 星期表头一…日（周一为首）、恒 6 行 × 7 列、非本月补位格淡化；
 * - 区间连续色带（两端 6px 圆角）+ 端点主色实底白字 + 今天「描边环 + 数字下圆点」；
 * - 底部预设六枚（近一周/一月/三月/一年/两年/所有）+ 主色「确认」。
 *
 * 交互：
 * - **草稿制**：所有改动只落内部草稿，`确认` 才回调 → 点外关闭 / Esc 不留下半截筛选；
 * - 选点：无起点或两端已齐 → 点为起点；已有起点 → 点为终点；点到起点之前 → 视为重选起点；
 * - 起点落定后右面板自动跳到「起点月 + 1」；点预设后左右面板分别跳到区间首月 / 末月；
 * - 只落定起点时（半开区间）`确认` 禁用，避免把「还没选完」当成单日区间提交；
 * - 悬停预览未落定区间（预览端点走浅色描边，不冒充已选端点）。
 *
 * 日期算术全部在 `utils/dateRange.ts`（可脱离组件验证）。
 */
export default function DateRangePicker({ value, onConfirm, onDraftChange }: Props) {
  const [draft, setDraft] = useState<DateRange>(value)
  const [hover, setHover] = useState('')
  const [left, setLeft] = useState<Date>(() => parseDate(value.from) ?? today())
  const [right, setRight] = useState<Date>(() => {
    const f = parseDate(value.from)
    const t = parseDate(value.to)
    // 已应用区间跨月 → 右面板直接落在终点月；否则右面板 = 起点月 + 1
    if (t && f && ymKey(t) !== ymKey(f)) return t
    return shiftMonths(f ?? today(), 1)
  })

  /** 唯一写草稿的入口：同时通知外层（标题回显用） */
  const commitDraft = (r: DateRange) => {
    setDraft(r)
    onDraftChange?.(r)
  }

  const fromD = parseDate(draft.from)
  const toD = parseDate(draft.to)
  const hoverD = parseDate(hover)
  const incomplete = !!draft.from !== !!draft.to

  /** 展示区间：半开态下用指针所在日当临时终点（正反向都成立） */
  const shown = (() => {
    if (!fromD) return null
    const other = toD ?? hoverD
    if (!other) return { lo: fromD, hi: fromD }
    return other < fromD ? { lo: other, hi: fromD } : { lo: fromD, hi: other }
  })()
  /** 末端只是悬停预览（未落定）→ 预览端点走浅色描边 */
  const previewHi = !toD && !!hoverD

  const pick = (day: Date) => {
    setHover('')
    const s = fmtDate(day)
    // 起一轮新选择（无起点 / 两头已齐 / 点到起点之前）
    if (!draft.from || draft.to || s < draft.from) {
      commitDraft({ from: s, to: '' })
      setLeft(day)
      setRight(shiftMonths(day, 1))
      return
    }
    commitDraft({ from: draft.from, to: s })
  }

  const applyPreset = (p: RangePreset) => {
    const r = presetRange(p)
    commitDraft(r)
    setHover('')
    const f = parseDate(r.from)
    const t = parseDate(r.to)
    // 左右面板分跳区间首月 / 末月（同月时右面板顺延一月，避免两块面板显示同一个月份）
    setLeft(f ?? today())
    setRight(t && f && ymKey(t) !== ymKey(f) ? t : shiftMonths(f ?? today(), 1))
  }

  const activePreset = matchPreset(draft)

  const renderPanel = (month: Date, setMonth: (d: Date) => void) => {
    const tKey = fmtDate(today())
    const loKey = shown ? fmtDate(shown.lo) : ''
    const hiKey = shown ? fmtDate(shown.hi) : ''

    return (
      <div className="drp-panel" key={ymKey(month)}>
        <div className="drp-head">
          <button type="button" className="drp-nav" title="上个月" onClick={() => setMonth(shiftMonths(month, -1))}>
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="drp-title">
            {month.getFullYear()}年{month.getMonth() + 1}月
          </span>
          <button type="button" className="drp-nav" title="下个月" onClick={() => setMonth(shiftMonths(month, 1))}>
            <ChevronRight className="size-3.5" />
          </button>
        </div>
        <div className="drp-wd">
          {WEEKDAYS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="drp-grid" onMouseLeave={() => setHover('')}>
          {monthGrid(month).map((d) => {
            const k = fmtDate(d)
            const isLo = k === loKey
            const isHi = k === hiKey
            const cls = [
              'drp-day',
              d.getMonth() !== month.getMonth() && 'pad',
              k === tKey && 'today',
              !!shown && d >= shown.lo && d <= shown.hi && 'band',
              isLo && 'edge-l',
              isHi && 'edge-r',
              (isLo || isHi) && (isHi && previewHi ? 'preview' : 'sel'),
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <button
                type="button"
                key={k}
                className={cls}
                onClick={() => pick(d)}
                onMouseEnter={() => {
                  if (fromD && !toD) setHover(k)
                }}
              >
                <span className="drp-day-num">{d.getDate()}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="drp">
      <div className="drp-panels">
        {renderPanel(left, setLeft)}
        {renderPanel(right, setRight)}
      </div>
      <div className="drp-foot">
        <div className="drp-presets">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`drp-preset${activePreset === p.key ? ' on' : ''}`}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="drp-confirm"
          disabled={incomplete}
          title={incomplete ? '起点与终点各选一个' : '应用该区间'}
          onClick={() => onConfirm(draft)}
        >
          确认
        </button>
      </div>
    </div>
  )
}
