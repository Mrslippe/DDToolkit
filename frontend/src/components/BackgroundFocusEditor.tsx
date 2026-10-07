import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '../api/api'
import type { VTuber } from '../api/types'
import {
  FOCUS_CENTER,
  FOCUS_MAX_SCALE,
  FOCUS_MIN_SCALE,
  clampFocus,
  coverScale,
  focusStyle,
  panDelta,
  parseBackgroundFocus,
  type BackgroundFocus,
} from '../utils/backgroundFocus'

/**
 * 背景取景（需求 7 / `devlog/419`→`420`→`421`）。
 *
 * ## 做法：**预览框本身就是操作面**（V1b-4，用户要求）
 *
 * 「档案设置」里那个 132×74 的背景预览直接可操作 —— **拖 = 平移**（图跟着指针走，1:1）、
 * **滚轮 = 缩放**、方向键微调（Shift ×5）、旁边一个「重置取景」图标钮。
 * ⚠️ **没有滑杆**（用户明确要求撤掉）：它曾经单独占一行、和预览各显示一遍同一件事。
 *
 * 存的是**图片锚点**（`x=0` 看左边缘、`x=1` 看右边缘）⇒ 你钉的那条线换窗口宽度也不动；
 * 几何全在 `utils/backgroundFocus.ts`。
 *
 * ## 五个不显然的坑（都在下面标了 ⚠️）
 *
 * 1. **滚轮必须挂原生非被动监听**：React 的 `onWheel` 是 passive 的，`preventDefault()` 无效
 *    ⇒ 弹窗内容体一边缩放一边跟着滚。`addEventListener('wheel', h, { passive: false })` 才行。
 * 2. **滚轮步长按 delta 指数映射**，不是"一格 ×1.1"：触控板一次滑动会发几十个事件，
 *    按事件乘会瞬间顶到 3×（鼠标一格 ≈ +16%）。
 * 3. **拖拽按"溢出量"换算**（`panDelta`）：竖图铺在宽框里**横向没有余量 ⇒ 拖了不动是正确结果**，
 *    纵向照挪；没余量的轴返回 0，不许除出个巨大跳变。
 * 4. **取景三件套挂在内层**：`transform: scale()` 会连边框圆角一起放大，挂外层框就长到邻居身上。
 * 5. **松手/滚停才发请求**（260ms 防抖）+ **关窗兜底**补发最后一格（与弹窗里 `commitSign` 同套路）。
 */
const PAN_DEAD_PX = 3
/** 方向键一步的锚点位移（比例）。 */
const KEY_STEP = 0.02
/** 滚轮的指数映射系数：鼠标一格（deltaY≈±100）≈ ±16%。 */
const WHEEL_RATE = 0.0015
/** 行模式的 deltaY（Firefox）大约是这个数量级的 px 当量。 */
const LINE_TO_PX = 33
/** 保存防抖 —— 一次拖动/一段滚轮只打一发 PUT。 */
const COMMIT_DEBOUNCE_MS = 260

interface Props {
  vtuber: VTuber
  /** 已 `resolveAsset` 过的背景图 URL（没背景就不渲染本组件）。 */
  src: string
  onSaved: (v: VTuber) => void
  onPill?: (msg: string) => void
}

interface DragState {
  px: number
  py: number
  /** 预览框尺寸 + 图片在 `scale=1` 时的渲染尺寸（拖拽换算全用它们） */
  w: number
  h: number
  imgW: number
  imgH: number
  base: BackgroundFocus
  armed: boolean
  last: BackgroundFocus
}

/** 滑杆值贴回整数边界：1.0000001 会让 `focusStyle` 生成一个看不见的恒等变换。 */
function snapScale(v: number): number {
  const c = Math.min(FOCUS_MAX_SCALE, Math.max(FOCUS_MIN_SCALE, v))
  return Math.abs(c - FOCUS_MIN_SCALE) < 0.005 ? FOCUS_MIN_SCALE : c
}

export default function BackgroundFocusEditor({ vtuber, src, onSaved, onPill }: Props) {
  const [focus, setFocus] = useState<BackgroundFocus>(
    () => parseBackgroundFocus(vtuber.background_focus) ?? FOCUS_CENTER,
  )
  const [busy, setBusy] = useState(false)
  /** 图片原始尺寸（拖拽换算要用：`cover` 倍数 = max(框/图)，没它就不知道哪条轴有余量） */
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<BackgroundFocus | null>(null)

  // 换了 V / 别处改了库里的值 ⇒ 预览跟着走。
  // 自己存进去的和本地这份一样 ⇒ 不跳（`onSaved` 回来的 `background_focus` 就是刚 PUT 的值）。
  useEffect(() => {
    setFocus(parseBackgroundFocus(vtuber.background_focus) ?? FOCUS_CENTER)
  }, [vtuber.id, vtuber.background_focus])

  // 图片原始尺寸：拖拽要知道"这条轴有没有可挪的余量"
  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setNat({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = src
    return () => { cancelled = true }
  }, [src])

  const commit = useCallback(
    async (next: BackgroundFocus) => {
      const c = clampFocus(next)
      setFocus(c) // 乐观：先跟手，不等往返
      setBusy(true)
      try {
        onSaved(await api.setBackgroundFocus(vtuber.id, c))
      } catch (e) {
        toast.error(`保存取景失败：${(e as Error).message}`)
        // 回滚到库里那份（`vtuber` 还是旧的 ⇒ 这正是"上一版"）
        setFocus(parseBackgroundFocus(vtuber.background_focus) ?? FOCUS_CENTER)
      } finally {
        setBusy(false)
      }
    },
    [vtuber.id, vtuber.background_focus, onSaved],
  )

  const scheduleCommit = useCallback(
    (next: BackgroundFocus) => {
      const c = clampFocus(next)
      setFocus(c)
      pendingRef.current = c
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        const p = pendingRef.current
        pendingRef.current = null
        if (p) void commit(p)
      }, COMMIT_DEBOUNCE_MS)
    },
    [commit],
  )

  // ⚠️ 坑 5：关窗兜底。用 ref 拿"最新那一格"，不能靠 effect 的闭包（它只在挂载时跑一次）。
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const p = pendingRef.current
    pendingRef.current = null
    if (p) void commit(p)
  }
  useEffect(() => () => flushRef.current(), [])

  // ⚠️ 坑 1+2：滚轮。监听器只挂一次 ⇒ 用 ref 读最新的 state / 调度函数（闭包里的会是旧的）。
  const focusRef = useRef(focus)
  focusRef.current = focus
  const scheduleRef = useRef(scheduleCommit)
  scheduleRef.current = scheduleCommit
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()   // 拦住"一边缩放一边滚弹窗"（被动监听做不到这件事）
      const dy = e.deltaY * (e.deltaMode === 1 ? LINE_TO_PX : 1)
      const cur = focusRef.current
      // 指数映射：向上滚（deltaY < 0）放大
      scheduleRef.current({ ...cur, scale: snapScale(cur.scale * Math.exp(-dy * WHEEL_RATE)) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const w = r.width || 1 // jsdom / 隐藏容器里量出来是 0，别让它变成 Infinity
    const h = r.height || 1
    const k = nat ? coverScale(nat, { w, h }) : 1
    const base = clampFocus(focus)
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      w,
      h,
      imgW: (nat?.w ?? w) * k,
      imgH: (nat?.h ?? h) * k,
      base,
      armed: false,
      last: base,
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* jsdom 没有真指针、或指针已失效：捕获不到也照样能拖 */
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    if (!d.armed) {
      if (Math.abs(dx) < PAN_DEAD_PX && Math.abs(dy) < PAN_DEAD_PX) return // 死区：点心一下不算取景
      d.armed = true
    }
    // ⚠️ 坑 3：换算按"溢出量"来 —— `panDelta` 在没余量的那条轴上返回 0
    d.last = clampFocus({
      scale: d.base.scale,
      x: d.base.x + panDelta(dx, d.w, d.imgW, d.base.scale),
      y: d.base.y + panDelta(dy, d.h, d.imgH, d.base.scale),
    })
    setFocus(d.last)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 同 down */
    }
    // ⚠️ 坑 5：松手才发请求（`d.last` 而不是 state —— 事件闭包里的 state 可能差一帧）
    if (d?.armed) void commit(d.last)
  }

  /** 方向键：与拖拽**同一个模型**（箭头推的是**图**）—— `aria-label` 里写明了。 */
  const nudge = (dx: number, dy: number) => {
    const base = clampFocus(focus)
    scheduleCommit({ scale: base.scale, x: base.x - dx, y: base.y - dy })
  }

  const reset = async () => {
    setFocus(FOCUS_CENTER)
    try {
      onSaved(await api.clearBackgroundFocus(vtuber.id))
      onPill?.('已重置取景')
    } catch (e) {
      toast.error(`重置取景失败：${(e as Error).message}`)
      setFocus(parseBackgroundFocus(vtuber.background_focus) ?? FOCUS_CENTER)
    }
  }

  const style = focusStyle(focus)
  const zoomed = focus.scale > FOCUS_MIN_SCALE

  return (
    <div
      ref={boxRef}
      className="vd-bg-preview is-fit"
      data-testid="focus-box"
      role="group"
      tabIndex={0}
      aria-label="背景取景：拖动平移、滚轮缩放（方向键微调）"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(e) => {
        const step = KEY_STEP * (e.shiftKey ? 5 : 1)
        const dirs: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        }
        const hit = dirs[e.key]
        if (!hit) return
        e.preventDefault()
        nudge(hit[0], hit[1])
      }}
    >
      <div
        className="vd-bg-focus"
        data-testid="focus-img"
        style={{ backgroundImage: `url(${src})`, ...style }}
      />
      {/* 重置钮**在框内**（用户撤掉滑杆后它从按钮排搬进来）：
          ⚠️ 必须自己吃掉 pointerdown，否则按一下会顺手起一次拖拽 */}
      <Button
        variant="outline"
        size="sm"
        className="vd-focus-reset"
        title="重置取景"
        aria-label="重置取景"
        disabled={!vtuber.background_focus || busy}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void reset()}
      >
        <RotateCcw className="size-4" />
      </Button>
      {/* 读数不是滑杆：只在真放大时露出来 */}
      {zoomed && <span className="vd-focus-zoom">{Math.round(focus.scale * 100)}%</span>}
      {/* 抓手光标只有鼠标用户看得见，键盘/触控用户看不出"这里能操作" ⇒ 没取景时给一句引导 */}
      {!vtuber.background_focus && (
        <span className="vd-focus-hint">拖动平移 · 滚轮缩放 · 方向键微调</span>
      )}
    </div>
  )
}
