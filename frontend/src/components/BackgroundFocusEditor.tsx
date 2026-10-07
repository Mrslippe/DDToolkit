import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Film, ImageIcon, RotateCcw } from 'lucide-react'
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
  focusObjectStyle,
  focusStyle,
  panDelta,
  parseBackgroundFocus,
  type BackgroundFocus,
} from '../utils/backgroundFocus'

/**
 * 背景取景（需求 7 图片取景 / 需求 9 视频取景；`devlog/419`→`420`→`421`→`422`→`427`）。
 *
 * ## 做法：**预览框本身就是操作面**
 *
 * 132... 整幅宽的预览框上：**拖 = 平移**、**滚轮 = 缩放**、方向键微调（Shift ×5）、
 * 右上角「重置取景」。⚠️ **没有滑杆**（用户明确要求撤掉）。
 *
 * ## 两份取景，一个按钮切换（用户口径 2026-10-07，`devlog/426`/`427`）
 *
 * 图片与视频**各存一份**取景（`background_focus` / `background_video_focus`），
 * 左上角那个按钮切换"现在调的是谁"。三条口径：
 * 1. **调视频时预览用视频首帧**（`#t=0.001` + `preload="auto"` + **不 autoplay**）——
 *    取景要看的就是"画面被怎么裁"，拿图当预览等于骗人；
 * 2. **调图片时把视频收起来**：真实投放里视频是**盖住图**的，不收起来就没法看你在调的图
 *    （图仍然垫在下面当 poster，与真实图层的结构一致）；
 * 3. **两份互不回落**：视频没有独立取景时**不**借用图那份 —— 借了的话"重置视频取景"
 *    看起来没生效（值变了画面不变）。
 *
 * ## 五个不显然的坑（都在下面标了 ⚠️）
 *
 * 1. **滚轮必须挂原生非被动监听**：React 的 `onWheel` 是 passive 的，`preventDefault()` 无效
 *    ⇒ 弹窗内容体一边缩放一边跟着滚。
 * 2. **滚轮步长按 delta 指数映射**，不是"一格 ×1.1"：触控板一次滑动会发几十个事件。
 * 3. **拖拽按"溢出量"换算**（`panDelta`）：竖图铺在宽框里**横向没有余量 ⇒ 拖了不动是正确结果**。
 * 4. **取景三件套挂在内层**：`transform: scale()` 会连边框圆角一起放大。
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
/** 首帧预览：媒体片段 `#t=` 让浏览器直接停在第一帧，不播。 */
const FIRST_FRAME_T = 0.001

type Target = 'image' | 'video'

interface Props {
  vtuber: VTuber
  /** 已 `resolveAsset` 过的背景图 URL（没背景就不渲染本组件）。 */
  src: string
  /** 已 `resolveAsset` 过的背景视频 URL（没视频时为空 ⇒ 不显示切换钮）。 */
  videoSrc?: string | null
  onSaved: (v: VTuber) => void
  onPill?: (msg: string) => void
}

interface DragState {
  px: number
  py: number
  /** 预览框尺寸 + 媒体在 `scale=1` 时的渲染尺寸（拖拽换算全用它们） */
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

export default function BackgroundFocusEditor({ vtuber, src, videoSrc, onSaved, onPill }: Props) {
  const hasVideo = Boolean(videoSrc)
  /* ★ 有视频就**默认调视频**（用户口径 2026-10-07，`devlog/428`）：视频是**盖在图上**的那一层，
     观众看到的就是它 —— 进来先调看得见的那一层，图的取景点左上角切过去。
     ⚠️ 只有"两样都有"时才这样；没视频就只能调图。 */
  const [target, setTarget] = useState<Target>(() => (videoSrc ? 'video' : 'image'))
  /** 视频是**后传**上来的（弹窗开着的时候）⇒ 跟着切过去：那一刻的意图就是"调这段视频"。 */
  const hadVideo = useRef(Boolean(videoSrc))
  useEffect(() => {
    if (videoSrc && !hadVideo.current) setTarget('video')
    hadVideo.current = Boolean(videoSrc)
  }, [videoSrc])
  /** 当前调的那一份（存库里的原文；两份各取各的，不回落）。 */
  const storedOf = useCallback(
    (t: Target) => (t === 'image' ? vtuber.background_focus : vtuber.background_video_focus),
    [vtuber.background_focus, vtuber.background_video_focus],
  )
  const [focus, setFocus] = useState<BackgroundFocus>(() => {
    const raw = videoSrc
      ? (vtuber.background_video_focus ?? vtuber.background_focus)
      : (vtuber.background_focus ?? vtuber.background_video_focus)
    return parseBackgroundFocus(raw) ?? FOCUS_CENTER
  })
  const [busy, setBusy] = useState(false)
  /** 当前媒体的原始尺寸（拖拽要用：`cover` 倍数 = max(框/媒体)） */
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  /** 视频首帧是否已经能显示（`loadeddata` 之前先看图，与真实投放的 `data-ready` 同思路） */
  const [frameReady, setFrameReady] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<BackgroundFocus | null>(null)

  // 换 V / 换了目标 / 别处改了库里的值 ⇒ 本地这份跟着走。
  // ⚠️ 依赖里必须带 `target`：切到视频时要**重新读视频那份**，否则你会拿着图的取景去改视频。
  useEffect(() => {
    setFocus(parseBackgroundFocus(storedOf(target)) ?? FOCUS_CENTER)
  }, [target, storedOf])

  // 图片的原始尺寸（视频那份由 `<video>` 的 `onLoadedMetadata` 给）
  useEffect(() => {
    if (target !== 'image') {
      setNat(null)
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setNat({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = src
    return () => { cancelled = true }
  }, [target, src])

  useEffect(() => { setFrameReady(false) }, [target, videoSrc])

  const commit = useCallback(
    async (next: BackgroundFocus) => {
      const c = clampFocus(next)
      setFocus(c) // 乐观：先跟手，不等往返
      setBusy(true)
      try {
        const updated = target === 'video'
          ? await api.setBackgroundVideoFocus(vtuber.id, c)
          : await api.setBackgroundFocus(vtuber.id, c)
        onSaved(updated)
      } catch (e) {
        toast.error(`保存取景失败：${(e as Error).message}`)
        // 回滚到库里那份（`vtuber` 还是旧的 ⇒ 这正是"上一版"）
        setFocus(parseBackgroundFocus(storedOf(target)) ?? FOCUS_CENTER)
      } finally {
        setBusy(false)
      }
    },
    [target, vtuber.id, storedOf, onSaved],
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
    // ⚠️ 媒体原始尺寸**量不到**时按"正好铺满"算（`videoWidth` 在元数据之前是 0、图也可能还没 load 完）：
    //    0 会让 `imgW` 变 0 ⇒ 分母退化成框宽 ⇒ 拖拽方向**反了**，而且是静默的。
    const natW = nat && nat.w > 0 ? nat.w : w
    const natH = nat && nat.h > 0 ? nat.h : h
    dragRef.current = {
      px: e.clientX, py: e.clientY, w, h,
      imgW: natW * k,
      imgH: natH * k,
      base, armed: false, last: base,
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

  /** 方向键：与拖拽**同一个模型**（箭头推的是**画面**）—— `aria-label` 里写明了。 */
  const nudge = (dx: number, dy: number) => {
    const base = clampFocus(focus)
    scheduleCommit({ scale: base.scale, x: base.x - dx, y: base.y - dy })
  }

  const reset = async () => {
    setFocus(FOCUS_CENTER)
    try {
      const updated = target === 'video'
        ? await api.clearBackgroundVideoFocus(vtuber.id)
        : await api.clearBackgroundFocus(vtuber.id)
      onSaved(updated)
      onPill?.(target === 'video' ? '已重置视频取景' : '已重置取景')
    } catch (e) {
      toast.error(`重置取景失败：${(e as Error).message}`)
      setFocus(parseBackgroundFocus(storedOf(target)) ?? FOCUS_CENTER)
    }
  }

  const zoomed = focus.scale > FOCUS_MIN_SCALE
  const storedActive = storedOf(target)
  /** 没在调的那一份按**库里的值**画（切过去之前它不该跟着本地这份动）。 */
  const idleImageStyle = focusStyle(
    target === 'image' ? focus : (parseBackgroundFocus(vtuber.background_focus) ?? null),
  )
  const videoStyle = focusObjectStyle(
    target === 'video' ? focus : (parseBackgroundFocus(vtuber.background_video_focus) ?? null),
  )

  return (
    <div
      ref={boxRef}
      className="vd-bg-preview is-fit"
      data-testid="focus-box"
      role="group"
      tabIndex={0}
      aria-label={
        target === 'video'
          ? '背景视频取景：拖动平移、滚轮缩放（方向键微调）'
          : '背景图取景：拖动平移、滚轮缩放（方向键微调）'
      }
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
      {/* 图始终垫在下面（它就是视频的 poster 与降级兜底，与真实图层同构） */}
      <div
        className="vd-bg-focus"
        data-testid="focus-img"
        style={{ backgroundImage: `url(${src})`, ...idleImageStyle }}
      />
      {/* ★ 调视频时预览用**视频首帧**：`#t=` 让浏览器停在第一帧、**不 autoplay**；
          `loadeddata` 之前不显示（先看图），与真实投放的 `data-ready` 同一个思路。
          ⚠️ 调图片时**整个收起** —— 真实投放里视频盖住图，不收起来就没法看你在调什么。 */}
      {target === 'video' && videoSrc && (
        <video
          className="vd-bg-focus vd-bg-video"
          data-testid="focus-video"
          data-ready={frameReady ? '1' : '0'}
          src={`${videoSrc}#t=${FIRST_FRAME_T}`}
          style={videoStyle}
          preload="auto"
          muted
          playsInline
          onLoadedMetadata={(e) => {
            const el = e.currentTarget
            setNat({ w: el.videoWidth, h: el.videoHeight })
          }}
          onLoadedData={(e) => {
            // 兜底：某些内核不会因为 `#t=` 就停住，显式对齐一次并确保是暂停的
            const el = e.currentTarget
            try { el.currentTime = FIRST_FRAME_T } catch { /* 内核不给设就算了 */ }
            el.pause()
            setFrameReady(true)
          }}
          onError={() => setFrameReady(false)}
        />
      )}
      {/* 左上角：切换"现在调的是谁"（只有两样都有才需要切） */}
      {hasVideo && (
        <Button
          variant="outline"
          size="sm"
          className="vd-focus-switch"
          title={target === 'image' ? '现在调的是**图片**取景，点它改调视频' : '现在调的是**视频**取景，点它改调图片'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setTarget((t) => (t === 'image' ? 'video' : 'image'))}
        >
          {target === 'image' ? <ImageIcon className="size-4" /> : <Film className="size-4" />}
          {target === 'image' ? '图片取景' : '视频取景'}
        </Button>
      )}
      {/* 右上角：重置（调的是当前那一份） */}
      <Button
        variant="outline"
        size="sm"
        className="vd-focus-reset"
        title={target === 'video' ? '重置视频取景' : '重置取景'}
        aria-label={target === 'video' ? '重置视频取景' : '重置取景'}
        disabled={!storedActive || busy}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void reset()}
      >
        <RotateCcw className="size-4" />
      </Button>
      {/* 读数不是滑杆：只在真放大时露出来 */}
      {zoomed && <span className="vd-focus-zoom">{Math.round(focus.scale * 100)}%</span>}
      {/* 抓手光标只有鼠标用户看得见 ⇒ 没取景时给一句引导 */}
      {!storedActive && (
        <span className="vd-focus-hint">拖动平移 · 滚轮缩放 · 方向键微调</span>
      )}
    </div>
  )
}
