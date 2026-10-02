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
  ExternalLink, Maximize, Minimize, Pause, Play, PictureInPicture2, Volume2, VolumeX,
} from 'lucide-react'

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
}

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function VideoPlayer({ video, poster, permalink }: Props) {
  const prefs = useSyncExternalStore(subscribePlayerPrefs, playerPrefs)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const [idx, setIdx] = useState(0)
  const [dead, setDead] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [buf, setBuf] = useState(0)
  const [rateOpen, setRateOpen] = useState(false)
  const [fs, setFs] = useState(false)
  const [idle, setIdle] = useState(false)

  const direct = [video.url, ...(video.fallbacks ?? [])].filter(Boolean)
  const proxied = direct.map((u) => `/video-proxy?url=${encodeURIComponent(u)}`)
  const sources = [...direct, ...proxied]
  const src = sources[idx]

  // 全局偏好每次变更都下发给这个元素（音量"一个响一个轻"的根治点）
  useEffect(() => {
    const el = videoRef.current
    if (el) applyPlayerPrefs(el)
  }, [prefs, src])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    applyPlayerPrefs(el)                       // 挂载即对齐全局音量
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
  }, [src])

  // 全屏状态（Esc 退出也要同步）
  useEffect(() => {
    const onFs = () => setFs(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const toggle = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setDead(false))
    else el.pause()
  }, [])

  const seekTo = useCallback((ratio: number) => {
    const el = videoRef.current
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
    el.currentTime = Math.min(el.duration, Math.max(0, ratio * el.duration))
    setCur(el.currentTime)
  }, [])

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
    reportUserError('视频播放', `全部播放源都失败（含本机代理）：${sources[0] ?? ''}`,
                    { kind: 'resource' })
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
        poster={poster ?? undefined}
        src={src}
        onClick={toggle}
        onError={() => {
          if (idx + 1 < sources.length) setIdx(idx + 1)
          else setDead(true)
        }}
      />

      {!playing && (
        <button type="button" className="vp-bigplay" aria-label="播放" onClick={toggle}>
          <Play className="size-7" />
        </button>
      )}

      <div className="vp-bar">
        <button type="button" className="vp-btn" aria-label={playing ? '暂停' : '播放'} onClick={toggle}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <span className="vp-time">
          {fmt(cur)}<span className="vp-time-sep">/</span>{fmt(dur)}
        </span>

        <div
          className="vp-progress" role="slider" tabIndex={0}
          aria-label="播放进度" aria-valuemin={0} aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(cur)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            seekTo((e.clientX - r.left) / r.width)
          }}
        >
          <span className="vp-progress-buf" style={{ width: `${bufPct}%` }} />
          <span className="vp-progress-fill" style={{ width: `${pct}%` }} />
          <span className="vp-progress-knob" style={{ left: `${pct}%` }} />
        </div>

        <div className="vp-rate">
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

        <button type="button" className="vp-btn"
                aria-label={prefs.muted ? '取消静音' : '静音'}
                onClick={() => setPlayerPrefs({ muted: !prefs.muted })}>
          {prefs.muted || prefs.volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
        <input
          className="vp-vol" type="range" min={0} max={1} step={0.05}
          aria-label="音量" value={prefs.volume}
          onChange={(e) => setPlayerPrefs({ volume: Number(e.target.value), muted: false })}
        />
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
