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
  /** 正在拖拽 seek（拖动中圆点常显，见 CSS `.is-dragging`） */
  const [dragging, setDragging] = useState(false)

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

  // 全局偏好每次变更都下发给元素（音量"一个响一个轻"的根治点）
  useEffect(() => {
    const el = isDash ? audioRef.current : videoRef.current
    if (el) applyPlayerPrefs(el)
  }, [prefs, src, isDash])

  /** DASH：音轨与视频轨的**漂移纠正**（两条独立流，浏览器不会自动对齐） */
  useEffect(() => {
    if (!isDash) return
    const id = window.setInterval(() => {
      const v = videoRef.current
      const a = audioRef.current
      if (!v || !a || a.paused || !Number.isFinite(a.currentTime)) return
      if (Math.abs(a.currentTime - v.currentTime) > 0.3) a.currentTime = v.currentTime
    }, 2000)
    return () => window.clearInterval(id)
  }, [isDash])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    applyPlayerPrefs(el)                       // 挂载即对齐全局音量
    if (isDash) el.muted = true                // 视频轨恒静音：声音由音轨出（否则双份声音）
    const a = audioRef.current
    if (a) applyPlayerPrefs(a)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTime = () => setCur(el.currentTime)
    const onMeta = () => setDur(el.duration || 0)
    const onProg = () => {
      try {
        setBuf(el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0)
      } catch {
        setBuf(0)
      }
    }
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('progress', onProg)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('progress', onProg)
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
   * DASH 档的两条流必须**成对**：音轨被自动播放策略拒绝时把视频轨也停住
   * （静音画面比"没反应"更糟：用户会当成坏了）。
   */
  const startPlayback = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    const a = audioRef.current
    void el.play().catch(() => { /* 自动播放策略拒绝：保持暂停，让用户再点一下 */ })
    if (a) {
      a.currentTime = el.currentTime
      void a.play().catch(() => { el.pause() })
    }
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
      onMouseMove={() => setIdle(false)}
      onMouseLeave={() => setIdle(true)}
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

      {!playing && !loading && (
        <button type="button" className="vp-bigplay" aria-label="播放" onClick={toggle}>
          <Play className="size-7" />
        </button>
      )}

      {/* 重新取流中：中央转圈（与大播放键互斥 —— 同一格位置） */}
      {loading && (
        <div className="vp-spin" role="status" aria-label="正在取流">
          <Loader2 className="vp-spin-icon" aria-hidden="true" />
        </div>
      )}

      <div className="vp-bar">
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
            settleAudio()                          // 抬手 ⇒ 等视频轨到位后对齐音轨并复播
          }}
          onPointerCancel={() => { setDragging(false); settleAudio() }}
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
