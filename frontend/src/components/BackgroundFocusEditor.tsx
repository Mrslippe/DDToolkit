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
 * 背景取景编辑器（需求 7 / V1b-2，`devlog/419`；**口径换成"图片锚点"是 V1b-3，`devlog/420`**）。
 *
 * ## 交互口径（用户看完 `docs/design/background-fit/resize-drift.html` 后选 C）
 *
 * - **直接操作**：按住预览图拖 = **图跟着指针走**（1:1）；滑杆 = 缩放 1..3 倍；方向键平移（Shift ×5）；
 * - 「重置取景」= 删掉记录（**不动背景图本身**，那是「清除」的事）；
 * - 存的是**图片锚点**：`x=0` 看左边缘、`x=1` 看右边缘 ⇒ 你钉的那条线**换窗口宽度也不动**。
 *
 * ## 四个不显然的坑（都在下面标了 ⚠️）
 *
 * 1. **拖拽要按"溢出量"换算**（`panDelta`）：竖图铺在宽面板里，**横向根本没有可挪的余量**
 *    ⇒ 横着拖不动是**正确**结果，不是坏了；纵向照挪。
 *    ⚠️ 这一条也让 V1b-2 那个"拖动时自动抬到 120%"的权宜之计**不再需要**（它当初是为了绕开
 *    "`scale=1` 时平移在数学上无处可去"）。
 * 2. **预览的比例要照着真背景层量**（`getBoundingClientRect`）：`cover` 的裁切量取决于容器宽高比，
 *    预览框比例不对 ⇒ 你在预览里调好的构图到卡片页上不是那个样子。
 * 3. **松手才发请求**：拖拽在 `pointerup` 提交、滑杆 260ms 防抖 —— 一次拖动只打一发 PUT。
 * 4. **关窗兜底**：防抖窗口内关窗会把最后一格丢掉，卸载时补发一次（与弹窗里 `commitSign` 同一套路）。
 */
const PAN_DEAD_PX = 3
/** 方向键一步的锚点位移（比例）。 */
const KEY_STEP = 0.02
/** 滑杆防抖 —— 一次滑动只打一发。 */
const COMMIT_DEBOUNCE_MS = 260
/** 量不到真背景层时，预览框退回这个比例（≈ 卡片页常见形态）。 */
const FALLBACK_ASPECT = 16 / 9

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
  /** 图片原始尺寸（拖拽换算要用；`cover` 的倍数 = max(框/图)） */
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [aspect, setAspect] = useState(FALLBACK_ASPECT)
  const dragRef = useRef<DragState | null>(null)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<BackgroundFocus | null>(null)

  // 换了 V / 别处改了库里的值 ⇒ 预览跟着走。
  // 自己存进去的和本地这份一样 ⇒ 不跳（`onSaved` 回来的 `background_focus` 就是刚 PUT 的值）。
  useEffect(() => {
    setFocus(parseBackgroundFocus(vtuber.background_focus) ?? FOCUS_CENTER)
  }, [vtuber.id, vtuber.background_focus])

  // ⚠️ 坑 2：照真背景层的比例来预览。量不到（比如视图里没有 hero）就退回常见比例。
  useEffect(() => {
    const el = document.querySelector('.hero-backdrop')
    const r = el?.getBoundingClientRect()
    if (r && r.width > 0 && r.height > 0) setAspect(r.width / r.height)
  }, [])

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

  // ⚠️ 坑 4：关窗兜底。用 ref 拿"最新那一格"，不能靠 effect 的闭包（它只在挂载时跑一次）。
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const w = r.width || 1 // jsdom / 隐藏容器里量出来是 0，别让它变成 Infinity
    const h = r.height || 1
    const k = nat ? coverScale(nat, { w, h }) : 1
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      w,
      h,
      imgW: (nat?.w ?? w) * k,
      imgH: (nat?.h ?? h) * k,
      base: clampFocus(focus),
      armed: false,
      last: clampFocus(focus),
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
    // ⚠️ 坑 1：换算按"溢出量"来 —— `panDelta` 在没余量的那条轴上返回 0（横着拖不动是正确结果）
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
    // ⚠️ 坑 3：松手才发请求（`d.last` 而不是 state —— 事件闭包里的 state 可能差一帧）
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
  const canPan = nat !== null   // 量到图片尺寸才知道哪条轴挪得动

  return (
    <div className="vd-focus">
      <div
        className="vd-focus-stage"
        style={{ aspectRatio: String(aspect) }}
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
          style={{ backgroundImage: `url(${src})`, ...style }}
        />
        {canPan && <span className="vd-focus-hint">拖动取景</span>}
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
