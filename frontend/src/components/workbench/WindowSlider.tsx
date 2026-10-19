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
  /** 值变化时把窗口**覆盖整段**（手选日期后自动收敛到该范围，2026-10-19 用户口径） */
  coverTick?: number
  onChange: (range: WindowRange) => void
}

/** 每根柱的基准宽度与间距（缩放倍率乘在它上面） */
const BAR = 6
const GAP = 2
/** 轨道左右内距 —— **必须与 CSS 的 `.wb-bars { padding: 0 2px }` 一致** */
const PAD = 2
const SCALE_MIN = 0.6
const SCALE_MAX = 6

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * 场次窗口滑杆（V6，2026-10-19 第三次修几何）。
 *
 * ## 几何约定（此前所有偏移 bug 的总根因）
 * - 轨道宽度 = `total * step + 2 * PAD`，`step = (BAR + GAP) * scale`（**浮点，不取整**）；
 * - 柱状图与选中区都从 `PAD` 起算 ⇒ 左端贴 `PAD`、右端贴 `innerW - PAD`，**两端对称**；
 * - 滚动容器 **没有** 左右 padding（早先为手柄留过 7px，那 7px 让 `scrollLeft` 与内容的
 *   对应关系整体偏了 7px，左端顶不准、右端超出一截都是它）；
 * - `step` 保持浮点：取整会让缩放变成「段落式」（每跨一场跳一下）。
 *
 * ## 缩放（用户口径）
 * - 滚轮 = 平移；Ctrl+滚轮 = 缩放（以光标为锚）；
 * - 下方是 ECharts dataZoom 式缩放条：拖中间平移、拖两端缩放；
 * - **跟手系数**：带子行程 `trackW - bandW` 对应可滚范围 `innerW - clientW`
 *   ⇒ 恰好等于 `innerW / trackW`。早先用 `range / trackW` 小了一个数量级，所以「鼠标比带子快」。
 */
export default function WindowSlider({ sessions, grades = [25, 50, 75],
                                        coverTick, onChange }: Props) {
  const total = sessions.length
  const maxGrade = grades[grades.length - 1]
  const [size, setSize] = useState(Math.min(maxGrade, total))
  const [start, setStart] = useState(Math.max(0, total - Math.min(maxGrade, total)))
  const [scale, setScale] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; x: number; start: number } | null>(null)
  const barDrag = useRef<{
    mode: 'pan' | 'zoom-l' | 'zoom-r'
    x0: number
    step0: number
    scroll0: number
    clientW: number
  } | null>(null)
  const suppress = useRef(false)
  /** 视野里**能显示**多少场（随缩放/窗口宽度变）。档位是否可用看它，不是看总场次。 */
  const [viewCount, setViewCount] = useState(total)

  /** **不取整**：取整会让缩放变成段落式 */
  const step = Math.max(3, (BAR + GAP) * scale)
  const stepRef = useRef(step)
  stepRef.current = step
  const innerW = total * step + 2 * PAD
  const maxN = Math.max(1, ...sessions.map((s) => s.n))

  /** 量一次视野容量（滚动 / 缩放 / 改窗口大小都调到） */
  const syncView = useCallback(() => {
    const el = scrollRef.current
    if (!el || !el.clientWidth) return
    const st = stepRef.current
    const n2 = Math.max(1, Math.floor((el.clientWidth - 2 * PAD) / st + 0.001))
    setViewCount((prev) => (prev === n2 ? prev : n2))
  }, [])

  /** 把窗口夹进可视区（滚动 / 换档 / 缩放都要跑） */
  const clamp = useCallback(() => {
    const el = scrollRef.current
    if (!el || suppress.current) return
    const st = stepRef.current
    const first = Math.round((el.scrollLeft - PAD) / st)
    const last = Math.floor((el.scrollLeft + el.clientWidth - PAD) / st)
    const lo = Math.max(0, first)
    const hi = Math.max(lo, Math.min(total - size, last - size + 1))
    setStart((prev) => clampNum(prev, lo, hi))
    syncView()
  }, [size, total, syncView])

  useLayoutEffect(() => { clamp() }, [clamp, step])

  /* 视野比窗口窄 ⇒ 窗口跟着缩到视野大小（用户口径：选「窗口自动缩到视野大小」）；
     同时把起点夹回去。缩放变宽后，用户仍可重新点更大的档位。 */
  useEffect(() => {
    if (viewCount < 1) return
    if (size > viewCount) {
      setSize(viewCount)
      setStart((s) => Math.min(s, Math.max(0, total - viewCount)))
    }
  }, [viewCount, size, total])

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
    const center = PAD + start * step + (size * step) / 2
    el.scrollLeft = Math.max(0, center - el.clientWidth / 2)
    clamp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size])

  /* 手选日期后：窗口覆盖整段（size = 全部场次，起点归零） */
  useEffect(() => {
    if (!coverTick || total < 1) return
    setSize(total)
    setStart(0)
    const el = scrollRef.current
    if (el) el.scrollLeft = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverTick, total])

  /* 通知外层 */
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
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          el.scrollLeft += e.deltaY
          e.preventDefault()
        }
        return
      }
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursor = e.clientX - rect.left + el.scrollLeft
      const anchorIdx = (cursor - PAD) / step
      const next = clampNum(scale * (e.deltaY > 0 ? 0.88 : 1.12), SCALE_MIN, SCALE_MAX)
      const nextStep = Math.max(3, (BAR + GAP) * next)
      setScale(next)
      requestAnimationFrame(() => {
        const el2 = scrollRef.current
        if (!el2) return
        el2.scrollLeft = Math.max(0, PAD + anchorIdx * nextStep - (e.clientX - rect.left))
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
      const st = stepRef.current
      if (d.mode === 'move') {
        const delta = Math.round((e.clientX - d.x) / st)
        /* 夹到**可视区**（不只整条轨道），否则窗口会被推到看不见的地方 */
        const el = scrollRef.current
        const first = el ? Math.round((el.scrollLeft - PAD) / st) : 0
        const last = el ? Math.floor((el.scrollLeft + el.clientWidth - PAD) / st) : total - 1
        const lo = Math.max(0, first)
        const hi = Math.max(lo, Math.min(total - size, last - size + 1))
        setStart(clampNum(d.start + delta, lo, hi))
        return
      }
      const r = innerRef.current?.getBoundingClientRect()
      if (!r) return
      const i = clampNum(Math.round((e.clientX - r.left - PAD) / st), 0, total - 1)
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
  }, [size, start, total, maxGrade])

  /* ── 缩放条：拖中间平移、拖两端缩放 ────────────────────────────────── */
  const onBarDown = (mode: 'pan' | 'zoom-l' | 'zoom-r') => (e: React.PointerEvent) => {
    const el = scrollRef.current
    if (!el) return
    barDrag.current = {
      mode,
      x0: e.clientX,
      step0: stepRef.current,
      scroll0: el.scrollLeft,
      clientW: el.clientWidth,
    }
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = barDrag.current
      const el = scrollRef.current
      if (!d || !el) return
      const dxPx = e.clientX - d.x0
      const trackW = barRef.current?.clientWidth ?? 1
      const innerW0 = total * d.step0 + 2 * PAD
      const range = Math.max(1, innerW0 - d.clientW)

      if (d.mode === 'pan') {
        /* 带子行程 = trackW - bandW，对应 range ⇒ 系数正好是 innerW0 / trackW */
        const factor = innerW0 / trackW
        suppress.current = true
        el.scrollLeft = clampNum(d.scroll0 + dxPx * factor, 0, range)
        requestAnimationFrame(() => {
          suppress.current = false
          clamp()
        })
        return
      }

      // 缩放：拖动距离按**轨道宽度**映射到场次数（线性，与缩放级别无关）
      const span0 = d.clientW / d.step0
      const spanNext = clampNum(span0 - (dxPx / trackW) * total, 4, total)
      const stepNext = clampNum(d.clientW / spanNext, 3, 400)
      const scaleNext = clampNum(stepNext / (BAR + GAP), SCALE_MIN, SCALE_MAX)
      const leftIdx = (d.scroll0 - PAD) / d.step0
      const rightIdx = (d.scroll0 + d.clientW - PAD) / d.step0
      setScale(scaleNext)
      suppress.current = true
      requestAnimationFrame(() => {
        const el2 = scrollRef.current
        if (!el2) { suppress.current = false; return }
        const st2 = Math.max(3, (BAR + GAP) * scaleNext)
        const innerW2 = total * st2 + 2 * PAD
        const range2 = Math.max(0, innerW2 - el2.clientWidth)
        el2.scrollLeft = d.mode === 'zoom-r'
          ? clampNum(PAD + leftIdx * st2, 0, range2)
          : clampNum(PAD + rightIdx * st2 - el2.clientWidth, 0, range2)
        requestAnimationFrame(() => {
          suppress.current = false
          clamp()
        })
      })
    }
    const up = () => { barDrag.current = null; suppress.current = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [total, clamp])

  /* 选中区：左起 `PAD`，宽度要**减掉一个间距**（2026-10-19 用户：左右把手与直方图
     的相对位置不一致）。
     根因：柱子是 `[PAD + i*step, PAD + i*step + (step - GAP)]`，而带子原来宽 `size*step`，
     右缘落在 `PAD + (start+size)*step` —— 那是**下一根柱子的左缘**，比最后一根柱的右缘
     多出一个 GAP。于是左手柄贴着柱子，右手柄却落在缝隙里。减掉 GAP 后两端对称。 */
  const bandStyle = {
    left: PAD + start * step,
    width: Math.max(4, size * step - GAP),
  }

  /* 缩放条上的可视范围带 */
  const [barGeom, setBarGeom] = useState({ left: 0, width: 100 })
  useEffect(() => {
    const sync = () => {
      const el = scrollRef.current
      if (!el) return
      const w = Math.min(100, (el.clientWidth / innerW) * 100)
      const range = Math.max(1, innerW - el.clientWidth)
      const l = range > 0 ? (el.scrollLeft / range) * (100 - w) : 0
      setBarGeom({ left: l, width: w })
    }
    sync()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    syncView()
    return () => {
      el.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [innerW, syncView])

  const picked = sessions.slice(start, start + size)
  const coll = picked.filter((s) => s.c).length

  return (
    <div className="wb-zoom">
      <div className="wb-grades">
        <span>窗口</span>
        {/* 区间里的场次不够这个档位时**变灰且不可选**，不再「静默取满」 */}
        {grades.map((g) => (
          <button key={g} type="button"
                  className={`wb-grade${g === size ? ' on' : ''}`}
                  /* 2026-10-19 用户口径：**视野里能显示的场次**不够这个档位就变灰不可选
                     （之前只看总场次 `total`，缩放放大后 75 档仍然可点，但根本放不下） */
                  disabled={g > viewCount || g > total}
                  title={
                    g > total ? `当前区间只有 ${total} 场`
                      : g > viewCount ? `当前视野只能显示 ${viewCount} 场，缩小可显示更多`
                        : undefined
                  }
                  onClick={() => {
                    const target = Math.min(g, total, Math.max(viewCount, 1))
                    setSize(target)
                    setStart((s) => Math.min(s, Math.max(0, total - target)))
                  }}
                  data-testid={`grade-${g}`}>{g} 场</button>
        ))}
      </div>

      <div className="wb-zoom-scroll" ref={scrollRef} data-testid="zoom-scroll">
        <div className="wb-zoom-inner" ref={innerRef}
             style={{ width: innerW }} data-testid="zoom-inner">
          <div className="wb-bars" style={{ gap: GAP }}>
            {sessions.map((s, i) => (
              <i key={i}
                 className={s.c ? 'c' : 'has'}
                 style={{
                   width: Math.max(1, step - GAP),
                   height: s.c ? 4 + Math.round((s.n / maxN) * 13) : 3,
                 }}
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
        <span>{size} 场 · 已采 <b>{coll}</b> · 待采 <b className={size - coll ? 'acc' : ''}>{size - coll}</b></span>
        <span>（共 {total} 场）</span>
        <span className="wb-zoom-hint">滚轮平移 · Ctrl+滚轮缩放</span>
      </div>
    </div>
  )
}
