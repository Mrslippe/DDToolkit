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

/** 每根柱的基准宽度与间距（缩放倍率乘在它上面） */
const BAR = 6
const GAP = 2
/** 缩放倍率的上下限（1 = 基准密度） */
const SCALE_MIN = 0.6
const SCALE_MAX = 6

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * 场次窗口滑杆（V5，2026-10-19）。
 *
 * ## 两件互不影响的事
 * - **选中窗口**（25/50/75 场）：决定"分析哪几场"，拖两端手柄可改大小；
 * - **可视范围**：决定"屏幕上能看见多少"，由**缩放倍率**控制。
 *
 * ## 缩放（用户 2026-10-19 口径）
 * - 滚轮 = **平移**（竖直滚动量转成横向位移）；
 * - **Ctrl + 滚轮** = 缩放，锚点跟随光标（缩放前后光标下的那场不动）；
 * - 下方那条**不是原生滚动条**，而是 ECharts dataZoom 式的缩放条：
 *   拖中间 = 平移，拖两端 = 缩放。
 *
 * ⚠️ 为什么不直接改 `scrollLeft` 实现缩放：可视范围 = `clientWidth / 轨宽`，
 * 而 `clientWidth` 是容器固定的 ⇒ 只能改**轨宽**（= 场次数 × 每场像素），
 * 所以 `scale` 乘在每个场的像素上，与 dataZoom 同构。
 */
export default function WindowSlider({ sessions, grades = [25, 50, 75], onChange }: Props) {
  const total = sessions.length
  const maxGrade = grades[grades.length - 1]
  const [size, setSize] = useState(Math.min(maxGrade, total))
  const [start, setStart] = useState(Math.max(0, total - Math.min(maxGrade, total)))
  /** 缩放倍率：每根柱的像素 = (BAR + GAP) × scale */
  const [scale, setScale] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; x: number; start: number } | null>(null)
  const barDrag = useRef<{ mode: 'pan' | 'zoom-l' | 'zoom-r'; x: number; left: number; width: number } | null>(null)

  const step = Math.max(3, Math.round((BAR + GAP) * scale))
  const barW = Math.max(2, step - GAP)
  const maxN = Math.max(1, ...sessions.map((s) => s.n))

  /** 把窗口夹进可视区（滚动/缩放时被边缘推着走） */
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
      return clampNum(next, 0, Math.max(0, total - size))
    })
  }, [size, step, total])

  useLayoutEffect(() => { clamp() }, [clamp])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => clamp()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [clamp])

  /* 换档时把窗口居中 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const center = 2 + start * step + (size * step) / 2
    el.scrollLeft = Math.max(0, center - el.clientWidth / 2)
    clamp()
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

  /* ── 滚轮：平移；Ctrl+滚轮：以光标为锚缩放 ─────────────────────────── */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) {
        // 平移：竖直滚动量转成横向位移（触控板与鼠标都顺手）
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          el.scrollLeft += e.deltaY
          e.preventDefault()
        }
        return
      }
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursor = e.clientX - rect.left + el.scrollLeft      // 轨内坐标
      const anchorIdx = cursor / step                            // 光标下的场次（连续值）
      const next = clampNum(scale * (e.deltaY > 0 ? 0.88 : 1.12), SCALE_MIN, SCALE_MAX)
      const nextStep = Math.max(3, Math.round((BAR + GAP) * next))
      setScale(next)
      // 缩放后把同一场挪回光标下
      requestAnimationFrame(() => {
        if (!scrollRef.current) return
        scrollRef.current.scrollLeft = Math.max(0, anchorIdx * nextStep - (e.clientX - rect.left))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, step])

  /* ── 选中窗口的拖拽 ───────────────────────────────────────────────── */
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
        setStart(clampNum(d.start + delta, 0, Math.max(0, total - size)))
        return
      }
      const r = innerRef.current?.getBoundingClientRect()
      if (!r) return
      const i = clampNum(Math.round((e.clientX - r.left - 2) / step), 0, total - 1)
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

  /* ── 缩放条的拖拽：中间平移、两端缩放（ECharts dataZoom 语义）──────── */
  const onBarDown = (mode: 'pan' | 'zoom-l' | 'zoom-r') => (e: React.PointerEvent) => {
    const el = scrollRef.current
    const track = barRef.current
    if (!el || !track) return
    const innerW = total * step + 4
    barDrag.current = {
      mode, x: e.clientX,
      left: el.scrollLeft / innerW,
      width: el.clientWidth / innerW,
    }
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = barDrag.current
      const el = scrollRef.current
      const track = barRef.current
      if (!d || !el || !track) return
      const trackW = track.clientWidth || 1
      const dx = (e.clientX - d.x) / trackW          // 以"轨道比例"为单位
      if (d.mode === 'pan') {
        const innerW = total * step + 4
        el.scrollLeft = clampNum((d.left + dx) * innerW, 0, Math.max(0, innerW - el.clientWidth))
        return
      }
      // 缩放：把可视宽度按拖动量改变，再换算成 scale
      const nextSpan = clampNum(
        d.mode === 'zoom-l' ? d.width - dx : d.width + dx,
        Math.min(1 / total, 0.02), 1,
      )
      const nextInner = el.clientWidth / nextSpan
      const nextStep = Math.max(3, nextInner / Math.max(1, total))
      const nextScale = clampNum(nextStep / (BAR + GAP), SCALE_MIN, SCALE_MAX)
      setScale(nextScale)
      requestAnimationFrame(() => {
        if (!scrollRef.current) return
        const innerW = total * Math.round((BAR + GAP) * nextScale) + 4
        scrollRef.current.scrollLeft = d.mode === 'zoom-l'
          ? clampNum((d.left + dx) * innerW, 0, Math.max(0, innerW - scrollRef.current.clientWidth))
          : clampNum(d.left * innerW, 0, Math.max(0, innerW - scrollRef.current.clientWidth))
      })
    }
    const up = () => { barDrag.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [step, total])

  /* 选中区的位置与宽度（在**轨内**夹一次，把手就不会探出轨道） */
  const bandStyle = (() => {
    const innerW = total * step + 4
    const rawW = size * step - 2
    const w = Math.max(8, Math.min(rawW, innerW - 4))
    const left = Math.max(2, Math.min(2 + start * step - 1, innerW - 2 - w))
    return { left, width: w }
  })()

  /* 缩放条上的可视范围带 */
  const [barGeom, setBarGeom] = useState({ left: 0, width: 100 })
  useEffect(() => {
    const sync = () => {
      const el = scrollRef.current
      if (!el) return
      const innerW = total * step + 4
      const w = Math.min(100, (el.clientWidth / innerW) * 100)
      const l = innerW > el.clientWidth ? (el.scrollLeft / (innerW - el.clientWidth)) * (100 - w) : 0
      setBarGeom({ left: l, width: w })
    }
    sync()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      el.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [step, total])

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
                 style={{ width: barW, height: s.c ? 4 + Math.round((s.n / maxN) * 13) : 3 }}
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

      {/* ECharts dataZoom 式缩放条：拖中间平移，拖两端缩放 */}
      <div className="wb-zoom-bar" ref={barRef} data-testid="zoom-bar">
        <div className="wb-zoom-bar-band"
             style={{ left: `${barGeom.left}%`, width: `${barGeom.width}%` }}
             onPointerDown={onBarDown('pan')} data-testid="zoom-bar-band">
          <span className="h l" onPointerDown={onBarDown('zoom-l')} data-testid="zoom-bar-l" />
          <span className="h r" onPointerDown={onBarDown('zoom-r')} data-testid="zoom-bar-r" />
        </div>
      </div>

      <div className="wb-zoom-read" data-testid="zoom-read">
        {/* 日期不再重复显示（2026-10-19）：下面的「区间」按钮已经写着范围，
            这里两行日期会让人以为是两个不同的东西。 */}
        <span>{size} 场 · 已采 <b>{coll}</b> · 待采 <b className={size - coll ? 'acc' : ''}>{size - coll}</b></span>
        <span>（共 {total} 场）</span>
        <span className="wb-zoom-hint">滚轮平移 · Ctrl+滚轮缩放</span>
      </div>
    </div>
  )
}
