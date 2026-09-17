import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LOCK_MS, initialWheelState, releaseAction, wheelAction } from './deckWheel'
import type { WheelState } from './deckWheel'

/**
 * 数据视图「牌堆」（R40，用户 2026-09-19）。
 *
 * 需求原话：「抛弃原来的卡片固定布局，上下滚动来看不同卡片，取而代之的是在页面中只展示一张卡片，
 * 滚轮上下滚动就在卡片集中轮流切换」+ 方向语义：
 *   - **向下滚**（前进）：当前卡**向下滑出框**，它背后那张**从透明渐显**（带位移与缩放）；
 *   - **向上滚**（退回）：当前卡**向后渐隐**，上一张**从下面滑动入框**。
 *
 * 三条设计要点（都有探针断言）：
 *   ① **索引是唯一真值，视觉跟着它走** —— 中途改向（下→上）能自然接上，
 *      因为 CSS transition 在目标值变化时**从当前计算值续跑**，不需要等上一段放完；
 *   ② **滚轮分两条通道**（用户当场质疑过"120ms 静默分界快速滚动会不会卡手"）：
 *      鼠标是**离散大格**（一次 |Δ|≥40）⇒ **每格一张**，快拨就连续翻；
 *      触控板是**连续小流**（|Δ|<40）⇒ 累积到阈值切一张，**同一次手势内不再切**
 *      （惯性尾巴不会一划飞到底）。两者用同一把**软锁 150ms**，锁内离散格最多记 2 格欠账。
 *   ③ **只动 transform/opacity** —— 不走布局，ECharts 的 ResizeObserver 也不会被触发
 *      （它观察布局盒，不观察变换）⇒ 切换时图表**零重建**，这是流畅的根本原因。
 *
 * 无障碍：内容藏在手势后面 ⇒ 键盘五键（↑↓/PageUp/PageDown/Home/End）+
 * 可点的右缘圆点 + 非前卡 `inert`/`aria-hidden`（Tab 与读屏都不该进看不见的卡）。
 */

/** 相位保持时长（动画结束就清相位；比入场动画略长一点，保证探针在动画中读得到） */
const PHASE_MS = 460

interface Props {
  /** 每张卡的稳定 key（React key 与持久化都用它） */
  keys: string[]
  /** 按 V 记住"上次看到第几张"的命名空间（通常传 vtuberId） */
  persistKey: string
  children: ReactNode[]
}

const clampIdx = (i: number, n: number) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i)
/** 循环取模（R40b：用户要求"滚动做成循环"）—— 末张向下回首张、首张向上回末张 */
const wrapIdx = (i: number, n: number) => ((i % n) + n) % n

export default function DataDeck({ keys, persistKey, children }: Props) {
  const count = children.length
  const storeKey = `ddtoolkit.deck.${persistKey}`
  const [index, setIndex] = useState(() => {
    try {
      const raw = window.sessionStorage.getItem(storeKey)
      const n = raw === null ? 0 : Number(raw)
      return Number.isFinite(n) ? clampIdx(n, count) : 0
    } catch {
      return 0            // sessionStorage 不可用：按第一张
    }
  })
  /** 动画方向（`idle` = 静止）；同时驱动 CSS 与探针断言 */
  const [phase, setPhase] = useState<'idle' | 'down' | 'up'>('idle')
  /** 出场卡（动画期间才有）：仅靠"当前索引"分不出"谁在离开"，必须显式记住 */
  const [outIdx, setOutIdx] = useState<number | null>(null)
  /**
   * 圆点是否可见（R40b，用户 2026-09-19）：
   * 「右侧圆点透明度改为 50%，并且没有滚动或者手动切换卡片的时候自动隐藏，有滚动或鼠标 hover 才显示」。
   * 静止时**完全不占视觉**（opacity 0 + `pointer-events: none`，不会挡住卡片），
   * 滚轮/键盘/点圆点后亮起 1.4s，鼠标进入面板期间保持。
   */
  const [dotsOn, setDotsOn] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const phaseTimer = useRef<number | null>(null)
  const dotsTimer = useRef<number | null>(null)
  const hovering = useRef(false)
  /** 滚轮状态（纯函数持有；放 ref 里 ⇒ 滚轮事件不引起重渲染） */
  const wheel = useRef<WheelState>(initialWheelState())

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storeKey, String(index))
    } catch {
      /* 存不下就算了：不影响本次会话内的切换 */
    }
  }, [storeKey, index])

  useEffect(() => () => {
    if (phaseTimer.current != null) window.clearTimeout(phaseTimer.current)
    if (dotsTimer.current != null) window.clearTimeout(dotsTimer.current)
  }, [])

  /** 亮一下圆点（滚动/键盘/点圆点之后） */
  const flashDots = useCallback(() => {
    setDotsOn(true)
    if (dotsTimer.current != null) window.clearTimeout(dotsTimer.current)
    dotsTimer.current = window.setTimeout(() => {
      dotsTimer.current = null
      if (!hovering.current) setDotsOn(false)     // 鼠标还在面板上就继续显示
    }, 1400)
  }, [])

  /** 唯一入口：切一张。**循环**（R40b：末张向下回首张、首张向上回末张） */
  const step = useCallback((dir: 1 | -1) => {
    setIndex((cur) => {
      if (count <= 1) return cur                  // 只有一张：没有可切的目标
      const next = wrapIdx(cur + dir, count)
      setOutIdx(cur)
      setPhase(dir > 0 ? 'down' : 'up')
      flashDots()
      wheel.current = { ...wheel.current, lockUntil: performance.now() + LOCK_MS }
      if (phaseTimer.current != null) window.clearTimeout(phaseTimer.current)
      phaseTimer.current = window.setTimeout(() => {
        setPhase('idle')
        setOutIdx(null)
        // 锁内攒下的欠账：解锁时消化一格（余下的留给下一次解锁）
        const r = releaseAction(wheel.current)
        wheel.current = r.state
        if (r.action.kind === 'release') step(r.action.dir)
      }, PHASE_MS)
      return next
    })
  }, [count, flashDots])

  /** 滚轮：两条通道（决策是**纯函数** `wheelAction`，见 `deckWheel.ts` 的说明） */
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()                     // 隔离外层滚动/橡皮筋
    const r = wheelAction(wheel.current, e.deltaY, performance.now())
    wheel.current = r.state
    if (r.action.kind === 'step') step(r.action.dir)
  }, [step])

  // `passive: false` 才能 preventDefault（React 的 onWheel 在部分浏览器上是被动监听）
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const handler = (e: WheelEvent) => onWheel(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [onWheel])

  /**
   * 明确的导航动作（键盘 / 点圆点）要**取消待消化的滚轮欠账** ——
   * 否则用户按了 Home 之后，上一轮滚轮攒下的欠账会在解锁时把卡片又推走一格
   * （探针实测到过：Home 之后索引被推回末张）。
   */
  const cancelWheelDebt = () => {
    wheel.current = { ...wheel.current, credit: 0, acc: 0, smoothUsed: true }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key
    if (k === 'ArrowDown' || k === 'PageDown') { e.preventDefault(); cancelWheelDebt(); step(1) }
    else if (k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); cancelWheelDebt(); step(-1) }
    else if (k === 'Home') { e.preventDefault(); cancelWheelDebt(); flashDots(); setIndex(0) }
    else if (k === 'End') { e.preventDefault(); cancelWheelDebt(); flashDots(); setIndex(count - 1) }
  }

  /**
   * 每张卡相对当前索引的位次：CSS 全靠它 + 相位决定落点。
   * **索引按循环算**（R40b）：末张的"下一张"是首张、首张的"上一张"是末张。
   * ⚠️ 只有两张卡时 `next` 与 `prev` 会撞成同一张 ⇒ 给它一个 `both`（偏后偏下的中间位），
   * 两个方向都能从那里起步；三张起 next/prev 各就各位（方向语义完全体）。
   */
  const posOf = (i: number) => {
    if (i === index) return 'front'
    if (i === outIdx) return 'out'
    if (count <= 1) return 'other'
    const nextI = wrapIdx(index + 1, count)
    const prevI = wrapIdx(index - 1, count)
    if (nextI === prevI) return i === nextI ? 'both' : 'other'
    if (i === nextI) return 'next'         // 向下滚时从**背后**进来
    if (i === prevI) return 'prev'         // 向上滚时从**下方**进来
    return 'other'
  }

  return (
    <div
      ref={rootRef}
      className="data-deck"
      data-deck=""
      data-deck-index={index}
      data-deck-phase={phase}
      data-deck-dots={dotsOn ? 'on' : 'off'}
      data-deck-count={count}
      tabIndex={0}
      role="group"
      aria-label={`数据卡片（第 ${index + 1} 张，共 ${count} 张）`}
      onKeyDown={onKeyDown}
      onPointerEnter={() => { hovering.current = true; setDotsOn(true) }}
      onPointerLeave={() => {
        hovering.current = false
        // 鼠标离开：若刚切过卡（闪显期内）就继续留着，否则立刻收
        if (dotsTimer.current == null) setDotsOn(false)
      }}
    >
      <div className="deck-frame">
        {children.map((child, i) => {
          const pos = posOf(i)
          const front = pos === 'front'
          return (
            <div
              key={keys[i] ?? i}
              className="deck-card"
              data-deck-card={keys[i] ?? String(i)}
              data-deck-pos={pos}
              aria-hidden={front ? undefined : 'true'}
              {...({ inert: front ? undefined : '' } as Record<string, unknown>)}
            >
              {child}
            </div>
          )
        })}
      </div>
      {/* 右缘竖排圆点：一次只看一张时，"还有几张 / 我在第几张"必须有出口。
          静止时**完全隐藏**（opacity 0 + 不吃指针），滚轮/键盘/点圆点后亮 1.4s、鼠标悬停期间常显。 */}
      <div className="deck-dots" role="tablist" aria-label="卡片位置"
           data-deck-dots={dotsOn ? 'on' : 'off'}>
        {children.map((_, i) => (
          <button
            key={keys[i] ?? i}
            type="button"
            className="deck-dot"
            data-deck-dot={i === index ? 'on' : 'off'}
            role="tab"
            aria-selected={i === index}
            aria-label={`第 ${i + 1} 张`}
            onClick={() => { cancelWheelDebt(); flashDots(); setIndex(i) }}
          />
        ))}
      </div>
    </div>
  )
}
