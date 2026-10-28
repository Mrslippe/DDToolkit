import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface RecentSession {
  at: string
  /** 该场的**东八区日期**（后端算好；跨零点的场次以它为准） */
  d?: string
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
  /** 窗口档位，默认 25 / 50 / 75 / 150 */
  grades?: number[]
  /** 状态归属键（一般是主播名）：同名之间共享滑轨状态（位置/档位/缩放），
   *  **不要**用 `key` 重挂载组件 —— 重挂载会重置缩放、且触发整块重排闪动（2026-10-25） */
  stateKey?: string
  /** 当前 `sessions` 属于哪个 V（由父级在**取数成功时**写入）。
   *  切换 V 的过渡帧里，滑轨仍是旧数据但 stateKey 已经换了 —— 必须靠它挡住，
   *  否则会把这个"错配位置"写进新 V 的缓存（2026-10-25 菜菜子那类少场次 V 触发） */
  dataOwner?: string
  /** 值变化时把窗口**覆盖整段**（手选日期后自动收敛到该范围，2026-10-19 用户口径） */
  coverTick?: number
  /**
   * 把窗口**直接设成这一组**（2026-10-28：切回某个 V 时恢复它结果包的区间）。
   * 只认 `tick` 的变化 —— 与 `coverTick` 同一套纪律，否则每次 total 变化都会跳回旧区间。
   */
  restore?: { start: number; size: number; since: string; until: string; tick: number } | null
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
/**
 * stateKey → 滑轨状态（内存态，随页面存活）。
 *
 * ⚠️ 位置存的是**相对位置 `pos ∈ [0,1]`**（0=最左，1=最右），不是绝对下标：
 * 各 V 的场次数不同，同一下标在别处含义完全不同；而且下标在恢复过程中会被
 * 并行的 clamp 改写一次，来回切换几次就"漂移"（2026-10-25 用户实测）。
 * 相对位置对场次数不变，且默认 1 正好是"贴最右"。
 */
const SLIDER_STATE = new Map<string, { pos: number; size: number; scale: number; scroll?: number }>()

export default function WindowSlider({ sessions, grades = [25, 50, 75, 150],
                                        stateKey, dataOwner, coverTick, restore, onChange }: Props) {
  /** 数据与 key 是否配套（不配套时既不恢复也不回写） */
  const owned = !stateKey || !dataOwner || dataOwner === stateKey
  const total = sessions.length
  // 默认档位取**最小档**（25），位置贴**最右**（用户 2026-10-25 口径）
  const minGrade = grades[0]
  const maxGrade = grades[grades.length - 1]
  const saved = stateKey ? SLIDER_STATE.get(stateKey) : undefined
  const [size, setSize] = useState(saved?.size ?? Math.min(minGrade, total || minGrade))
  /** 恢复过程中不要回写缓存（否则会被并行的 clamp 覆盖成"漂移后的值"） */
  const restoring = useRef(false)
  const [start, setStart] = useState(() => {
    const sz = Math.min(saved?.size ?? minGrade, total || minGrade)
    if (saved?.pos === undefined) return Math.max(0, total - sz)
    return Math.max(0, Math.min(Math.round(saved.pos * Math.max(0, total - sz)), total - sz))
  })
  const [scale, setScale] = useState(saved?.scale ?? 1)
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
  /** 视野里**能显示**多少场（随缩放 / 窗口宽度变化）。
      它管两件事：① `size > viewCount` 时**把窗口收缩**；② 档位 `g > viewCount` 时**变灰**
      （视野放不下，点了也会被缩回去，不如直接禁掉）。 */
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
    const cap = Math.max(1, Math.floor((el.clientWidth - 2 * PAD) / st + 0.001))
    setViewCount((prev) => (prev === cap ? prev : cap))
  }, [])

  /** 把窗口夹进可视区（滚动 / 换档 / 缩放都要跑） */
  const clamp = useCallback(() => {
    const el = scrollRef.current
    // 还没量到宽度（隐藏/首帧/切 V 的过渡）时**绝不夹取**：
    // 此时 last 会算成 0 → hi ≤ 0 → start 被拽回左边界，再回写就成了"漂移"
    if (!el || !el.clientWidth || suppress.current) return
    const st = stepRef.current
    const first = Math.round((el.scrollLeft - PAD) / st)
    const last = Math.floor((el.scrollLeft + el.clientWidth - PAD) / st)
    const lo = Math.max(0, first)
    const hi = Math.max(lo, Math.min(total - size, last - size + 1))
    setStart((prev) => clampNum(prev, lo, hi))
    syncView()
  }, [size, total, syncView])

  useLayoutEffect(() => { clamp() }, [clamp, step])

  /* **视野装不下就缩窗口**（用户 2026-10-19 确认这条是对的）：
     缩放放大后视野只能显示 30 场，而窗口还是 75 ⇒ 自动缩到 30。
     注意它与"档位变灰"是两回事：档位看 `total`，这里看 `viewCount`。 */
  useEffect(() => {
    if (viewCount < 1) return
    if (size > viewCount) {
      setSize(viewCount)
      setStart((s2) => Math.min(s2, Math.max(0, total - viewCount)))
    }
  }, [viewCount, size, total])


  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      clamp()
      // 记住**视野**位置：数据刷新后若只按"窗口居中"还原，窗口会跳到轨道中间
      if (stateKey) {
        const cur = SLIDER_STATE.get(stateKey) ?? { pos: 0, size, scale }
        SLIDER_STATE.set(stateKey, { ...cur, scroll: el.scrollLeft })
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // 只依赖 clamp：监听器里读 stateKey/size/scale 是为了**顺带记住**视野位置，
    // 把它们放进依赖会反复重挂监听（且 clamp 已随 size/total 变化）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clamp])

  /* 场次异步到达 / 换 V：按 stateKey 归位（缩放也一起恢复） */
  const restoredKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (total < 1 || !stateKey || !owned || restoredKey.current === stateKey) return
    restoredKey.current = stateKey
    restoring.current = true
    // 恢复期间抑制 clamp：它会把 start 拽进**当前视野**，而视野还停在旧位置
    suppress.current = true
    const st = SLIDER_STATE.get(stateKey)
    const wantSize = Math.min(st?.size ?? minGrade, total)
    const span = Math.max(0, total - wantSize)
    const wantStart = st?.pos === undefined
      ? span                                   // 默认：贴最右
      : Math.max(0, Math.min(Math.round(st.pos * span), span))
    setSize(wantSize)
    setStart(wantStart)
    if (st?.scale) setScale(st.scale)

    // ⚠️ 关键：**把视野也滚到那一格**。`clamp()` 在每次滚动/布局后都会把 start
    // 拉进可视区（这是既有交互：拖动视野 = 移动窗口）。只恢复 start 不恢复滚动，
    // 下一帧 clamp 就把 start 拽回左边界 —— 这才是来回切换"漂移"的第二条路径。
    const el = scrollRef.current
    if (el) {
      const stp = Math.max(3, (BAR + GAP) * (st?.scale ?? scale))
      const center = PAD + wantStart * stp + (wantSize * stp) / 2
      const maxScroll = Math.max(0, (el.scrollWidth || 0) - el.clientWidth)
      // ① 有记住的视野位置就用它（用户手拖过视野就该保持）
      // ② 否则只在**需要**时居中：默认贴最右（wantStart === span）时不要居中，
      //    否则看起来就是"窗口自己跑到轨道中间"（2026-10-27 用户报的就是这个）
      const target = st?.scroll !== undefined
        ? st.scroll
        : (wantStart >= span ? maxScroll : center - el.clientWidth / 2)
      el.scrollLeft = Math.max(0, Math.min(maxScroll, target))
    }
    // 只在 stateKey 变化时归位：size/scale/scroll 在这里读的是**恢复当时**的值，
    // 把它们放进依赖会让归位反复触发（正是"漂移"的老问题）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // 等本轮渲染与 clamp 跑完再放开回写
    requestAnimationFrame(() => {
      suppress.current = false
      syncView()
      restoring.current = false
    })
  }, [stateKey, dataOwner, owned, total, minGrade, scale, syncView])

  /* 任何变动都写回缓存（位置存**相对比例**，切走再回来原样恢复） */
  useEffect(() => {
    if (!stateKey || !owned || total < 1 || restoring.current) return
    const span = total - size
    // 窗口比总场次还大（少场次 V）：位置无意义，固定记 1（贴右），避免污染
    const pos = span <= 0 ? 1 : Math.min(1, Math.max(0, start / span))
    SLIDER_STATE.set(stateKey, { pos, size, scale })
  }, [stateKey, dataOwner, owned, start, size, scale, total])

  /* 换档时把窗口居中 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const center = PAD + start * step + (size * step) / 2
    el.scrollLeft = Math.max(0, center - el.clientWidth / 2)
    clamp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size])

  /* 手选日期后：窗口覆盖整段（size = 全部场次，起点归零）
   *
   * ⚠️ 只认**coverTick 本身的变化**（2026-10-25 漂移真因）：
   * 原依赖是 `[coverTick, total]`，于是**每次 total 变化（切 V / 重新取数）都会重跑** ——
   * 只要用户曾经手选过一次日期（coverTick>0），切到任何 V 都会被强制成
   * `size=total, start=0`（整段、贴左），再被回写进那个 V 的缓存 ⇒ 来回切几次就漂到最左。
   * 用 `lastCover` 记住已执行的 tick，切 V 不再触发。 */
  const lastCover = useRef(0)
  useEffect(() => {
    if (!coverTick || coverTick === lastCover.current || total < 1) return
    lastCover.current = coverTick
    setSize(total)
    setStart(0)
    const el = scrollRef.current
    if (el) el.scrollLeft = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverTick, total])

  /* 恢复某个 V 的**结果包区间**（2026-10-28）：与 `coverTick` 同一套"只认 tick 变化"的纪律。
   * ⚠️ 复原 `start` 之后必须**把视野也滚过去** —— 否则下一帧 `clamp()` 会把 start 拽回
   * 可视区左边界（与"归位"那条踩过的坑一模一样）。 */
  const lastRestore = useRef(0)
  useEffect(() => {
    if (!restore || !restore.tick || restore.tick === lastRestore.current || total < 1) return
    lastRestore.current = restore.tick
    const wantSize = Math.max(1, Math.min(restore.size, total))
    const span = Math.max(0, total - wantSize)
    const wantStart = Math.max(0, Math.min(restore.start, span))
    setSize(wantSize)
    setStart(wantStart)
    const el = scrollRef.current
    if (el) {
      const stp = Math.max(3, (BAR + GAP) * scale)
      const center = PAD + wantStart * stp + (wantSize * stp) / 2
      const maxScroll = Math.max(0, (el.scrollWidth || 0) - el.clientWidth)
      el.scrollLeft = Math.max(0, Math.min(maxScroll, center - el.clientWidth / 2))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore?.tick, total])

  /* 通知外层 */
  useEffect(() => {
    if (!total || start + size > total) return
    const a = sessions[start]
    const b = sessions[Math.min(total - 1, start + size - 1)]
    if (!a || !b) return
    onChange({ start, size, since: a.d ?? a.at.slice(0, 10), until: b.d ?? b.at.slice(0, 10) })
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
                  /* 档位 = "用按钮直接把窗口调到这个大小"，所以它受**两个上限**制约
                     （2026-10-19 用户最终口径）：
                     - `total`   ：这段区间里总共就这么多场，不可能选出更多；
                     - `viewCount`：视野里放不下这么多 —— 视野装不下时窗口会被自动收缩，
                       所以按钮就该变灰，而不是点了又被缩回去。 */
                  disabled={g > total || g > viewCount}
                  title={
                    g > total ? `当前区间只有 ${total} 场`
                      : g > viewCount ? `当前视野只能显示 ${viewCount} 场（缩小可显示更多）`
                        : undefined
                  }
                  onClick={() => {
                    setSize(Math.min(g, total))
                    setStart((s) => Math.min(s, Math.max(0, total - Math.min(g, total))))
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
                 title={`${s.d ?? s.at.slice(0, 10)}${s.c ? ` · 已采 ${s.n.toLocaleString()} 条` : ' · 未采'}`} />
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
