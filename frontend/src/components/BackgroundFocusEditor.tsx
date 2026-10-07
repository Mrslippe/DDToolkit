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
  focusTransform,
  parseBackgroundFocus,
  type BackgroundFocus,
} from '../utils/backgroundFocus'

/**
 * 背景取景编辑器（需求 7 / V1b-2，`devlog/419`）。
 *
 * ## 交互口径（用户 2026-10-07 定：**平移 + 缩放**，入口放档案设置里）
 *
 * - **直接操作**：按住预览图拖 = **图跟着指针走**（不是"拖一个取景框"）；
 * - 缩放滑杆 **1..3 倍**，1 = 原样铺；方向键也能平移（Shift ×5）；
 * - 「重置取景」= 删掉取景记录（**不动背景图本身**，那是「清除」的事）。
 *
 * 存的是**归一化**值（比例 + 倍数），几何在 `utils/backgroundFocus.ts`。
 *
 * ## 四个不显然的坑（都在下面标了 ⚠️）
 *
 * 1. **`scale === 1` 时平移在数学上无处可去**（溢出量 `(s-1)·W ≡ 0`）：真正开始移动时
 *    把缩放**抬到 1.2**，否则用户拖半天纹丝不动、像坏了。抬的动作发生在**越过死区之后**，
 *    所以"点一下预览"不会平白放大。
 * 2. **松手才发请求**：拖拽在 `pointerup` 提交、滑杆 260ms 防抖 —— 一次拖动只打一发 PUT。
 * 3. **关窗兜底**：防抖窗口内关窗会把最后一格丢掉，卸载时补发一次（与弹窗里 `commitSign` 同一套路）。
 * 4. **预览不等于卡片页**：两边几何完全相同，但 `cover` 的裁切量取决于容器宽高比，
 *    这里只是"同向预览"。别拿它当像素级对齐来验。
 */
const PAN_DEAD_PX = 3
/** 从"没缩放"开始拖时抬到的倍数 —— 见坑 1。 */
const DRAG_MIN_SCALE = 1.2
/** 方向键一步的取景点位移（比例）。 */
const KEY_STEP = 0.02
/** 滑杆防抖 —— 一次滑动只打一发。 */
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
  w: number
  h: number
  base: BackgroundFocus
  armed: boolean
  last: BackgroundFocus
}

/** 滑杆值贴回整数边界：1.0000001 会让 `focusTransform` 生成一个看不见的恒等变换。 */
function snapScale(v: number): number {
  const c = Math.min(FOCUS_MAX_SCALE, Math.max(FOCUS_MIN_SCALE, v))
  return Math.abs(c - FOCUS_MIN_SCALE) < 0.005 ? FOCUS_MIN_SCALE : c
}

export default function BackgroundFocusEditor({ vtuber, src, onSaved, onPill }: Props) {
  const [focus, setFocus] = useState<BackgroundFocus>(
    () => parseBackgroundFocus(vtuber.background_focus) ?? FOCUS_CENTER,
  )
  const [busy, setBusy] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<BackgroundFocus | null>(null)

  // 换了 V / 别处改了库里的值 ⇒ 预览跟着走。
  // 自己存进去的和本地这份一样 ⇒ 不跳（`onSaved` 回来的 `background_focus` 就是刚 PUT 的值）。
  useEffect(() => {
    setFocus(parseBackgroundFocus(vtuber.background_focus) ?? FOCUS_CENTER)
  }, [vtuber.id, vtuber.background_focus])

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

  // ⚠️ 坑 3：关窗兜底。用 ref 拿"最新那一格"，不能靠 effect 的闭包（它只在挂载时跑一次）。
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

  /** 拖到"边界外"就夹住 —— 图跟着指针，但取景点不会跑到图片外面去。 */
  const panByPixels = (base: BackgroundFocus, dx: number, dy: number, w: number, h: number) =>
    clampFocus({
      scale: base.scale,
      // 图右移 dx 像素 ⇒ translate 增加 dx ⇒ (0.5-x) 增加 ⇒ x 减小（方向口径见 `backgroundFocus.ts`）
      x: base.x - dx / ((base.scale - 1) * w),
      y: base.y - dy / ((base.scale - 1) * h),
    })

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const base = clampFocus(focus)
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      w: r.width || 1, // jsdom / 隐藏容器里量出来是 0，别让它变成 Infinity
      h: r.height || 1,
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
      // ⚠️ 坑 1：没缩放就没有溢出，平移无处可去 ⇒ 越过死区才抬到 1.2（滑杆就在旁边，看得见它动）
      //    ⚠️ 只在**本来是 1** 时抬：否则用户拖着 200% 的图，一按就被拽回 120%
      if (d.base.scale === FOCUS_MIN_SCALE) d.base = { ...d.base, scale: snapScale(DRAG_MIN_SCALE) }
    }
    d.last = panByPixels(d.base, dx, dy, d.w, d.h)
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
    // ⚠️ 坑 2：松手才发请求（`d.last` 而不是 state —— 事件闭包里的 state 可能差一帧）
    if (d?.armed) void commit(d.last)
  }

  /** 方向键：与拖拽**同一个模型**（箭头推的是**图**，不是取景框）—— `aria-label` 里写明了。 */
  const nudge = (dx: number, dy: number) => {
    const base = clampFocus(focus)
    scheduleCommit({
      scale: base.scale === FOCUS_MIN_SCALE ? snapScale(DRAG_MIN_SCALE) : base.scale,
      x: base.x - dx,
      y: base.y - dy,
    })
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

  const transform = focusTransform(focus)
  const atMinScale = focus.scale <= FOCUS_MIN_SCALE

  return (
    <div className="vd-focus">
      <div
        className="vd-focus-stage"
        role="group"
        tabIndex={0}
        aria-label="背景取景：拖动或按方向键平移图片"
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
          className="vd-focus-img"
          data-testid="focus-img"
          style={{ backgroundImage: `url(${src})`, transform }}
        />
        {atMinScale && <span className="vd-focus-hint">拖动取景</span>}
      </div>
      <div className="vd-focus-bar">
        <span className="vd-focus-label">缩放</span>
        <input
          type="range"
          className="vd-focus-range"
          min={FOCUS_MIN_SCALE}
          max={FOCUS_MAX_SCALE}
          step={0.01}
          value={focus.scale}
          aria-label="背景缩放"
          // ⚠️ 这里**不能** `disabled={busy}`：拖滑杆时防抖一提交就 busy，滑杆会在手底下被禁掉
          onChange={(e) => scheduleCommit({ ...focus, scale: snapScale(Number(e.target.value)) })}
        />
        <span className="vd-focus-pct">{Math.round(focus.scale * 100)}%</span>
        <Button
          variant="outline"
          size="sm"
          disabled={!vtuber.background_focus || busy}
          onClick={() => void reset()}
        >
          <RotateCcw className="size-4" />
          重置取景
        </Button>
      </div>
    </div>
  )
}
