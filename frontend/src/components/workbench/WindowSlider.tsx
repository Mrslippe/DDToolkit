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
  /** 缩放条拖拽：**记下按下瞬间的全部状态**，每次移动都从它算，避免累积抖动 */
  const barDrag = useRef<{
    mode: 'pan' | 'zoom-l' | 'zoom-r'
    x0: number
    step0: number
    scroll0: number
    clientW: number
  } | null>(null)
  /** 程序化改 scrollLeft 时抑制 clamp，避免自己把自己推回去造成闪动 */
  const suppress = useRef(false)

  const step = Math.max(3, Math.round((BAR + GAP) * scale))
  /** 给 `clamp` 用的最新 step —— 缩放后 step 变了，若读旧值就会夹错 */
  const stepRef = useRef(step)
  stepRef.current = step
  const barW = Math.max(2, step - GAP)
  const maxN = Math.max(1, ...sessions.map((s) => s.n))

  /** 把窗口夹进可视区（滚动/缩放时被边缘推着走） */
  const clamp = useCallback(() => {
    const el = scrollRef.current
    if (!el || suppress.current) return
    const st = stepRef.current
    /* 两端取整要**对称**（2026-10-19 用户：左端顶不到最左、右端又超出最右）：
       起点用 floor(x + 0.5) 四舍五入到最近一场，终点用 floor —— 早先用 ceil 会让
       `scrollLeft = 0` 时的 first 变成 0 以外的值，左端就差那么一格。 */
    const first = Math.round((el.scrollLeft - 2) / st)
    const last = Math.floor((el.scrollLeft + el.clientWidth - 4) / st)
    const lo = Math.max(0, first)
    const hi = Math.max(lo, Math.min(total - size, last - size + 1))
    setStart((prev) => clampNum(prev, lo, hi))
  }, [size, total])

  /* 滚动、换档、缩放都要重夹一次 —— 只用 scroll 事件会漏掉"缩放后视野变了"这种情况 */
  useLayoutEffect(() => { clamp() }, [clamp, step])

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
        /* 必须夹到**可视区**（2026-10-19 用户：拖中央把手会让窗口一半跑到视野外）。
           之前只夹整条轨道 [0, total-size]，所以能推到看不见的地方。 */
        const el = scrollRef.current
        const first = el ? Math.ceil((el.scrollLeft - 2) / step) : 0
        const last = el ? Math.floor((el.scrollLeft + el.clientWidth - 4) / step) : total - 1
        const lo = Math.max(0, first)
        const hi = Math.max(lo, Math.min(total - size, last - size + 1))
        setStart(clampNum(d.start + delta, lo, hi))
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
    if (!el) return
    barDrag.current = {
      mode,
      x0: e.clientX,
      step0: step,
      scroll0: el.scrollLeft,
      clientW: el.clientWidth,
    }
    e.preventDefault()
    e.stopPropagation()
  }

  /* ── 缩放条：**锚点用「场次序号」，不用比例**（2026-10-19 修）───────────
     之前把左/右边界记成"轨宽的百分比"，可缩放恰恰在改轨宽 ⇒ 同一个百分比对应不同像素，
     于是拖动一端时**另一端也会跟着动、还会闪**。现在锚定的是序号：
     拖右端固定左端序号，拖左端固定右端序号，两端各归各位。 */
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = barDrag.current
      const el = scrollRef.current
      if (!d || !el) return
      const dxPx = e.clientX - d.x0
      // 平移：把「光标在缩放条上走的距离」按比例映射到可滚范围（之前 1:1 ⇒ 显得慢）
      const trackW = barRef.current?.clientWidth ?? 1
      if (d.mode === 'pan') {
        const innerW = total * d.step0 + 4
        const range = Math.max(0, innerW - d.clientW)
        suppress.current = true
        el.scrollLeft = clampNum(d.scroll0 + dxPx * (range / trackW), 0, range)
        requestAnimationFrame(() => {
          suppress.current = false
          clamp()                      // 平移完也要把窗口夹进视野（2026-10-19 用户第 2 条）
        })
        return
      }
      // 缩放：拖动距离按**轨道宽度**映射到场次数 —— 与当前缩放级别无关，速度才恒定。
      // 旧写法按 span0 的比例算，放大后每像素跨度变化剧烈 ⇒ 太快（2026-10-19 用户第 3 条）。
      const span0 = d.clientW / d.step0
      const spanNext = clampNum(span0 - (dxPx / trackW) * total, 4, total)
      const stepNext = clampNum(d.clientW / spanNext, 3, 400)
      const scaleNext = clampNum(stepNext / (BAR + GAP), SCALE_MIN, SCALE_MAX)
      // 锚点序号（按下瞬间）
      const leftIdx = (d.scroll0 - 2) / d.step0
      const rightIdx = (d.scroll0 + d.clientW - 4) / d.step0
      setScale(scaleNext)
      suppress.current = true
      requestAnimationFrame(() => {
        const el2 = scrollRef.current
        if (!el2) { suppress.current = false; return }
        const step2 = Math.max(3, Math.round((BAR + GAP) * scaleNext))
        const innerW2 = total * step2 + 4
        el2.scrollLeft = d.mode === 'zoom-r'
          // 拖右端：左端不动
          ? clampNum(leftIdx * step2, 0, Math.max(0, innerW2 - el2.clientWidth))
          // 拖左端：右端不动
          : clampNum(rightIdx * step2 - el2.clientWidth, 0, Math.max(0, innerW2 - el2.clientWidth))
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
