import { useEffect, useRef, useState } from 'react'
import { Ghost } from 'lucide-react'
import FloatPill from './common/FloatPill'
import DateRangePicker from './common/DateRangePicker'
import OverlayScroll from './OverlayScroll'
import { rangeText } from '../utils/dateRange'
import type { DateRange } from './common/DateRangePicker'
import './../styles/posts.css'

/** 归档过滤：all=全部（含已归档） unarchived=仅未归档 archived=仅已归档 */
export type ArchivedFilter = 'all' | 'unarchived' | 'archived'

/** 归档三态（P10-A：把后端早已支持的 is_archived=false 一并接线出来） */
const ARCHIVED_OPTS: { key: ArchivedFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unarchived', label: '仅未归档' },
  { key: 'archived', label: '仅已归档' },
]

interface Props {
  deletedOnly: boolean
  onDeletedToggle: () => void
  archived: ArchivedFilter
  onArchivedChange: (v: ArchivedFilter) => void
  /** 已应用的时间区间 */
  range: DateRange
  /** 点「确认」提交区间（含清空） */
  onRangeConfirm: (r: DateRange) => void
  /** 三项一并复位（由页面统一执行 → 只触发一次回顶） */
  onReset: () => void
  deletedCount: number
  archivedCount: number
}

/**
 * list 视图「筛选」下拉弹窗（P10-A）。
 *
 * 此前筛选行右侧是「时间钮 + 已删钮 + 已归档钮」三件并排（越挤越长，类型 chips 被迫换行），
 * 现收敛为**单钮 + 单弹窗**，三分区：
 *
 * - **状态**：已删（墓碑）—— 即时生效（沿用 §C3 侧栏筛选弹窗口径，不引入应用按钮）；
 * - **归档**：全部 / 仅未归档 / 仅已归档 —— 即时生效；
 * - **时间范围**：双月历区间选择器（`common/DateRangePicker`，草稿制 + 确认）；
 * - 底部 `重置`：三项一并复位。
 *
 * 弹窗规格走 UI-MAP §C6：12px 圆角 + 发丝边 + `--shadow-dialog` + `lc-dlg-pop` 0.16s +
 * **点外关闭 / Esc 双通道**；z-index 沿用锚定浮窗档 30。
 * 分组语言（`.pop-group` / `.pop-label` / `.pop-chips` / `.pop-actions`）与侧栏筛选弹窗同源。
 */
export default function PostFilterPop({
  deletedOnly,
  onDeletedToggle,
  archived,
  onArchivedChange,
  range,
  onRangeConfirm,
  onReset,
  deletedCount,
  archivedCount,
}: Props) {
  const [open, setOpen] = useState(false)
  /** 重置时强制重挂选择器：草稿/月份是组件内部态，不复位会留下「已重置但日历还亮着」的假象 */
  const [pickEpoch, setPickEpoch] = useState(0)
  /** 草稿区间文案：分组标题跟着**草稿**走（弹窗是草稿域；标题显示已应用值会与
   *  眼前高亮的区间打架——「近一月」亮着却写「全部时间」）。触发器的 `筛选 · N`
   *  才是已应用态的出口。 */
  const [draftText, setDraftText] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 生效条件清单：既做触发器 active 判定，也做 tooltip 回显
  const applied: string[] = []
  if (deletedOnly) applied.push('仅已删')
  if (archived === 'unarchived') applied.push('仅未归档')
  if (archived === 'archived') applied.push('仅已归档')
  const appliedRange = rangeText(range)
  if (appliedRange) applied.push(appliedRange)
  const on = applied.length > 0

  return (
    <div className="pfilter-wrap" ref={wrapRef}>
      <FloatPill
        size="md"
        shape="text"
        active={on}
        className="pfilter-btn"
        title={on ? `筛选：${applied.join(' · ')}` : '筛选：已删 / 归档 / 时间范围'}
        onClick={() => setOpen((o) => !o)}
      >
        {on ? `筛选 · ${applied.length}` : '筛选'}
        <svg
          className="pill-caret"
          viewBox="0 0 6.63232 6.63232"
          width="6.632324"
          height="6.632324"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          <path
            d="M5.96034 0.5L0.960327 0.500005L4.46033 5.5L5.96034 0.5Z"
            fill="currentColor"
            fillRule="evenodd"
          />
          <path
            d="M5.96034 0.5L4.46033 5.5L0.960327 0.500005L5.96034 0.5Z"
            fillRule="evenodd"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      </FloatPill>

      {open && (
        <div className="post-filter-pop">
          {/* 三分区放进覆盖式滚动体：弹窗高度受「列表页可用高度」封顶（见 posts.css .post-filter-pop
              的 max-height 注释）——窗口很矮时内部滚动，而不是被 .posts-panel 裁掉底部操作 */}
          <OverlayScroll className="pfilter-scroll">
            <div className="pop-group">
              <span className="pop-label">状态</span>
              <div className="pop-chips">
                <button
                  type="button"
                  className={`filter-chip${deletedOnly ? ' on' : ''}`}
                  title="仅显示已删除的帖子（墓碑，v0.5.1）"
                  onClick={onDeletedToggle}
                >
                  <Ghost className="size-3.5" />
                  已删 {deletedCount}
                </button>
              </div>
            </div>

            <div className="pop-group">
              <span className="pop-label">归档</span>
              <div className="pop-chips">
                {ARCHIVED_OPTS.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    className={`filter-chip${archived === o.key ? ' on' : ''}`}
                    title={
                      o.key === 'archived'
                        ? '仅显示已归档的帖子（早于归档截止日，不再参与追新）'
                        : o.key === 'unarchived'
                          ? '仅显示未归档的帖子（归档截止日之后的追新范围）'
                          : '全部（含已归档）'
                    }
                    onClick={() => onArchivedChange(o.key)}
                  >
                    {o.label}
                    {o.key === 'archived' ? ` ${archivedCount}` : ''}
                  </button>
                ))}
              </div>
            </div>

            <div className="pop-group">
              <span className="pop-label">
                时间范围
                <em className="pop-label-note">{draftText || '全部时间'}</em>
              </span>
              <DateRangePicker
                key={pickEpoch}
                value={range}
                onDraftChange={(r) => setDraftText(rangeText(r))}
                onConfirm={(r) => {
                  onRangeConfirm(r)
                  setOpen(false)
                }}
              />
            </div>
          </OverlayScroll>

          <div className="pop-actions">
            <button
              type="button"
              title="清空已删 / 归档 / 时间范围三项（含未确认的日历草稿）"
              onClick={() => {
                onReset()
                setDraftText('')
                setPickEpoch((e) => e + 1)
              }}
            >
              重置
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
