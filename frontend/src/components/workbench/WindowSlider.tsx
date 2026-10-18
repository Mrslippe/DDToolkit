import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface RecentSession {
  at: string
  /** 弹幕已落盘 */
  c: boolean
  /** 已采时的弹幕总量（未采为 0） */
  n: number
}

export interface WindowRange {
  start: number
  size: number
  since: string
  until: string
}

interface Props {
  sessions: RecentSession[]
  /** 窗口档位，默认 25 / 50 / 75 */
  grades?: number[]
  onChange: (range: WindowRange) => void
}

/** 每根柱的宽度与间距（写死 ⇒ 轨道总宽可算，滚动条才有意义） */
const BAR = 6
const GAP = 2

/**
 * 场次窗口滑杆（V4，2026-10-18）。
 *
 * 用户口径三条，逐条落在下面：
 * ① **总量上限 150 场** —— 数据由后端 `?limit=150` 给定，这里不再超；
 * ② **下方横向滚动条** —— 轨内 `150 × 8 = 1200px`，比卡片宽，必须滚；
 * ③ **窗口只能停在可视区内** —— `clampToView()`：滚动条一动，窗口被边缘**推向反方向**。
 *    拖拽时也夹，所以永远不会有一半在视口外的窗口。
 *
 * 视觉参考「数据视图 → 粉丝趋势卡」的 ECharts `dataZoom`：迷你序列 + 可拖窗口 + 两端手柄 +
 * 中央移动把手。**尺寸是它的一半**（2026-10-18 用户：「滑杆高度调整为原来的一半」）。
 */
export default function WindowSlider({ sessions, grades = [25, 50, 75], onChange }: Props) {
  const total = sessions.length
  const maxGrade = grades[grades.length - 1]
  const [size, setSize] = useState(Math.min(maxGrade, total))
  const [start, setStart] = useState(Math.max(0, total - Math.min(maxGrade, total)))
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; x: number; start: number } | null>(null)

  const step = BAR + GAP
  const maxN = Math.max(1, ...sessions.map((s) => s.n))

  /** 把窗口夹进可视区（滚动时被边缘推着走） */
  const clamp = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const firstVisible = Math.ceil((el.scrollLeft - 2) / step)
    const lastVisible = Math.floor((el.scrollLeft + el.clientWidth - 4) / step)
    const maxStart = lastVisible - size + 1
    setStart((prev) => {
      const next = maxStart >= firstVisible
        ? Math.max(firstVisible, Math.min(prev, maxStart))
        : firstVisible
      return Math.max(0, Math.min(next, Math.max(0, total - size)))
    })
  }, [size, step, total])

  /* 尺寸变了（换档 / 窗口宽高变化）都要重新夹一次 */
  useLayoutEffect(() => { clamp() }, [clamp])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => clamp()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [clamp])

  /* 把窗口居中到可视区（首次与换档时） */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const center = 2 + start * step + (size * step) / 2
    el.scrollLeft = Math.max(0, center - el.clientWidth / 2)
    clamp()
    // 只在 size 变化时居中 —— 拖动时不抢滚动位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size])

  /* 通知外层：窗口变了 ⇒ 日期区间变了 */
  useEffect(() => {
    if (!total || start + size > total) return
    const a = sessions[start]
    const b = sessions[Math.min(total - 1, start + size - 1)]
    if (!a || !b) return
    onChange({ start, size, since: a.at.slice(0, 10), until: b.at.slice(0, 10) })
  }, [start, size, sessions, total, onChange])

  const onPointerDown = (mode: 'move' | 'l' | 'r') => (e: React.PointerEvent) => {
    drag.current = { mode, x: e.clientX, start }
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (d.mode === 'move') {
        const delta = Math.round((e.clientX - d.x) / step)
        setStart(Math.max(0, Math.min(d.start + delta, Math.max(0, total - size))))
        return
      }
      const r = innerRef.current?.getBoundingClientRect()
      if (!r) return
      const i = Math.max(0, Math.min(total - 1, Math.round((e.clientX - r.left - 2) / step)))
      const end = start + size - 1
      if (d.mode === 'l') {
        const ns = Math.min(i, end)
        const nextSize = Math.min(maxGrade, end - ns + 1)
        setSize(nextSize)
        setStart(Math.max(0, end - nextSize + 1))
      } else {
        setSize(Math.max(1, Math.min(maxGrade, i - start + 1)))
      }
    }
    const up = () => { drag.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [size, start, step, total, maxGrade])

  /* 选中区的位置与宽度**按轨道的实际宽度夹一次**（照抄 dataZoom 的结构：
     选中区是轨道内的一段带，把手是带内两端的小竖条，谁也不许探出轨道）。
     轨道宽 = total * step + 4（见下面的 inner style）。 */
  const bandStyle = (() => {
    const innerW = total * step + 4
    const rawW = size * step - 2
    const w = Math.max(8, Math.min(rawW, innerW - 4))
    const left = Math.max(2, Math.min(2 + start * step - 1, innerW - 2 - w))
    return { left, width: w }
  })()

  const picked = sessions.slice(start, start + size)
  const coll = picked.filter((s) => s.c).length

  return (
    <div className="wb-zoom">
      <div className="wb-grades">
        <span>窗口</span>
        {/* 2026-10-19 用户口径：区间里的场次不够这个档位时**变灰且不可选**，
            不再"静默取满"—— 否则 10 场的区间也能点 75，看到的窗口大小是骗人的 */}
        {grades.map((g) => (
          <button key={g} type="button"
                  className={`wb-grade${g === size ? ' on' : ''}`}
                  disabled={total < g}
                  title={total < g ? `当前区间只有 ${total} 场` : undefined}
                  onClick={() => {
                    setSize(Math.min(g, total))
                    setStart((s) => Math.min(s, Math.max(0, total - Math.min(g, total))))
                  }}
                  data-testid={`grade-${g}`}>{g} 场</button>
        ))}
      </div>

      <div className="wb-zoom-scroll" ref={scrollRef} data-testid="zoom-scroll">
        <div className="wb-zoom-inner" ref={innerRef}
             style={{ width: total * step + 4 }} data-testid="zoom-inner">
          <div className="wb-bars" style={{ gap: GAP }}>
            {sessions.map((s, i) => (
              <i key={i}
                 className={s.c ? 'c' : 'has'}
                 style={{ width: BAR, height: s.c ? 4 + Math.round((s.n / maxN) * 13) : 3 }}
                 title={`${s.at.slice(0, 10)}${s.c ? ` · 已采 ${s.n.toLocaleString()} 条` : ' · 未采'}`} />
            ))}
          </div>
          <div className="wb-win"
               style={bandStyle}
               data-testid="zoom-win"
               onPointerDown={onPointerDown('move')}>
            <div className="h l" onPointerDown={onPointerDown('l')} data-testid="zoom-handle-l" />
            <div className="grip" />
            <div className="h r" onPointerDown={onPointerDown('r')} data-testid="zoom-handle-r" />
          </div>
        </div>
      </div>

      <div className="wb-zoom-read" data-testid="zoom-read">
        {/* 日期不再重复显示（2026-10-19）：下面的「区间」按钮已经写着范围，
            这里两行日期会让人以为是两个不同的东西。 */}
        <span>{size} 场 · 已采 <b>{coll}</b> · 待采 <b className={size - coll ? 'acc' : ''}>{size - coll}</b></span>
        <span>（共 {total} 场）</span>
      </div>
    </div>
  )
}
