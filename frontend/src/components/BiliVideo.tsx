/**
 * B站视频块（2026-10-03，devlog/290）：**按需取流** + 清晰度菜单 + durl 回落。
 *
 * ## 为什么这样设计
 *
 * - **点播放才取流**：playurl 的地址短时效且绑 IP（见 `app/services/bili_play.py` 的说明），
 *   所以打开页面不取、不预取，用户点播放才向后端要一次；
 * - **默认 DASH**（音视频分离的裸 fMP4，实测能到 1080P），播不动/不支持时回落 **durl**（单 mp4、720P）；
 * - **清晰度菜单如实**：`accept` 里 1080P+/1080P60/4K 这些是**大会员档**，本账号拿不到
 *   （实测请求这些档位都会被静默回落）⇒ 菜单里显示但**禁用并标注「需大会员」**，
 *   默认选中 `quality`（后端告诉我们**实际拿到**的那档）。
 *
 * ## 播放失败时怎么办（devlog/293；plan 第 8 条）
 *
 * 失败**不直接判死**，按顺序只试两种补救，各**只试一次**（试完还失败才让播放器显示"播不了"）：
 * ① **地址过期**（`expires_in` 已到）⇒ 用**同一档**重取一次（保住 1080P；这才是"过期"的正解）；
 * ② 否则 ⇒ 回落 durl（换内核，DASH 在 WebView2 里解不了时走这条）。
 *
 * ⚠️ 为什么必须"各只一次"：回落本身是一次重新取流，若后端没换内核（`?fallback` 参数漏接那次
 * 就是这么坏的，见 devlog/292）就会**无限重取**。判据 `nextRetryAction` 是纯函数 ⇒ 直接测。
 */
import { useRef, useState } from 'react'
import { Play } from 'lucide-react'

import { api } from '../api/api'
import type { BiliPlayInfo } from '../api/types'
import VideoPlayer from './VideoPlayer'

/** B站清晰度 id → 是否大会员档（112=1080P+ / 116=1080P60 / 120=4K / 125=HDR / 126=杜比 / 127=8K） */
const PREMIUM_QN = new Set([112, 116, 120, 125, 126, 127])

/** 播放失败的补救动作（纯函数，便于直接测三态）。 */
export function nextRetryAction(
  s: { expired: boolean; triedRefresh: boolean; triedFallback: boolean },
): 'refresh' | 'fallback' | 'none' {
  if (s.expired && !s.triedRefresh) return 'refresh'
  if (!s.triedFallback) return 'fallback'
  return 'none'
}

interface Props {
  postId: number
  poster?: string | null
  permalink?: string | null
  title?: string
}

export default function BiliVideo({ postId, poster, permalink, title }: Props) {
  const [info, setInfo] = useState<BiliPlayInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 回落标记：DASH 播不动时改用 durl（单 mp4） */
  const [useDurl, setUseDurl] = useState(false)
  /** 本轮补救试过哪些（**只有用户重新点播放/换清晰度才清零**；"各只一次"的闸门） */
  const tried = useRef({ triedRefresh: false, triedFallback: false })
  /** 这批发来的地址什么时候过期（`fetchedAt + expires_in`，毫秒） */
  const expiresAt = useRef(0)
  const isExpired = () => expiresAt.current > 0 && Date.now() > expiresAt.current

  /**
   * 取流。`resetRetry` **只在用户手势**（首次点播放 / 换清晰度）上传 true：
   * 自动补救不算新手势 —— 否则"重取成功 → 又播不动"会无限重取（devlog/293）。
   */
  const load = async (opts: { qn?: number; fallback?: boolean } = {},
                      resetRetry = false) => {
    setBusy(true)
    setErr(null)
    if (resetRetry) tried.current = { triedRefresh: false, triedFallback: false }
    try {
      const got = await api.biliPlay(postId, opts)
      setInfo(got)
      setUseDurl(got.kernel === 'durl')
      expiresAt.current = Date.now() + (got.expires_in || 0) * 1000
    } catch (e) {
      // 后端把失败**如实分类**（不存在 / 无权限 / 风控），这里原样显示，不自己编文案
      setErr((e as Error)?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 播不动了：先看是不是地址过期（同档重取），否则回落 durl；两次都试过就不再拦（播放器自己判死）。
   *
   * ⚠️ `tried` 的字段名必须与 `nextRetryAction` 的入参**逐字对齐**（`triedRefresh`/`triedFallback`）：
   * 第一版写成 `{refresh, fallback}`，展开后那两个字段恒为 `undefined` ⇒ `!undefined === true`
   * ⇒ 闸门**永远开着**，"各只一次"变成无限重取（组件用例当场抓住）。
   */
  const onPlaybackFailed = () => {
    const action = nextRetryAction({ expired: isExpired(), ...tried.current })
    if (action === 'refresh') {
      tried.current.triedRefresh = true
      void load({ qn: info?.quality || undefined })
    } else if (action === 'fallback') {
      tried.current.triedFallback = true
      void load({ fallback: true })
    }
  }

  // ① 还没取过流：只给"播放"按钮（不预取、不自动播）
  if (!info) {
    return (
      <div className="vp bili-lazy">
        {poster && <img className="vp-video" src={poster} alt="封面" />}
        <button type="button" className="vp-bigplay" aria-label="播放"
                disabled={busy} onClick={() => void load({}, true)}>
          <Play className="size-7" />
        </button>
        {busy && <div className="bili-lazy-hint">正在取流…</div>}
        {err && <div className="bili-lazy-hint bili-lazy-err">{err}</div>}
        {title && <div className="bili-lazy-title">{title}</div>}
      </div>
    )
  }

  const best = info.dash.video[0] ?? null
  const audio = info.dash.audio[0] ?? null
  const dashOk = !useDurl && best?.base_url
  const durl = info.durl[0]?.url ?? null
  const qualities = info.accept.map((q) => ({
    id: q.id, label: q.label,
    disabled: PREMIUM_QN.has(q.id),
    note: PREMIUM_QN.has(q.id) ? '需大会员' : undefined,
  }))
  const canRetry = nextRetryAction({ expired: isExpired(), ...tried.current }) !== 'none'

  return (
    <VideoPlayer
      video={{ url: durl ?? best?.base_url ?? '' }}
      dash={dashOk ? { video: best!.base_url!, audio: audio?.base_url ?? null } : null}
      qualities={qualities}
      qualityId={info.quality}
      poster={poster}
      permalink={permalink}
      onPickQuality={(id) => void load({ qn: id }, true)}
      /* 播不动：过期 ⇒ 同档重取；否则回落 durl（单 mp4、720P、不需要音视频分离）。各一次 */
      onFallback={canRetry ? onPlaybackFailed : undefined}
    />
  )
}
