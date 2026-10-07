/**
 * 右栏背景层（图片）—— **双层交叉淡入**，换 V/换背景图时不出现白闪。
 *
 * ## 为什么不能是"单层 + `key=src`"（2026-10-06 用户实测，devlog/378）
 *
 * 原先的做法是给背景层挂 `key={backdropSrc}`，让 React 在换图时**卸载旧层、挂载新层**，
 * 新层再从 `opacity: 0` 淡入（CSS `animation: backdrop-in`）。于是换的那一瞬间：
 * 旧层已经没了、新层还是全透明 —— 底下只剩面板底色（浅色）⇒ 用户看到的是一次**闪白**
 * （"从 100% 到 0 再到 100%"）。
 *
 * 现在：**旧层留在原地、新层先垫在它下面**，等新图真的加载完再让旧层淡出。
 * 任何时刻至少有一层是不透明的，所以中间不可能露出底色：
 *
 * ```
 *  ┌ 旧层（z-index 1，正在淡出）┐
 *  │ 新层（z-index 0，已就位）  │  ← 交叉的那 250ms 里两层同时在，颜色互补
 *  └────────────────────────────┘
 * ```
 *
 * 三条口径：
 * 1. **新图先预加载**：`new Image()` 的 `onload` 之后才交换 —— 否则网图慢的时候你会看到
 *    一段"旧图已淡出、新图还没来"的空白（那是同一类白闪，只是成因不同）；
 * 2. **预加载失败就什么都不做**：保持当前这层（宁可显示旧图，也不要闪一下白）；
 * 3. **首帧不做动画**：开机/换 V 时面板本来就没有背景可交叉，直接从全不透明开始渲染
 *    （`data-backdrop="first"`）。
 */
import { useEffect, useRef, useState } from 'react'

import { focusTransform, type BackgroundFocus } from '../../utils/backgroundFocus'

/** 交叉淡出的时长（ms）—— 与 `posts.css` 的 `backdrop-out` 关键帧保持一致（有用例钉着）。 */
export const BACKDROP_FADE_MS = 250

interface Layer {
  src: string
  /** 正在淡出的那一层（渲染在上、`z-index` 更大） */
  out: boolean
  /** 面板上的第一层：不做淡入动画，直接全不透明 */
  first: boolean
  /** 这一层**自己的**取景（生成那一刻的值；见渲染处那段注释） */
  focus: BackgroundFocus | null
}

export function BackdropCrossfade({ src, custom, focus }: {
  src: string | null; custom: boolean; focus?: BackgroundFocus | null
}) {
  const [layers, setLayers] = useState<Layer[]>(
    () => (src ? [{ src, out: false, first: true, focus: null }] : []))
  /** 淡出层的清理计时器（按 src 记，避免快速连点时互相清掉）。 */
  const timers = useRef(new Map<string, number>())
  /** 生成新层时要快照一份当前取景 —— 从 `focus` 直接读会把它写进 effect 依赖，触发多余的重跑。 */
  const focusRef = useRef<BackgroundFocus | null>(focus ?? null)
  focusRef.current = focus ?? null
  /** 当前层的取景（归一成 `| null`，好和 `Layer.focus` 对上）。 */
  const nowFocus: BackgroundFocus | null = focus ?? null

  useEffect(() => {
    if (!src) return
    const cur = layers.find((l) => !l.out)
    if (cur?.src === src) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      setLayers((prev) => {
        const alive = prev.filter((l) => !l.out)
        // 新层在下（out=false）、旧层在上（out=true）；没有旧层时它就是第一层
        return src === alive[0]?.src && prev.length === 1 && !prev[0].out
          ? prev
          : [...alive.map((l) => ({ ...l, out: true })),
             { src, out: false, first: alive.length === 0, focus: focusRef.current }]
      })
      // 旧层淡完就把它摘掉（不摘会一直压在新层上面，虽然它已经全透明）
      const t = window.setTimeout(() => {
        setLayers((prev) => prev.filter((l) => !l.out))
        timers.current.delete(src)
      }, BACKDROP_FADE_MS)
      timers.current.set(src, t)
    }
    // 失败：保持现状（**不要**提前把旧层换掉，那会露出底色）
    img.src = src
    return () => { cancelled = true }
    // 依赖 `layers` 是有意的：交换之后要能继续响应下一次切换
  }, [src, layers])

  useEffect(() => () => {
    for (const t of timers.current.values()) window.clearTimeout(t)
    timers.current.clear()
  }, [])

  return (
    <>
      {layers.map((l) => (
        <div
          key={l.src}
          data-backdrop={l.out ? 'prev' : l.first ? 'first' : 'cur'}
          className={`hero-backdrop${custom ? ' custom' : ''}${l.out ? ' is-prev' : ''}`}
          /* 取景（需求 7）：⚠️ **正在淡出的那一层跟自己的图走** —— 若让它读实时的 `focus`，
             换 V 的那 250ms 里旧图会被按新 V 的取景变换一次（看着像旧图跳了一下）。
             当前层则读实时值 ⇒ 在设置里调取景时**右边背景当场跟着动**（不用重开）。 */
          style={{
            backgroundImage: `url(${l.src})`,
            transform: focusTransform(l.out ? l.focus : nowFocus),
          }}
        />
      ))}
    </>
  )
}
