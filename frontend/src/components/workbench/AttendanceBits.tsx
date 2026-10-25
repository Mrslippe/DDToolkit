import { useState } from 'react'

interface Props {
  /** 窗口内逐场是否出席（1=出席），顺序与窗口场次一致 */
  bits: number[]
  /** 各场次的时间与标题（用于浮层） */
  sessions: { at: string; title?: string }[]
  /** 出席场次数（分子）与总场次 */
  att: number
  total: number
}

/**
 * 出席明细图（2026-10-25）：一排小方块，绿=出席、灰=未出席。
 *
 * 场次多时不横向滚动 —— 改成**向下换行铺开**（用户口径），
 * hover 时用浮层给完整明细（时间 + 标题 + 是否出席），离开即关。
 */
export default function AttendanceBits({ bits, sessions, att, total }: Props) {
  const [open, setOpen] = useState(false)
  if (!bits.length) return <span className="wb-bits-empty">—</span>

  return (
    <span
      className="wb-bits"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="wb-bits-grid" aria-label={`出席 ${att}/${total} 场`}>
        {bits.map((b, i) => (
          <i key={i} className={b ? 'wb-bit on' : 'wb-bit'} />
        ))}
      </span>

      {open && (
        <span className="wb-bits-pop" role="tooltip">
          <span className="wb-bits-pop-head">出席 {att}/{total} 场</span>
          <span className="wb-bits-pop-grid">
            {bits.map((b, i) => (
              <span key={i} className="wb-bits-pop-item" title={sessions[i]?.title || ''}>
                <i className={b ? 'wb-bit on' : 'wb-bit'} />
                <span className="wb-bits-pop-when">{(sessions[i]?.at ?? '').slice(5, 16)}</span>
                <span className="wb-bits-pop-title">{sessions[i]?.title || '（无标题）'}</span>
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  )
}
