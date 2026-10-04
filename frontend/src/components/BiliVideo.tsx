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
import { useCallback, useRef, useState } from 'react'
import { Loader2, Play } from 'lucide-react'

import { api } from '../api/api'
import type { BiliPlayInfo } from '../api/types'
import ProxyImage from './common/ProxyImage'
import VideoPlayer from './VideoPlayer'
import { mseAvailable, type KernelStreams } from '../utils/mseKernel'
import { effectiveKernel } from '../utils/videoKernel'

/** B站清晰度 id → 是否大会员档（112=1080P+ / 116=1080P60 / 120=4K / 125=HDR / 126=杜比 / 127=8K） */
const PREMIUM_QN = new Set([112, 116, 120, 125, 126, 127])

/**
 * 段表的等待上限（**毫秒**）。
 *
 * 为什么要有上限：段表要后端多取两条流的头部（各 64KB），正常几百毫秒；但**起播不能被它拖住**
 * —— 超时就让渐进式先放起来（拿不到表 ⇒ 播放器自动走旧内核，用户无感）。
 * 这是"新内核更快"与"新内核不能成为新的卡点"之间的取舍，取 4s（实测抖动都在 1s 内）。
 */
const SEGMENTS_WAIT_MS = 4000

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
}

export default function BiliVideo({ postId, poster, permalink }: Props) {
  const [info, setInfo] = useState<BiliPlayInfo | null>(null)
  /** 段表（MSE 内核的输入，devlog/312）：null = 走渐进式 */
  const [segments, setSegments] = useState<KernelStreams | null>(null)
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
   * MSE 不可用时的诊断（**退回渐进式是本组件的默认行为，不是错误**）。
   *
   * ⚠️ 这里**不** `setSegments(null)`：熔断在 `videoKernel` 里（会话级），播放器自己就会切；
   * 再动一次 state 只会多一次无谓的重渲染。
   * ⚠️ 必须在下面那个 `if (!info) return` **之前**（否则 hooks 数量在两次渲染间不等 —— 真踩过）。
   */
  const onKernelFallback = useCallback((why: string) => {
    void api.clientLog(`[video] 本次会话改用渐进式内核：${why}`)
      .catch(() => { /* 诊断失败不影响播放 */ })
  }, [])

  /**
   * 取段表（**在把播放器放上屏之前**）。
   *
   * 为什么先取表再渲染：不给表就先渲染，播放器会先用渐进式起播、几百毫秒后再被 MSE 接管
   * —— 用户看到的是"画面重来一次"。所以这里等一下（上限 `SEGMENTS_WAIT_MS`），
   * 拿不到就 `null` 交给旧内核，**不报错**（用户不需要知道内核的事，他只要画面）。
   */
  const loadSegments = async (got: BiliPlayInfo, qn?: number,
                             cid?: number): Promise<KernelStreams | null> => {
    const best = got.dash.video[0]
    // 三道闸门：只有 DASH 能按段取；内核被切回旧的就别白跑一次；宿主没有 MSE 更别跑
    if (got.kernel !== 'dash' || !best?.base_url || !mseAvailable()
        || effectiveKernel() !== 'mse') {
      return null
    }
    const race = await Promise.race([
      api.biliSegments(postId, { qn, cid }).catch((e: Error) => {
        void api.clientLog(`[video] 段表取不到（走渐进式）：${e?.message ?? String(e)}`)
          .catch(() => { /* 诊断失败不影响播放 */ })
        return null
      }),
      new Promise<null>((r) => window.setTimeout(() => r(null), SEGMENTS_WAIT_MS)),
    ])
    if (!race) return null
    return { video: race.video, audio: race.audio, duration_s: race.duration_s }
  }

  /**
   * 取流。`resetRetry` **只在用户手势**（首次点播放 / 换清晰度）上传 true：
   * 自动补救不算新手势 —— 否则"重取成功 → 又播不动"会无限重取（devlog/293）。
   */
  const load = async (opts: { qn?: number; fallback?: boolean; cid?: number } = {},
                      resetRetry = false) => {
    setBusy(true)
    setErr(null)
    if (resetRetry) tried.current = { triedRefresh: false, triedFallback: false }
    try {
      const got = await api.biliPlay(postId, opts)
      const segs = await loadSegments(got, opts.qn, opts.cid)
      // 两个 state 同一次提交（React 18 会批）：第一帧就带着内核信息上屏，不会先渐进后 MSE
      setInfo(got)
      setSegments(segs)
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
        {/* ⚠️ 封面走 `ProxyImage`（**不是裸 `<img>`**）：B站的封面常是 `http://…hdslb.com/…`
            —— 裸 `<img>` 会因混合内容/防盗链直接破图（真机上就是那条黑底"图片"占位，
            见 devlog/294）。ProxyImage 负责 https 化 + 直连失败转 `/img-proxy`。 */}
        {poster && <ProxyImage className="vp-video" src={poster} alt="封面" />}
        {/* 取流中：**屏幕中央的旋转缓冲图标**（用户 2026-10-03 口径：那条"正在取流…"的下黑边
            去掉）。取流要走一次 playurl，通常不到 1s，但缓存/风控下可能几秒 —— 有转圈才不心虚。 */}
        {busy ? (
          <div className="vp-spin" role="status" aria-label="正在取流">
            <Loader2 className="vp-spin-icon" aria-hidden="true" />
          </div>
        ) : (
          <button type="button" className="vp-bigplay" aria-label="播放"
                  onClick={() => void load({}, true)}>
            <Play className="size-7" />
          </button>
        )}
        {/* 失败**如实显示后端分类的原因**（不存在/无权限/风控），居中成一颗玻璃药丸 —— 
            别贴在底部当条黑边（那位置和"标题带"一样容易被当成元素错位） */}
        {err && <div className="bili-lazy-err" role="alert">{err}</div>}
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
  /**
   * **分P 菜单的数据**（`devlog/329`）：上游 `view.duration` 是各 P 之和，
   * 老实现永远播第 1 P —— 7 P 的直播实况在应用里只剩第一段，且**没有任何入口**。
   * 只有一 P（绝大多数视频）时 `VideoPlayer` 不渲染这个菜单。
   */
  const pages = info.pages ?? []
  const rest = (urls?: string[] | null, head?: string | null) =>
    (urls ?? []).filter((u) => u && u !== head)

  return (
    <VideoPlayer
      video={{ url: durl ?? best?.base_url ?? '',
               fallbacks: rest(info.durl[0]?.urls, durl) }}
      /* 镜像链交给播放器自己换源（devlog/294）：baseURL 常常是 P2P/mcdn 主机，
         后端已按"能不能过代理"排好序，挂一条就换下一条，不必回后端重取 */
      dash={dashOk ? { video: best!.base_url!,
                       videoFallbacks: rest(best!.urls, best!.base_url),
                       audio: audio?.base_url ?? null,
                       audioFallbacks: rest(audio?.urls, audio?.base_url) } : null}
      /* 段表（devlog/312）：给了它就走 MSE（按段取数、一个时钟）；null ⇒ 渐进式 */
      segments={segments}
      onKernelFallback={onKernelFallback}
      qualities={qualities}
      qualityId={info.quality}
      poster={poster}
      permalink={permalink}
      /* B站这条路上的**每一次**取流都源于用户动作（点播放 / 换清晰度 / 播不动后的补救）
         ⇒ 地址一到位就起播；"只出界面不播"是用户 2026-10-03 明确否掉的那一版交互 */
      autoPlay
      /* 换清晰度/补救时的重新取流：播放器中央转圈（旧流还在，别把画面与进度丢掉） */
      loading={busy}
      onPickQuality={(id) => void load({ qn: id }, true)}
      /* 分P（devlog/329）：切 P = 重取流（与换清晰度同一条路，播不动时才回落）。
         ⚠️ `qn` 要带上当前档：切 P 不该把用户选的清晰度悄悄重置回默认 */
      pages={pages}
      currentPage={info.page ?? 1}
      onPickPage={(cid) => void load({ qn: info.quality || undefined, cid }, true)}
      /* 播不动：过期 ⇒ 同档重取；否则回落 durl（单 mp4、720P、不需要音视频分离）。各一次 */
      onFallback={canRetry ? onPlaybackFailed : undefined}
    />
  )
}
