import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  /** 窗口内逐场是否出席（1=出席），顺序与窗口场次一致 */
  bits: number[]
  /** 各场次的时间与标题（方块 tooltip 用） */
  sessions: { at: string; title?: string }[]
  /** 出席场次数（分子）与总场次 */
  att: number
  total: number
}

/** 每行方块数（默认区与浮层一致，2026-10-25 用户定） */
const COLS = 20
/** 默认只露两行 */
const ROWS = 2
/** 鼠标离开后的收起延迟（斜向移入浮层时不要闪掉） */
const HIDE_DELAY = 120

/**
 * 出席明细图（2026-10-25 定稿）。
 *
 * - 方块 14×14、圆角 3、间距 6；绿 = 出席，浅灰 = 缺席；
 * - **固定 20 列**，默认只显示前两行（40 格），场次不足时**保持方块尺寸**、右侧留白；
 * - hover 弹出浮层：同样的方块矩阵、同样 20 列，**铺满全部场次**（行数按需），
 *   不横向滚动、不放文字列表；每格的「时间 · 标题」走原生 tooltip；
 * - 鼠标离开后 120ms 收起。
 */
export default function AttendanceBits({ bits, sessions, att, total }: Props) {
  const [open, setOpen] = useState(false)
  /** 浮层用 portal 渲染到 body：表格单元格是 `overflow: hidden`（还有横向滚动容器），
   *  就地绝对定位一定会被裁掉 —— 表现为"hover 什么都不出现"（2026-10-25 用户报）。 */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const grid = useRef<HTMLSpanElement | null>(null)
  const timer = useRef<number | null>(null)

  const cancel = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
  }
  const show = () => {
    cancel()
    const el = grid.current
    if (el) {
      const r = el.getBoundingClientRect()
      // 浮层与方块区**同原点**：20 列 × 14px + 6px 间距两边完全一致，
      // 于是浮层里的第 N 格恰好压在表里的第 N 格上（"放大镜"式一一重叠，2026-10-25 用户定）。
      // 浮层自身有 8px 内边距，所以整体左上各减 8，让格子而不是卡片边缘对齐。
      setPos({ x: r.left - 8, y: r.top - 8 })
    }
    setOpen(true)
  }
  const hide = () => { cancel(); timer.current = window.setTimeout(() => setOpen(false), HIDE_DELAY) }

  useEffect(() => cancel, [])

  if (!bits.length) return <span className="wb-bits-empty">—</span>

  const head = bits.slice(0, COLS * ROWS)

  const cell = (b: number, i: number) => (
    <i
      key={i}
      className={b ? 'wb-bit on' : 'wb-bit'}
      title={`${(sessions[i]?.at ?? '').slice(5, 16)}${sessions[i]?.title ? ` · ${sessions[i]!.title}` : ''}`}
    />
  )

  return (
    <span className="wb-bits" onMouseEnter={show} onMouseLeave={hide}>
      <span className="wb-bits-grid" ref={grid} aria-label={`出席 ${att}/${total} 场`}>
        {head.map(cell)}
      </span>

      {open && pos && createPortal(
        <span className="wb-bits-pop" role="tooltip"
              style={{ left: pos.x, top: pos.y }}
              onMouseEnter={cancel} onMouseLeave={hide}>
          <span className="wb-bits-pop-head">出席 {att}/{total} 场</span>
          <span className="wb-bits-grid is-pop">
            {bits.map(cell)}
          </span>
        </span>,
        document.body,
      )}
    </span>
  )
}
