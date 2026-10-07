/**
 * 单推模式的**唤出区判定**（2026-10-07 用户三条反馈后重做，`devlog/433`）。
 *
 * ## 为什么从"指针在哪个元素上"改成"指针在哪一格坐标上"
 *
 * 前两版都栽在同一件事上：唤出**会改变布局**（工具栏回来会把内容推走），于是
 * "指针下的元素"跟着变 ⇒ 状态来回翻 ⇒ **界面元素快速闪动 + 卡顿**；
 * 而且窄带是被一个透明覆盖层做的 ⇒ 谁压在上面、`pointer-events` 怎么让位，全是坑
 * （用户实测：左侧工具栏**依旧唤不出来**）。
 *
 * 按坐标判定：**与元素层级、遮挡、布局位移全都无关**，而且可以单测
 * （喂一对 `clientX/clientY` 就有确定答案）。
 *
 * ## 四个区（用户口径：**互不重叠**）
 *
 * ```
 * ┌──────────────────────────────┐  ← 顶栏区：贴着上缘那一条（唤出后长到顶栏那么高）
 * │  顶栏区                       │
 * ├────┬─────────────────────────┤
 * │工  │                         │
 * │具  │      界面元素区          │  ← 中间这块（红框）：**只恢复内容**，不碰两栏
 * │栏  │                         │
 * │区  │                         │
 * └────┴─────────────────────────┘
 * ```
 *
 * - `top`：贴上调出顶栏；`left`：贴上左缘调出工具栏（宽度 = 工具栏自身宽）；
 * - ★**唤出之后那个区会"长大"到该栏自身的大小**（顶栏高 / 工具栏宽）——
 *   否则指针一移进去就掉出薄条、栏又从手底下消失（"唤出即消失"）。
 * - 其余 ⇒ `center`：**只**把界面元素恢复出来（两栏继续收着，避免三样一起蹦）。
 */
import { useEffect, useState } from 'react'

export type SoloPeek = 'top' | 'left' | 'center'

/** 上缘那条**触发厚度**（薄条；唤出后才长到顶栏自身那么高）。
 *  ⚠️ 故意比顶栏矮得多：面板顶部还有一条"工具条唤出区"，两条一样高就会一起蹦。 */
export const PEEK_TRIGGER_PX = 12

/** 缺少 CSS 变量时的兜底（真值在 `layout.css` 的 `:root`）。 */
const FALLBACK_RAIL_W = 50
const FALLBACK_TOPBAR_H = 46

export interface PeekMetrics {
  /** 左侧工具栏宽度（= 唤出后 `left` 区的宽度） */
  railW: number
  /** 顶栏高度（= 唤出后 `top` 区的高度） */
  topH: number
  /** 当前唤出的区（决定那两个区要不要"长大"） */
  current: SoloPeek
}

export function peekZoneAt(x: number, y: number, m: PeekMetrics): SoloPeek {
  const topLimit = m.current === 'top' ? m.topH : PEEK_TRIGGER_PX
  /* ⚠️ 左缘**整宽**（不是薄条）：用户是把鼠标移到"工具栏本该在的那 50px"里的 ——
     薄条会把那一大片判成"中间区" ⇒ 什么都不唤出，那块就还是内容（用户报的"白色一片"）。 */
  const leftLimit = m.railW
  // ⚠️ 顺序即优先级：上缘那条压过左缘那条（左上角那一小块归顶栏）
  if (y <= topLimit) return 'top'
  if (x <= leftLimit) return 'left'
  return 'center'
}

/** 从 CSS 变量读两个尺寸（读不到就用兜底）。 */
export function readPeekMetrics(): { railW: number; topH: number } {
  const cs = getComputedStyle(document.documentElement)
  const num = (name: string, fallback: number) => {
    const v = Number.parseFloat(cs.getPropertyValue(name))
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  return { railW: num('--rail-width', FALLBACK_RAIL_W), topH: num('--topbar-height', FALLBACK_TOPBAR_H) }
}

/**
 * 订阅指针位置算出当前唤出区（`enabled` = 在单推里）。
 * 退出单推 ⇒ 复位成 `center`（下次进来不会带着上次的唤出态）。
 */
export function useSoloPeek(enabled: boolean): SoloPeek {
  const [peek, setPeek] = useState<SoloPeek>('center')
  useEffect(() => {
    if (!enabled) {
      setPeek('center')
      return
    }
    const { railW, topH } = readPeekMetrics()
    // ⚠️ `mousemove` 挂在 `window` 上、只看坐标：谁盖在上面、布局怎么动都不影响判定
    const onMove = (e: MouseEvent) => {
      setPeek((cur) => {
        const next = peekZoneAt(e.clientX, e.clientY, { railW, topH, current: cur })
        return next === cur ? cur : next      // 同值不触发重渲染
      })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [enabled])
  return peek
}

/** 多久没动鼠标算"闲置"（界面元素该让位给背景图了）。用户 2026-10-07：**5 秒**。 */
export const SOLO_IDLE_MS = 3000

/**
 * 多小的移动**不算**"动"（px）。
 *
 * ⚠️ 少了它，"停着不动"很难触发：触控板上搭着一根手指、或高 DPI 鼠标的传感器抖动，
 * 都会持续发 1px 级的 `mousemove` ⇒ 闲置计时被无限重置 ⇒
 * **用户实测"让位没生效"**（`devlog/436`）。死区之后"真的挪了鼠标"才算数。
 */
export const SOLO_IDLE_EPS_PX = 3

/**
 * 指针**静止**了多久（`devlog/434`）——"界面元素自动隐藏"的真正依据。
 *
 * ⚠️ 为什么不是"指针在中间那块"：用户要的是**自动**隐藏 —— 鼠标停一会儿就只剩背景图、
 * 一动就回来（屏保那套）。用"指针在哪个区"表达这件事时，"没动"与"动了但停在中间"分不开；
 * 而且上一版让 `data-peek` 恒有值（默认 `center`），恢复规则于是一直生效 ⇒
 * **自动隐藏直接没了**（用户报的第 2 条）。
 */
export function useSoloIdle(enabled: boolean, delayMs: number = SOLO_IDLE_MS): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setIdle(false)
      return
    }
    let timer = window.setTimeout(() => setIdle(true), delayMs)
    // 死区：只有"真的挪了"才重置计时（触控板搭手指/传感器抖动会一直发 1px 级的 mousemove）
    let lastX = Number.NaN
    let lastY = Number.NaN
    const onMove = (e: MouseEvent) => {
      const moved = !Number.isFinite(lastX)
        || Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) >= SOLO_IDLE_EPS_PX
      lastX = e.clientX
      lastY = e.clientY
      if (!moved) return
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), delayMs)
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', onMove)
    }
  }, [enabled, delayMs])
  return idle
}
