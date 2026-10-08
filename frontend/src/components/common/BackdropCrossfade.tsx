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

import { EVENTS, on } from '../../utils/appEvents'
import { focusObjectStyle, focusStyle, type BackgroundFocus } from '../../utils/backgroundFocus'

/** 交叉淡出的时长（ms）—— 与 `posts.css` 的 `backdrop-out` 关键帧保持一致（有用例钉着）。 */
export const BACKDROP_FADE_MS = 250

/**
 * "播放器现在在播吗"的**粘性**记忆（模块级）。
 *
 * 为什么需要它：交叉淡入会**新挂**一个 `<video>`（新层），而新元素默认自己起播 ——
 * 若此刻播放器正在播，那一段背景就又抢上解码了。事件是"变化时通知"，
 * 新挂的元素错过了那一次通知 ⇒ 这里记一份最近值，挂载时先按它对齐一次。
 *
 * ⚠️ **它由订阅回调写入**，所以覆盖面是"当时还挂着一个背景视频"的那些时刻 ——
 *    换层/换 V 正是如此（旧层的视频还在）✓。
 *    不覆盖的一条：**播放器已经在播时，用户新传一段视频**（那一刻没有任何监听方，
 *    这个值还是旧的）⇒ 新视频会自己播起来，直到播放器下一次 play/pause 变化才让位。
 *    真要补，就得把它挪成一个独立的小 store（播放器写、背景读）—— 那时再说。
 */
let lastPlayerPlaying = false

interface Layer {
  src: string
  /** 正在淡出的那一层（渲染在上、`z-index` 更大） */
  out: boolean
  /** 面板上的第一层：不做淡入动画，直接全不透明 */
  first: boolean
  /** 这一层**自己的**取景（生成那一刻的值；见渲染处那段注释） */
  focus: BackgroundFocus | null
  /** 这一层**自己的**背景视频（同上：换 V 时旧层不该被换成新 V 的视频） */
  videoSrc: string | null
  /** 这一层**自己的**视频取景（需求 9 补丁：两份取景分开存，`devlog/426`） */
  videoFocus: BackgroundFocus | null
  /**
   * 这一层**自己的**"是不是自定义背景"（2026-10-08，`devlog/448`）。
   *
   * ⚠️ 它决定 `--backdrop-opacity`（自定义 1 / 头像铺底 0.18），而淡出关键帧
   * `backdrop-out` 的 `from` 读的正是这个变量 ⇒ 旧层必须留着**自己**那份：
   * 否则"自定义背景的 V → 头像铺底的 V"会在换的那一瞬间把旧层从 1 打到 0.18
   * （用户看到的是一次明暗闪动，业界俗称"先跳到 0.18 再淡出"）；
   * 反方向（0.18 → 1）则是一次**变亮**的闪。同一个坑 `focus` 与视频各自踩过一遍。
   */
  custom: boolean
}

/**
 * 背景**视频**层（需求 9，`devlog/424`）。
 *
 * 三条口径：
 * 1. **图是 poster 与降级兜底**：视频就盖在同层那张图上面，加载完（`canplay`）之前
 *    `data-ready="0"` ⇒ CSS 让它 `opacity: 0`，于是观众先看到图、再平滑换成视频，
 *    不会闪一帧黑；
 * 2. **播不了就退回图片**：`onError` ⇒ 这一层不再渲染视频（图还在，面板照样有背景）——
 *    收下"存得进、播不了"的文件也不至于变成一块黑；
 * 3. **取景同样生效**，但走的是 `object-position` 那一套（`focusObjectStyle`）：
 *    `<video>` 没有背景图，`background-position` 对它**毫无作用**；
 * 4. **播放器一播就让位**（需求 9，`devlog/425`）：同一个 GPU 不该同时解两路视频 ——
 *    收到 `playerPlaying` 就 `pause()`，播放器停了再 `play()` 回来
 *    （⚠️ 恢复播放要吞掉 rejection：自动播放策略可能拒它，拒了就保持暂停，不该报错）。
 */
function BackdropVideo({ src, focus }: { src: string; focus: BackgroundFocus | null }) {
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const elRef = useRef<HTMLVideoElement | null>(null)
  // 换片（同一个挂载点换了 src）时重置状态，否则上一段的 ready 会漏到新片上
  useEffect(() => {
    setReady(false)
    setFailed(false)
  }, [src])
  useEffect(() => {
    const obey = (playing: boolean) => {
      const el = elRef.current
      if (!el) return
      if (playing) el.pause()
      // ⚠️ `?.` 是给 jsdom 的桩留的（`test/setup.ts` 里 `play()` 的返回值不保证是 Promise）
      else void el.play()?.catch(() => { /* 被自动播放策略拒 ⇒ 保持暂停即可 */ })
    }
    obey(lastPlayerPlaying)      // 挂载时先按"最近一次"对齐（新挂的元素错过了那一次事件）
    return on(EVENTS.playerPlaying, ({ playing }) => {
      lastPlayerPlaying = playing
      obey(playing)
    })
  }, [])
  if (failed) return null
  return (
    <video
      ref={elRef}
      className="hero-backdrop-video"
      data-ready={ready ? '1' : '0'}
      src={src}
      style={focusObjectStyle(focus)}
      autoPlay
      muted
      loop
      playsInline
      onCanPlay={() => setReady(true)}
      onError={() => setFailed(true)}
    />
  )
}

export function BackdropCrossfade({ src, custom, focus, videoSrc, videoFocus }: {
  src: string | null; custom: boolean; focus?: BackgroundFocus | null; videoSrc?: string | null
  /** **视频**的取景（与 `focus` 是两份，见 `devlog/426`）；省略 = 跟图片那份无关 */
  videoFocus?: BackgroundFocus | null
}) {
  const [layers, setLayers] = useState<Layer[]>(
    // ⚠️ **首层也要快照取景与视频**（V1b-3 抓到：这里原先是写死的 `null`，于是"页面加载后的第一次换 V"
    //    会让正在淡出的那层退回居中，图在三帧里跳一下）。后面新建的层用 ref（见下）。
    () => (src
      ? [{ src, out: false, first: true, focus: focus ?? null, videoSrc: videoSrc ?? null,
           videoFocus: videoFocus ?? null, custom }]
      : []))
  /** 淡出层的清理计时器（按 src 记，避免快速连点时互相清掉）。 */
  const timers = useRef(new Map<string, number>())
  /** 生成新层时要快照一份当前取景 —— 从 `focus` 直接读会把它写进 effect 依赖，触发多余的重跑。 */
  const focusRef = useRef<BackgroundFocus | null>(focus ?? null)
  focusRef.current = focus ?? null
  /** 视频同上：新层拿"这一刻"的视频地址，旧层继续放自己那一段。 */
  const videoRef = useRef<string | null>(videoSrc ?? null)
  videoRef.current = videoSrc ?? null
  /** 视频的取景同上（两份取景各自快照 —— 记住"旧层放自己那一段"这条对取景同样成立）。 */
  const videoFocusRef = useRef<BackgroundFocus | null>(videoFocus ?? null)
  videoFocusRef.current = videoFocus ?? null
  /** "是不是自定义背景"同上（决定不透明度 ⇒ 旧层必须留自己那份，见 `Layer.custom`）。 */
  const customRef = useRef(custom)
  customRef.current = custom
  /** 当前层的取景（归一成 `| null`，好和 `Layer.focus` 对上）。 */
  const nowFocus: BackgroundFocus | null = focus ?? null
  const nowVideo: string | null = videoSrc ?? null
  const nowVideoFocus: BackgroundFocus | null = videoFocus ?? null

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
             { src, out: false, first: alive.length === 0, focus: focusRef.current,
               videoSrc: videoRef.current, videoFocus: videoFocusRef.current,
               custom: customRef.current }]
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
      {layers.map((l) => {
        const f = l.out ? l.focus : nowFocus
        const v = l.out ? l.videoSrc : nowVideo
        const vf = l.out ? l.videoFocus : nowVideoFocus
        // ⚠️ 同样：**正在淡出的那一层跟自己的 `custom`**（它决定 `--backdrop-opacity`，
        //    而淡出关键帧的起点读的就是它）。读实时值 ⇒ 换 V 的那一下旧层会"跳"到另一个
        //    不透明度再淡出 —— 用户看到的就是一次明暗闪动（`devlog/448`）。
        const c = l.out ? l.custom : custom
        return (
          <div
            key={l.src}
            data-backdrop={l.out ? 'prev' : l.first ? 'first' : 'cur'}
            className={`hero-backdrop${c ? ' custom' : ''}${l.out ? ' is-prev' : ''}`}
          >
            {/* 背景**图**：取景（需求 7）挂**这一层**，不挂外层 —— ⚠️ `transform: scale()`
                会连**子元素一起放大**，而视频就是子元素（2026-10-07 用户报"调图的缩放把视频
                一起放大了"，`devlog/428`）。图在外层、视频在里层时两者才真正互不相干：
                `background-position` 只动背景图，`transform` 却会带走整棵子树 —— 当初就漏了这一条。
                ⚠️ 正在淡出的那一层**跟自己的图走**：读实时的 `focus` 会让旧图被按新 V 的取景
                变换一次（看着像旧图跳了一下）；当前层读实时值 ⇒ 调取景时右边**当场跟着动**。
                ⚠️ 三件套必须整组来自 `focusStyle`（位置 + 缩放 + 与位置同源的支点）。 */}
            <div
              className="hero-backdrop-img"
              data-testid="backdrop-img"
              style={{ backgroundImage: `url(${l.src})`, ...focusStyle(f) }}
            />
            {/* 背景视频（需求 9）：与图**并列**（不是嵌在图里），自己那份取景走 `object-position`。
                ⚠️ 与取景同理 —— 旧层放**自己**那一段，不许被新 V 的视频换掉。 */}
            {v && <BackdropVideo src={v} focus={vf} />}
          </div>
        )
      })}
    </>
  )
}
