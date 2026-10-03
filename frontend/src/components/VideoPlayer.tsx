/**
 * 自绘播放器（2026-10-03，devlog/283）：替换浏览器原生控件，皮肤与排版跟随项目设计语言。
 *
 * 为什么自绘：原生 `<video controls>` 的样式不可控（截图里那套是 Edge/Chromium 的），
 * 与仓库的黑玻璃 + 粉强调不是一套东西；而**全屏走容器**（`requestFullscreen()`）才能保住
 * 自绘控件（原生 video 全屏会把控件换回系统那套）。
 *
 * 口径（承接 `PostVideo` 的既有纪律）：
 * - **不自动播放**、`preload="metadata"`；
 * - **fallback 链**：直连全部 → 同一批经 `/video-proxy`（小红书 CDN 见 Referer 就 403）；
 * - 外层 `data-self-healing`：链上每一步失败都是正常一环，不惊动全局错误陷阱；
 *   真播不了才 `reportUserError` 一条；
 * - 音量/静音/**倍速全局共用**（`utils/playerPrefs`）——换视频不用重设。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Crown, ExternalLink, Loader2, Maximize, Minimize, Pause, Play, PictureInPicture2,
  Volume1, Volume2, VolumeX,
} from 'lucide-react'

import { videoProxyUrl } from '../api/api'
import { normalizeImageUrl } from '../utils/format'
import { openExternalFromHref } from '../utils/externalLinkGuard'
import { reportUserError } from '../utils/problemReport'
import {
  PLAYBACK_RATES, applyPlayerPrefs, playerPrefs, setPlayerPrefs, subscribePlayerPrefs,
} from '../utils/playerPrefs'

export interface PostVideoInfo {
  url: string
  fallbacks?: string[] | null
  width?: number | null
  height?: number | null
  duration_s?: number | null
}

interface Props {
  video: PostVideoInfo
  /** 封面（作为 poster；视频帖的封面就是首帧，所以不再单独渲染一张封面） */
  poster?: string | null
  /** 原帖链接（兜底按钮用） */
  permalink?: string | null
  /**
   * B站 DASH（devlog/290）：**音视频分离的裸 fMP4** ⇒ 双元素播放。
   *
   * 为什么不用 dash.js/MSE（原计划）而是双元素：实测 B站给的是**顺序 fMP4**
   * （`ftyp+moov+sidx+moof+mdat`，见 devlog/290），浏览器能直接播，而 dash.js 需要 MPD
   * —— B站**根本没有 manifest**，用它就得自己合成 MPD 或写 MSE。双元素零依赖、
   * 原生 `buffered/seekable` 全保住，自绘控件一行不用改。
   *
   * ⚠️ 这两条流**必须经 `/video-proxy`**：媒体 CDN 不带 Referer 就 403，浏览器设不了 Referer。
   * `videoFallbacks` / `audioFallbacks` 是后端排过序的**同档镜像**（devlog/294）：B站的 `baseUrl`
   * 常常是 P2P/mcdn 主机，备份里才有普通 CDN ⇒ 挂一条就换下一条，不用回后端重取。
   */
  dash?: {
    video: string
    videoFallbacks?: string[] | null
    audio?: string | null
    audioFallbacks?: string[] | null
  } | null
  /**
   * 清晰度菜单（B站）：`current` 是**实际拿到**的档，`disabled` 的档**如实标注原因**
   * （大会员档位拿不到就说"需大会员"，不做成"点了没反应"）。
   */
  qualities?: { id: number; label: string; disabled?: boolean; note?: string }[] | null
  qualityId?: number | null
  onPickQuality?: (id: number) => void
  /**
   * 播不动时的**外部回落**（B站：DASH → durl，由调用方重新取流）；给了它就不再显示"播不了"兜底卡
   */
  onFallback?: () => void
  /**
   * 地址就绪后**直接开始播**（2026-10-03 用户口径：「点击中央播放键后并没有开始播放，
   * 只是显示了播放器界面，改为直接开始播放」）。
   *
   * 为什么是 prop 而不是组件内自己决定：B站那条路**点播放才取流**（地址短时效），
   * 取回来是新一次挂载 ⇒ "要不要自动播"只有调用方知道（用户点了播放/换了清晰度 ⇒ 要）。
   * ⚠️ DASH 档要**两条流一起启动**：音轨被自动播放策略拒了就**把视频轨也停住**
   *   （静音画面比"没反应"更糟 —— 用户会以为没声音是坏了）。
   */
  autoPlay?: boolean
  /**
   * 正在**重新取流**（B站：换清晰度 / 播不动后的同档重取或回落）。给 true 时中央转圈，
   * 并且**暂时收起大播放键**（两者都在正中，会叠在一起）。
   *
   * 为什么转圈要画在播放器里而不是让调用方换掉整块：重新取流时旧的那条流还在元素上
   * （可能还能拖着看/听），换掉整块会把画面和进度一起丢掉。
   */
  loading?: boolean
}

/**
 * 音画漂移该做什么（纯函数，便于直接测三态）。
 *
 * 为什么需要分级（`devlog/298` 量出来的）：DASH 的两条流是**两个独立媒体管线**，
 * 而视频轨那条**没有音轨**（B站把音频分出去了）⇒ 它的时钟是"墙上时间"估的，
 * 与音轨（跟声卡时钟走）**速率略有差异**。实测 19 秒里就漂到 **0.28s**（音轨超前）。
 *
 * - `> 0.6s`：直接对齐（**会听到一次跳**，但那么大的偏差本来就是故障态）；
 * - `0.05~0.6s`：**改一点点速率慢慢追**（±3%，约 1 秒追 30ms，人耳听不出，也不会"咔"一下）；
 * - `< 0.05s`：别动，恢复用户设定的倍速。
 *
 * ⚠️ 阈值是量出来的、不是拍的：实测 19 秒漂 0.28s，而**旧实现只有"超 0.3s 就跳"**一档 ——
 * 0.28s 这种"已经能感觉出来"的量级被放过去了，而且每次修都是"跳一下"。
 */
export function driftAction(drift: number, rate: number): { snap: boolean; rate: number } {
  const abs = Math.abs(drift)
  if (abs > 0.6) return { snap: true, rate }
  if (abs > 0.05) return { snap: false, rate: rate * (drift > 0 ? 0.97 : 1.03) }
  return { snap: false, rate }
}

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function VideoPlayer({ video, poster, permalink, dash, qualities, qualityId,
                                      onPickQuality, onFallback, autoPlay, loading }: Props) {
  const prefs = useSyncExternalStore(subscribePlayerPrefs, playerPrefs)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  /** DASH 模式的独立音轨（视频元素那边静音） */
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const isDash = Boolean(dash?.video)

  const [idx, setIdx] = useState(0)
  /** DASH 音轨的镜像序号（视频轨用 `idx`，两条流各自换源 —— 一条挂了不必重来另一条） */
  const [aidx, setAidx] = useState(0)
  const [dead, setDead] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [buf, setBuf] = useState(0)
  const [rateOpen, setRateOpen] = useState(false)
  /** 清晰度菜单（B站；默认关） */
  const [qualityOpen, setQualityOpen] = useState(false)
  const [fs, setFs] = useState(false)
  const [idle, setIdle] = useState(false)
  /** 进度条 hover 预览（图二那颗时间气泡） */
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  /**
   * 控件自动隐藏（devlog/300）：**3 秒没动鼠标、且指针不在底栏上**才收起。
   *
   * 用户口径（全屏时尤其明显）：「控件隐藏逻辑应该是鼠标不在下部分控件区 hover 时隐藏，
   * 而不是现在的鼠标在下部分控件区 hover 时隐藏」。原来的实现只有两个触发点 ——
   * 移动就显示、**指针离开整个播放器**才隐藏：既没有"停手就收"（B站/YouTube 都有），
   * 也不认"指针正压在底栏上"这件事。
   *
   * `hoverBar` 用 ref 而不是 state：它只参与"要不要收起"的判断，不参与渲染，
   * 放进 state 会让每次鼠标划过底栏都重渲染一遍。
   */
  const hoverBarRef = useRef(false)
  const idleTimer = useRef(0)
  const bumpControls = useCallback(() => {
    setIdle(false)
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      if (!hoverBarRef.current) setIdle(true)
    }, 3000)
  }, [])
  useEffect(() => () => window.clearTimeout(idleTimer.current), [])

  /** 正在拖拽 seek（state 给渲染用；`draggingRef` 给事件监听用 —— 监听闭包会看到旧 state） */
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  /** 缓冲中（`waiting` → `playing`/`canplay`）：中央转圈，别看起来像"暂停了"（devlog/299） */
  const [buffering, setBuffering] = useState(false)

  // DASH 模式：**只走本机代理**（媒体 CDN 不带 Referer 403）；普通模式仍是 直连 → 代理 的链。
  // ⚠️ 代理 URL 必须用 `videoProxyUrl()`（拼 `apiBase`）—— 写成相对的 `/video-proxy?…` 会落到
  //    页面来源（dev 的 vite / 桌面的 tauri://localhost）⇒ 全都 404（devlog/294 的真机事故）。
  const dashVideoUrls: string[] = isDash
    ? [dash!.video, ...(dash!.videoFallbacks ?? [])].filter((u): u is string => Boolean(u))
    : []
  const dashAudioUrls: string[] = isDash
    ? [dash!.audio, ...(dash!.audioFallbacks ?? [])].filter((u): u is string => Boolean(u))
    : []
  const direct: string[] = isDash
    ? []
    : [video.url, ...(video.fallbacks ?? [])].filter((u): u is string => Boolean(u))
  const sources = isDash
    ? dashVideoUrls.map(videoProxyUrl)
    : [...direct, ...direct.map(videoProxyUrl)]     // 直连链走完再走同一批的代理链
  const src = sources[idx]
  const audioSrc = isDash && dashAudioUrls.length
    ? videoProxyUrl(dashAudioUrls[Math.min(aidx, dashAudioUrls.length - 1)])
    : null

  /** 全局偏好下发给**真正出声的那个元素**（DASH 模式 = 音轨；视频元素恒静音） */

  // 全局偏好每次变更都下发给元素。
  // ⚠️ DASH 档**两个元素都要发**（devlog/299）：声音在音轨上，但小窗那个静音按钮看的是
  // 视频元素的 `muted` —— 只下发一个，"小窗静音"就会和真实声音脱节。
  useEffect(() => {
    if (isDash) {
      const a = audioRef.current
      const v = videoRef.current
      if (a) applyPlayerPrefs(a)
      if (v) applyPlayerPrefs(v)
    } else {
      const v = videoRef.current
      if (v) applyPlayerPrefs(v)
    }
  }, [prefs, src, isDash])

  /**
   * DASH：音轨与视频轨的**漂移纠正**（两条独立流，浏览器不会自动对齐）。
   *
   * 实测（`devlog/298`）：19 秒漂到 **0.28s**（音轨超前）—— 视频轨那条没有音轨、时钟是墙上时间
   * 估的，与跟声卡走的音轨有约 1.5% 的速率差。原来只有"超 0.3s 就直接对齐"一档，
   * 于是 0.28s 这种"已经能感觉出来"的量级反而被放过去了；而且每次都靠"跳一下"来修。
   * 现在按 `driftAction` 分级：小漂移用**改速率慢慢追**（听不出来），大漂移才跳。
   */
  useEffect(() => {
    if (!isDash) return
    const id = window.setInterval(() => {
      const v = videoRef.current
      const a = audioRef.current
      // ⚠️ **视频轨暂停时绝对不要纠正**（devlog/299）：暂停常常来自小窗/系统媒体键
      // （不经过我们的 `toggle`）。那时音轨若还在放，漂移会立刻超过阈值 ⇒ 每秒把它拽回
      // 冻结的画面时间 ⇒ 同一小段被反复重放。暂停的事由 `pause` 监听负责（它会停音轨）。
      if (!v || !a || v.paused || a.paused || !Number.isFinite(a.currentTime)) return
      const { snap, rate } = driftAction(a.currentTime - v.currentTime, prefs.rate)
      if (snap) a.currentTime = v.currentTime
      a.playbackRate = rate
    }, 1000)
    return () => window.clearInterval(id)
  }, [isDash, prefs.rate])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const a = audioRef.current
    applyPlayerPrefs(el)                       // 挂载即对齐全局音量（含静音态，见下面 volumechange）
    if (a) applyPlayerPrefs(a)

    /**
     * 出画 ⇒ 音轨对齐并起播（幂等）。
     *
     * 幂等很重要：视频轨每次重新缓冲回来都会再发一次 `playing`，若每次都硬对齐，
     * 音轨会被反复拽一下。只在"没在播"或"已经偏了"时才动。
     *
     * ⚠️ **失败分两类**（devlog/300）：
     * · `NotAllowedError`（自动播放策略）⇒ 真的起不来，把视频轨也停住（不留静音画面）；
     * · `AbortError` / `NotSupportedError` 等**瞬时**失败（跳到一个还没缓存的位置时最常见的
     *   就是它：音轨还在 seek，`play()` 立刻被中断）⇒ **绝不能因此暂停视频轨**。
     *   真机上就是这么坏的：用户点进度条跳到很后面，音轨 `play()` 被 abort ⇒ 我们把视频轨
     *   暂停了 ⇒ 界面显示"暂停"、也没有声音，而画面对用户来说像在放/刚放完。
     *   这类交给"下一拍再对齐"（`timeupdate` 的和解逻辑）就行。
     */
    const startAudio = () => {
      const audio = audioRef.current
      if (!audio || draggingRef.current || seekRef.current.settling) return
      if (!audio.paused && Math.abs(audio.currentTime - el.currentTime) < 0.2) return
      audio.currentTime = el.currentTime
      void audio.play().catch((e: DOMException) => {
        if (e?.name === 'NotAllowedError') el.pause()
      })
    }

    const onPlay = () => { setPlaying(true); setBuffering(false) }
    /* ⚠️ 暂停要把音轨一起带走（devlog/299）：暂停可能来自**画中画小窗的按钮**、
       系统媒体键、或 `navigator.mediaSession` —— 那些都不经过我们的 `toggle()`。
       不管的话：视频轨停了、音轨还在放，而每秒一次的漂移纠正发现"音轨超前 0.6s"
       就把它拽回冻结的画面时间 ⇒ **同一小段被反复重放**（用户听到的"一小段一小段重复"）。 */
    const onPause = () => { setPlaying(false); audioRef.current?.pause() }
    const onPlaying = () => { setBuffering(false); startAudio() }
    /* 缓冲中要有转圈（用户口径：点进度条跳转后在加载，不能看起来像"暂停了"） */
    const onWaiting = () => setBuffering(true)
    const onCanPlay = () => setBuffering(false)
    const onTime = () => {
      setCur(el.currentTime)
      /**
       * **和解**（devlog/300）：`playing` 这个 React 状态、以及"音轨到底在不在放"，
       * 都必须能**从元素本身**重新推出来，而不是只信某一次事件。
       *
       * 为什么：真机上出现过"画面在放、界面显示暂停、还没有声音" —— 事件时序里只要有一次
       * `pause` 之后没有配对的 `play`（跳转到未缓存位置、`play()` 被 abort、元素换源……
       * 都可能），状态就会**永久停在错的**那一格。`timeupdate` 播放时每秒发 4 次，
       * 拿它当和解心跳，最多 250ms 就能自愈。
       */
      // `playing` 在闭包里可能已经旧了 ⇒ 用函数式更新（值没变时 React 会跳过重渲染）
      setPlaying((prev) => (prev === !el.paused ? prev : !el.paused))
      if (!el.paused) startAudio()
    }
    const onMeta = () => setDur(el.duration || 0)
    const onProg = () => {
      try {
        setBuf(el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0)
      } catch {
        setBuf(0)
      }
    }
    /**
     * 小窗（画中画）那个静音按钮改的是**视频元素**的 `muted`（devlog/299）。
     *
     * DASH 档下声音全在独立的音轨元素上，所以以前"视频轨恒 `muted = true`" ⇒ 那个按钮点了
     * 对声音毫无影响（用户报"点了不会静音"）。现在**两边都跟着全局偏好走**
     * （`video.muted = prefs.muted`，不再恒定 true），于是：
     * 小窗按钮 → 改 `video.muted` → 这里收到 `volumechange` → 回写全局偏好 → 音轨跟着静音。
     * ⚠️ 前提是 DASH 的**视频轨本身不含音轨**（B站就是这么分的）；真要含，也只是那一份被
     * `prefs.muted` 控制，不会出现"两份声音"。
     */
    const onVolumeChange = () => {
      if (el.muted !== playerPrefs().muted) setPlayerPrefs({ muted: el.muted })
    }
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('playing', onPlaying)
    el.addEventListener('waiting', onWaiting)
    el.addEventListener('canplay', onCanPlay)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('progress', onProg)
    el.addEventListener('volumechange', onVolumeChange)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('playing', onPlaying)
      el.removeEventListener('waiting', onWaiting)
      el.removeEventListener('canplay', onCanPlay)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('progress', onProg)
      el.removeEventListener('volumechange', onVolumeChange)
    }
  }, [src, isDash])

  // 全屏状态（Esc 退出也要同步）
  useEffect(() => {
    const onFs = () => setFs(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  /**
   * 真播不了才报一条（`data-self-healing` 只管中间那几步）。
   *
   * ⚠️ **必须在 effect 里报，不能在渲染里报**（devlog/294）：以前写在 `.vp-dead` 那个分支里，
   * 而渲染函数在一次失败后会跑很多遍（父组件一更新就再渲染一次）—— 真机报告里因此出现
   * **同一条 ×6**。用户看到的是"报错日志刷屏"，把真正的原因淹了。
   *
   * 依赖只放 `[dead, src, video.url]`（都是字符串/布尔）：`sources` 每次渲染都是新数组，
   * 放进依赖会让这条 effect 每渲染必跑 —— 那就又回到"刷屏"了。
   */
  useEffect(() => {
    if (dead || !src) {
      reportUserError('视频播放', `全部播放源都失败（含本机代理）：${src ?? video.url}`,
                      { kind: 'resource' })
    }
  }, [dead, src, video.url])

  /**
   * 起播（`toggle` 与 `autoPlay` 共用一份，别写两遍 —— 两处漂移就会出现"点了能响、自动播不响"）。
   *
   * ## 音轨要**等视频轨出画**才起（devlog/298）
   *
   * 用户口径：「第一次点击播放的时候音轨会提前一点然后同步，导致开头一小段重复一点」。
   * 机理：两条流是**两个独立媒体管线** —— 音轨几乎瞬间就能出声，而视频轨要先缓冲出第一帧；
   * 两条一起 `play()` 时，声音先跑出去几十毫秒到一秒，等漂移纠正把它拽回来，
   * 那一小段就被**听了两遍**。
   *
   * 所以这里只负责"把视频轨点着"：**音轨的起播在对 `playing` 的监听里**
   * （`startAudio`，`devlog/298/299`）—— 暂停/续播也走同一套，避免两处各写一遍。
   */
  const startPlayback = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    void el.play().catch(() => { /* 自动播放策略拒绝：保持暂停，让用户再点一下 */ })
  }, [])

  const toggle = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) startPlayback()
    else {
      el.pause()
      audioRef.current?.pause()
    }
  }, [startPlayback])

  // 地址就绪 ⇒ 直接起播（用户点过播放/换过清晰度；见 `autoPlay` 的说明）
  useEffect(() => {
    if (autoPlay) startPlayback()
  }, [autoPlay, src, startPlayback])

  /**
   * 一次 seek 的收尾状态。
   *
   * 为什么需要它（2026-10-03 用户口径：「点进度条跳转时音轨先跳完、视频轨才跟上，卡一下才同步，
   * 声音和画面会错位」）：**视频轨 seek 比音轨慢** —— 它要回到关键帧并重新缓冲，而音轨几乎瞬时。
   * 原来的实现是"两条都直接写 `currentTime`"，于是音轨先到位、视频轨还在原地 ⇒ 那一段时间里
   * 听到的是新位置的声音、看到的是旧位置的画面（要等 2s 一次的漂移纠正才拉回来）。
   *
   * 现在的口径：**seek 时先把音轨闭上嘴**（`pause`），等视频轨 `seeked`（真的到位）再对齐并复播。
   */
  const seekRef = useRef({ settling: false, wasPlaying: false })

  /** 收尾：视频轨到位后把音轨对齐（必要时复播）。**幂等**，并带兜底定时器（见下）。 */
  const settleAudio = useCallback(() => {
    const el = videoRef.current
    const a = audioRef.current
    if (!el || !a) return
    let done = false
    let timer = 0
    const apply = () => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      a.currentTime = el.currentTime
      if (seekRef.current.wasPlaying) void a.play().catch(() => { /* 策略拒绝：保持暂停 */ })
      seekRef.current.settling = false
    }
    if (el.seeking) {
      el.addEventListener('seeked', apply, { once: true })
      // ⚠️ 兜底：万一 `seeked` 没来（同一个位置重跳、或浏览器吞了事件），别让音轨**永远哑着**
      timer = window.setTimeout(apply, 1500)
    } else {
      apply()
    }
  }, [])

  /**
   * 定位。`live=true` = 拖拽中（位置还会变）⇒ **不安排对齐**，音轨保持静默，
   * 等 `pointerup` 一次性对齐（否则每一帧都去重设一次音轨，反而更抖）。
   */
  const seekTo = useCallback((ratio: number, live = false) => {
    const el = videoRef.current
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
    const a = audioRef.current
    if (a && !seekRef.current.settling) {          // 进入一次 seek：先让音轨停下
      seekRef.current.settling = true
      seekRef.current.wasPlaying = !el.paused
      a.pause()
    }
    el.currentTime = Math.min(el.duration, Math.max(0, ratio * el.duration))
    setCur(el.currentTime)
    if (!live) settleAudio()
  }, [settleAudio])

  const toggleFs = useCallback(() => {
    const node = wrapRef.current
    if (!node) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void node.requestFullscreen?.().catch(() => { /* 宿主不允许就静默 */ })
  }, [])

  const togglePip = useCallback(() => {
    const el = videoRef.current as (HTMLVideoElement & {
      requestPictureInPicture?: () => Promise<unknown>
    }) | null
    if (!el?.requestPictureInPicture) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture()
    else void el.requestPictureInPicture().catch(() => { /* 同上 */ })
  }, [])

  // 快捷键：只在控件区域内接管（不抢抽屉的 Esc / 滚动）
  const onKey = (e: React.KeyboardEvent) => {
    const el = videoRef.current
    if (!el) return
    const k = e.key.toLowerCase()
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); el.currentTime = Math.max(0, el.currentTime - 5) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); el.currentTime = Math.min(el.duration || 0, el.currentTime + 5) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPlayerPrefs({ volume: prefs.volume + 0.05, muted: false }) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setPlayerPrefs({ volume: prefs.volume - 0.05 }) }
    else if (k === 'm') { e.preventDefault(); setPlayerPrefs({ muted: !prefs.muted }) }
    else if (k === 'f') { e.preventDefault(); toggleFs() }
  }

  if (dead || !src) {
    return (
      <div className="vp-dead">
        <span>这个视频在当前环境里播不了</span>
        {permalink && (
          <button type="button" className="vp-btn vp-btn--accent"
                  onClick={() => void openExternalFromHref(permalink)}>
            <ExternalLink className="size-3.5" /> 在浏览器打开
          </button>
        )}
      </div>
    )
  }

  const pipOk = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document
  /** 喇叭图标分档（图三）：静音 / 低（<50%）/ 高 —— 静音与"音量为 0"合并成一档显示 */
  const volLevel: 'mute' | 'low' | 'high' =
    prefs.muted || prefs.volume === 0 ? 'mute' : prefs.volume < 0.5 ? 'low' : 'high'
  const pct = dur > 0 ? (cur / dur) * 100 : 0
  const bufPct = dur > 0 ? (buf / dur) * 100 : 0

  return (
    /** `data-self-healing`：见文件头注释（中间失败由本组件自己消化） */
    <div
      ref={wrapRef}
      className={`vp${idle && playing ? ' is-idle' : ''}`}
      data-self-healing="1"
      data-vp-state={playing ? 'playing' : 'paused'}
      tabIndex={0}
      onKeyDown={onKey}
      onMouseMove={bumpControls}
      /* 指针离开播放器：**立刻收起**（用户就是想让它让开），但压在底栏时不算离开 */
      onMouseLeave={() => { if (!hoverBarRef.current) setIdle(true) }}
    >
      <video
        ref={videoRef}
        className="vp-video"
        playsInline
        preload="metadata"
        muted={isDash}
        poster={poster ? normalizeImageUrl(poster) : undefined}
        src={src}
        onClick={toggle}
        onError={() => {
          if (idx + 1 < sources.length) setIdx(idx + 1)   // 同档的下一面镜像（devlog/294）
          else if (onFallback) onFallback()               // 交给调用方换内核（DASH → durl）
          else setDead(true)
        }}
      />
      {/* DASH 的独立音轨（隐藏元素；音量/静音/倍速都作用在它身上） */}
      {isDash && audioSrc && (
        <audio
          ref={audioRef}
          data-vp-audio="1"
          src={audioSrc}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => {
            const v = videoRef.current
            const a = audioRef.current
            if (v && a) setCur(v.currentTime)
          }}
          onError={() => {
            // 音轨自己也有镜像链：换下一条；全试完才报一条（**别一条流失败刷一串报告**）
            if (aidx + 1 < dashAudioUrls.length) { setAidx(aidx + 1); return }
            reportUserError('视频音轨', `音轨全部镜像都失败（本机代理）：${dashAudioUrls[0] ?? ''}`,
                            { kind: 'resource' })
          }}
        />
      )}

      {!playing && !loading && !buffering && (
        <button type="button" className="vp-bigplay" aria-label="播放" onClick={toggle}>
          <Play className="size-7" />
        </button>
      )}

      {/* 取流中（`loading`）/ 缓冲中（`buffering`）：中央转圈。
          ⚠️ 缓冲也要转（devlog/299）：点进度条跳转后视频轨要重新缓冲，画面是冻住的 ——
          不给转圈，用户会以为"点了跳转结果暂停了"。 */}
      {(loading || buffering) && (
        <div className="vp-spin" role="status" aria-label="正在缓冲">
          <Loader2 className="vp-spin-icon" aria-hidden="true" />
        </div>
      )}

      {/* 底栏：指针压在上面时**永不收起**（用户口径的另一半），离开后重新开始计时 */}
      <div
        className="vp-bar"
        onMouseEnter={() => { hoverBarRef.current = true; setIdle(false); window.clearTimeout(idleTimer.current) }}
        onMouseLeave={() => { hoverBarRef.current = false; bumpControls() }}
      >
        <button type="button" className="vp-btn" aria-label={playing ? '暂停' : '播放'} onClick={toggle}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <span className="vp-time">
          {fmt(cur)}<span className="vp-time-sep">/</span>{fmt(dur)}
        </span>

        <div
          className={`vp-progress${dragging ? ' is-dragging' : ''}`} role="slider" tabIndex={0}
          aria-label="播放进度" aria-valuemin={0} aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(cur)}
          onClick={(e) => {
            // 纯点击（没有指针事件的环境也要能用）：一次到位的 seek ⇒ 直接收尾对齐
            const r = e.currentTarget.getBoundingClientRect()
            seekTo((e.clientX - r.left) / r.width)
          }}
          onPointerDown={(e) => {
            // 拖拽 seek（devlog/286）：按下即定位 + 捕获指针，拖动中持续跟随
            e.preventDefault()
            e.currentTarget.setPointerCapture?.(e.pointerId)
            const r = e.currentTarget.getBoundingClientRect()
            setDragging(true)
            draggingRef.current = true
            seekTo((e.clientX - r.left) / r.width, true)   // live：音轨先静默，等抬手再对齐
          }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
            // hover 预览：光标位置对应的时间（图二那颗 `00:12` 气泡）
            setHover({ x: ratio * r.width, t: ratio * (dur || 0) })
            if (dragging) seekTo(ratio, true)      // 拖拽中：视频轨实时跟随，音轨仍静默
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture?.(e.pointerId)
            setDragging(false)
            draggingRef.current = false
            settleAudio()                          // 抬手 ⇒ 等视频轨到位后对齐音轨并复播
          }}
          onPointerCancel={() => {
            setDragging(false)
            draggingRef.current = false
            settleAudio()
          }}
          onMouseLeave={() => setHover(null)}
        >
          <span className="vp-progress-buf" style={{ width: `${bufPct}%` }} />
          <span className="vp-progress-fill" style={{ width: `${pct}%` }} />
          <span className="vp-progress-knob" style={{ left: `${pct}%` }} />
          {hover && dur > 0 && (
            <span className="vp-progress-tip" style={{ left: `${hover.x}px` }}>{fmt(hover.t)}</span>
          )}
        </div>

        <div className="vp-rate">
          {qualities && qualities.length > 0 && (
            <div className="vp-rate">
              <button type="button" className="vp-btn vp-btn--text"
                      aria-label="清晰度" onClick={() => setQualityOpen((v) => !v)}>
                {qualities.find((q) => q.id === qualityId)?.label ?? '清晰度'}
              </button>
              {qualityOpen && (
                <div className="vp-menu vp-menu--quality">
                  {qualities.map((q) => (
                    <button key={q.id} type="button" disabled={q.disabled}
                            title={q.note}
                            /* 档位名（含"高清 1080P"里那个空格）**不许换行**（用户 2026-10-03）：
                               一换行菜单就变成窄高条，"1×"也会被挤下去 */
                            aria-label={q.note ? `${q.label}（${q.note}，不可选）` : q.label}
                            className={`vp-menu-item${q.id === qualityId ? ' is-on' : ''}`}
                            onClick={() => { onPickQuality?.(q.id); setQualityOpen(false) }}>
                      {q.label}
                      {/* 「需大会员」用**一颗小图标**表示（文字太占宽、又把行撑换行了）；
                          无障碍名走 `title` + `aria-label`，信息不丢 */}
                      {q.note && (
                        <Crown className="vp-crown" aria-hidden="true" data-vp-note={q.note} />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button type="button" className="vp-btn vp-btn--text"
                  aria-label="倍速" onClick={() => setRateOpen((v) => !v)}>
            {prefs.rate}×
          </button>
          {rateOpen && (
            <div className="vp-menu">
              {PLAYBACK_RATES.map((r) => (
                <button key={r} type="button"
                        className={`vp-menu-item${r === prefs.rate ? ' is-on' : ''}`}
                        onClick={() => { setPlayerPrefs({ rate: r }); setRateOpen(false) }}>
                  {r}×
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="vp-volwrap">
          <button type="button" className="vp-btn" data-vol-level={volLevel}
                  aria-label={prefs.muted ? '取消静音' : '静音'}
                  onClick={() => setPlayerPrefs({ muted: !prefs.muted })}>
            {volLevel === 'mute' ? <VolumeX className="size-4" />
              : volLevel === 'low' ? <Volume1 className="size-4" />
                : <Volume2 className="size-4" />}
          </button>
          {/* 音量条改成 **hover/focus 浮窗**（图三）：默认不占底栏宽度，竖直滑杆 */}
          <div className="vp-volpop">
            <input
              className="vp-vol" type="range" min={0} max={1} step={0.05}
              aria-label="音量" value={prefs.volume}
              onChange={(e) => setPlayerPrefs({ volume: Number(e.target.value), muted: false })}
            />
          </div>
        </div>
        {pipOk && (
          <button type="button" className="vp-btn" aria-label="画中画" onClick={togglePip}>
            <PictureInPicture2 className="size-4" />
          </button>
        )}
        <button type="button" className="vp-btn" aria-label={fs ? '退出全屏' : '全屏'} onClick={toggleFs}>
          {fs ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
        </button>
      </div>
    </div>
  )
}
