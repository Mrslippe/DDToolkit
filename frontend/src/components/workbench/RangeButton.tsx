import { useEffect, useRef, useState } from 'react'
import { CalendarRange } from 'lucide-react'
import DateRangePicker from '../common/DateRangePicker'
import FloatPill from '../common/FloatPill'

interface Props {
  /** 当前区间（`YYYY-MM-DD`，含两端） */
  value: { from: string; to: string }
  /** 触发器上显示的文案。默认模式显示「2026 整年」，手选模式显示具体区间 */
  display?: string
  onConfirm: (r: { from: string; to: string }) => void
  disabled?: boolean
}

/**
 * 「区间」按钮 + 下拉的双月历（2026-10-19 用户第 2 条）。
 *
 * 口径：这里的区间决定的是**整条滑轨的时间跨度**（不是选中窗口）——
 * 用户原话："自定义日期区间决定的是整条滑轨的时间跨度，现在来讲就是那150场"。
 *
 * 实现上复用项目已有的两件东西，不新造：
 * - 触发器 = `FloatPill`（浮片族）；
 * - 日历本体 = `components/common/DateRangePicker`（草稿制，确认才提交）。
 */
export default function RangeButton({ value, display, onConfirm, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 点外面 / Esc 关闭（与项目其它浮窗一致）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="wb-range" ref={boxRef}>
      <FloatPill size="md" shape="text" disabled={disabled}
                 onClick={() => setOpen((o) => !o)} data-testid="range-trigger">
        <CalendarRange size={13} strokeWidth={1.9} style={{ marginRight: 5 }} />
        {display ?? `${value.from} ~ ${value.to}`}
      </FloatPill>

      {open && (
        <div className="wb-range-pop" data-testid="range-pop">
          <DateRangePicker
            key={`${value.from}-${value.to}`}
            value={{ from: value.from, to: value.to }}
            onConfirm={(r) => {
              setOpen(false)
              if (r.from && r.to) onConfirm({ from: r.from, to: r.to })
            }}
          />
        </div>
      )}
    </div>
  )
}
