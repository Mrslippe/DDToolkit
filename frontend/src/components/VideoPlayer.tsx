/**
 * 自绘播放器（2026-10-03，devlog/283）：替换浏览器原生控件，皮肤与排版跟随项目设计语言。
 *
 * 为什么自绘：原生 `<video controls>` 的样式不可控（截图里那套是 Edge/Chromium 的），
 * 与仓库的黑玻璃 + 粉强调不是一套东西；而**全屏走容器**（`requestFullscreen()`）才能保住
 * 自绘控件（原生 video 全屏会把控件换回系统那套）。
 *
 * ## 两条内核（2026-10-04，devlog/312）
 *
 * | | **MSE（默认）** | progressive（退路） |
 * |---|---|---|
 * | 取数 | 段表在手，按 `Range` 取**那一段** | 浏览器自己在百万字节上猜位置 |
 * | 时钟 | **一个**（音视频两条 SourceBuffer 喂同一个元素） | 两个（独立 `<audio>` + 漂移纠正） |
 * | seek | 先 append 目标段，再设 `currentTime` | 设 `currentTime` 后等浏览器追 |
 * | 失败 | 建不起来/取不到段/append 报错 ⇒ **当场**退回右边这列 | 全失败 ⇒ 交给调用方换内核（durl） |
 *
 * 默认走 MSE 的理由是**旧内核 seek 后必卡**（`devlog/310` 八次复现同形状）；
 * 开关与自动熔断在 `utils/videoKernel`（用户口径：「默认 MSE、开关只作为退路」）。
 * 走 MSE 时下面**所有**音轨相关的接线都自动失效（没有 `<audio>` 元素可管），
 * 这是这一刀最值钱的地方：`devlog/298`–`305` 六批补丁治的都是"两个钟"。
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
  ExternalLink, Loader2, Maximize, Minimize, Pause, Play, PictureInPicture2,
  RotateCcw, Volume1, Volume2, VolumeX,
} from 'lucide-react'

import { api, videoProxyUrl } from '../api/api'
import { normalizeImageUrl } from '../utils/format'
import { openExternalFromHref } from '../utils/externalLinkGuard'
import { watchPlayback } from '../utils/playbackProbe'
import { reportUserError } from '../utils/problemReport'
import { MseKernel, kernelSupported, type KernelStreams } from '../utils/mseKernel'
import type { BiliPage } from '../api/types'
import { MAX_AUTO_DOWNGRADES, linkSlowNote, mbps, pickDowngrade } from '../utils/qualityAbr'
import { effectiveKernel, noteMseFailure, subscribeKernel } from '../utils/videoKernel'
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
   * **分P**（`devlog/329`）：B站一个视频可以有多个 P（每 P 是独立的一条流）。
   *
   * 老实现永远只播第 1 P —— 实测某 7 P 直播实况（共 6.6 小时）在应用里只剩 76 分钟，
   * 且**没有任何入口**。`pages.length > 1` 时才渲染"分P"菜单。
   */
  pages?: BiliPage[] | null
  /** 当前第几 P（1 起） */
  currentPage?: number
  /** 用户选了另一 P（调用方重取流；与换清晰度同一条路） */
  onPickPage?: (cid: number) => void
  /**
   * 播不动时的**外部回落**（B站：DASH → durl，由调用方重新取流）；给了它就不再显示"播不了"兜底卡
   */
  onFallback?: () => void
  /**
   * **全部源都失败**（连本机代理那条也失败）时叫一次，由调用方决定要不要**重取媒体地址**。
   *
   * 为什么需要它（2026-10-06 用户实机报障）：抖音的播放地址是**限时签名地址**
   * （`l=20261005191106…` = 签发时刻），实测**存了 8 小时后 CDN 一律 403**；
   * 而这一帖的地址是入库那天签的 ⇒ 第二天点开必然播不了，界面只报"全部播放源都失败"，
   * 用户完全没法知道"是地址过期、重取一次就好"。
   * 图床那条路早就这么干了（`PostDetailDrawer.onMediaDead` ⇒ `POST /posts/{id}/refresh-media`），
   * 视频这条**一直没接**。
   *
   * ⚠️ 调用方必须**自己保证只重取一次**（`onMediaDead` 里的 `refreshedRef` 就是干这个的）——
   * 这个回调只保证"这一轮真的全失败了"，不保证不重复。
   */
  onAllFailed?: () => void
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
  /**
   * **段表**（2026-10-04，devlog/312）：MSE 内核的输入（`GET /bili/segments/{post_id}`）。
   *
   * 给了它、且内核没被开关切走 ⇒ 走 MSE：按段 `Range` 取数、音视频同一个元素（一个钟）。
   * 没给（取不到表 / 非 B站 / 开关切回旧内核）⇒ 自动落回下面的渐进式路径，**不报错**。
   */
  segments?: KernelStreams | null
  /** MSE 这条路不成立（不支持 / 取不到段 / append 报错）：调用方记一行诊断即可 ——
   *  退回渐进式是**本组件自动做的**（`videoKernel` 的会话熔断），调用方不需要换 props。 */
  onKernelFallback?: (why: string) => void
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

/**
 * 缓冲治理（devlog/301）：**饿的时候按住，缓冲够了再放**。
 *
 * 用户口径：「跳到很后面时视频会一帧帧播放并且每帧都暂停，播放/暂停一直反复横跳……
 * 可以在跳转后的加载阶段保证加载了一定内容之后才开始播放」。
 *
 * 机理：progressive（`<video src>`）播放时**缓冲节奏由浏览器定** —— 只要缓冲里有一帧，
 * 它就把那一帧放出来，然后立刻又饿住。观感就是"一帧一帧 + 状态横跳"。
 * 成熟播放器都是自己管缓冲的（hls.js：`maxBufferLength` 30s 是**目标**、
 * `maxBufferHole` 0.5s、停住 3s 就 nudge、`maxStarvationDelay`/`maxLoadingDelay` 4s 是**容忍**），
 * 我们这层能控的只有"什么时候允许继续跑"，所以：
 *
 * - 前方不足 `HOLD_AT` 秒 ⇒ **主动 `pause()`**（饿着跑只会抖），转圈 + 停音轨；
 * - 前方够 `RESUME_AT` 秒 ⇒ 放开（秒级，不是 hls.js 的 30s：那是它的**目标缓冲**，
 *   而这里是"能不能开播"的门槛）；
 * - ⚠️ **兜底**：按住期间缓冲**完全不涨**超过 `DEADLOCK_MS` ⇒ 立刻放开。
 *   实测（2026-10-04，无头 Edge）：暂停状态下浏览器**不会**继续把缓冲拉起来
 *   （`ahead` 8s 按住 8 秒纹丝不动）—— 没有这条兜底，"等缓冲"会变成**永远等下去**。
 */
const HOLD_AT = 0.5
const RESUME_AT = 2.0
const DEADLOCK_MS = 1200
const HOLD_POLL_MS = 200

/**
 * 按住右方向键试听的**倍速**与**触发门槛**（2026-10-05 用户口径，`devlog/356`）：
 * 按住超过 `HOLD_TRIGGER_MS` 才加速（短按仍然是快进 5 秒），松手立刻恢复用户选的倍速。
 *
 * ⚠️ 倍速**不写进 `playerPrefs`**：它是"按住时临时听一下"，不是用户的偏好 ——
 * 写进去会让底栏那个倍速文字跟着变、并且下次打开还以为用户选了 3×（用户明确说了
 * "只在播放器里展示倍速图标，状态行不需要收到这些消息"）。
 */
const HOLD_SPEED = 3
const HOLD_TRIGGER_MS = 250
/** 全屏时贴着下边缘是想**呼出**控件，不是"离开"（用户口径，devlog/301） */
const BOTTOM_HOT_ZONE = 72
/**
 * 转圈**至少要亮这么久**（devlog/302）。
 *
 * 用户口径：「缓冲按钮在缓冲的时候还会**闪动**」—— `waiting` / `canplay` 在饿住-回血的
 * 边界上会连着来回发（一帧一帧那种），每次 `canplay` 就把转圈收掉 ⇒ 屏幕上一闪一闪。
 * 给"显示"一个最短时长，短于它的回血**不收起**，看起来才是一个稳定的"正在缓冲"。
 */
const MIN_SPIN_MS = 450
/**
 * 浮层"要 hover 多久才弹出"（2026-10-04，devlog/317）。
 *
 * 用户口径：「控件 hover 触发的时间拉长一点，以防鼠标扫过就呼出上拉栏」——
 * 鼠标从画面上扫到右下角的全屏键时，会**顺路**划过倍速/清晰度，没有延时就会弹一下再收。
 */
const HOVER_OPEN_MS = 240
/**
 * 浮层"离开后多久才真的收起"（清晰度 / 倍速，devlog/316）。
 *
 * 按钮与浮层之间有几像素的缝，指针穿过去时 `mouseleave` **先到** —— 没有宽限就会
 * "刚移开就没了、够不着菜单"（音量浮窗当初就是被这条咬过，它靠 CSS 里一块看不见的"桥"绕开）。
 */
const HOVER_GRACE_MS = 180

/**
 * **悬停触发的浮层**（清晰度 / 倍速共用一套，devlog/316）。
 *
 * 用户口径：「清晰度、倍速的按钮上拉栏并不是 hover 触发，而是点击触发，这会让控制逻辑不统一，
 * 全部改为 hover 触发」——音量那处本来就是 hover（纯 CSS），所以这里是**把三处统一到同一套**。
 *
 * 四条口径：
 * - **鼠标：hover 开、移开关**（点击不改变状态 —— 它由 hover 决定，避免"点一下反而关掉"）；
 * - **开有延时**（`HOVER_OPEN_MS`）、**关有宽限**（`HOVER_GRACE_MS`）：扫过不弹、穿缝不断；
 * - **没有 hover 的输入方式仍要能用**：键盘 Enter/Space、触屏点按 ⇒ 走"钉住"语义
 *   （点开之后移开鼠标不关，再点一次/选中一项才关）；判据是"此刻有没有 hover"；
 * - 已经开着的浮层被再次 hover 时**不再等延时**（否则移开再移回来会有 240ms 的迟滞）。
 */
function useHoverMenu() {
  const [open, setOpen] = useState(false)
  const hovered = useRef(false)
  const pinned = useRef(false)
  const openTimer = useRef(0)
  const closeTimer = useRef(0)
  const cancel = useCallback(() => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    openTimer.current = 0
    closeTimer.current = 0
  }, [])
  const enter = useCallback(() => {
    hovered.current = true
    window.clearTimeout(closeTimer.current)
    window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => {
      if (hovered.current) setOpen(true)
    }, HOVER_OPEN_MS)
  }, [])
  const leave = useCallback(() => {
    hovered.current = false
    window.clearTimeout(openTimer.current)      // 还没弹出来就离开 ⇒ 干脆不弹
    if (pinned.current) return                  // 键盘/触屏钉住的，移开鼠标不关
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      if (!hovered.current && !pinned.current) setOpen(false)
    }, HOVER_GRACE_MS)
  }, [])
  /** 点击：**只在没有 hover 时**才切（鼠标点击交给 hover；键盘/触屏走这条） */
  const toggle = useCallback(() => {
    if (hovered.current) return
    pinned.current = !pinned.current
    setOpen(pinned.current)
  }, [])
  const close = useCallback(() => {
    pinned.current = false
    hovered.current = false
    cancel()
    setOpen(false)
  }, [cancel])
  useEffect(() => cancel, [cancel])
  return { open, enter, leave, toggle, close }
}

/**
 * 「需大会员」的小图标：**圆圈里一个「大」**（2026-10-04 用户口径 + 参考图，`devlog/317`）。
 *
 * 为什么不用图标字体/文字：这是 12px 的小徽标，自绘笔画既不受字体影响、也不会有基线偏移；
 * 圆圈用 `currentColor` 描边，跟着档位名一起变淡（disabled 那档 `.vp-menu-item:disabled` 的
 * `opacity` 会同时压暗它）。
 * 无障碍名由档位的 `title` + `aria-label` 承担，所以这里 `aria-hidden`（图标不再念一遍）。
 */
function VipBadge({ note }: { note: string }) {
  return (
    <svg className="vp-vip" viewBox="0 0 16 16" aria-hidden="true" data-vp-note={note}
         fill="none" stroke="currentColor" strokeWidth="1.3"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.3" />
      {/* 大 = 一 + 人（三笔），按 12px 下的可辨性调过粗细与角度 */}
      <path d="M5.1 6.5h5.8" />
      <path d="M8 4.9 5.3 11.4" />
      <path d="M8 6.5l2.7 4.9" />
    </svg>
  )
}

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function VideoPlayer({ video, poster, permalink, dash, qualities, qualityId,
                                      onPickQuality, pages, currentPage, onPickPage,
                                      onFallback, autoPlay, loading,
                                      segments, onKernelFallback, onAllFailed }: Props) {
  const prefs = useSyncExternalStore(subscribePlayerPrefs, playerPrefs)
  /**
   * 内核选择（**订阅**：设置里切一下、或 MSE 当场熔断，界面立刻换路径，不用重开）。
   * ⚠️ 用的是 `effectiveKernel()`（含会话熔断）而不是 `kernelChoice()`（用户存的那份）。
   */
  const kernel = useSyncExternalStore(subscribeKernel, effectiveKernel)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  /** DASH 模式的独立音轨（视频元素那边静音）—— **只在渐进式内核下存在** */
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const isDash = Boolean(dash?.video)
  /** MSE 内核实例（渐进式路径下恒为 null —— 它就是"走哪条路"的判据本身） */
  const mseRef = useRef<MseKernel | null>(null)
  /** 段表的最新一份（内核 effect 靠 ref 读它，依赖只挂**内容键**，见下） */
  const segmentsRef = useRef(segments)
  useEffect(() => { segmentsRef.current = segments }, [segments])
  /** 段表的**内容键**：两条流的地址 + 时长（同内容不同对象不该重建内核） */
  const streamsKey = segments
    ? `${segments.video?.url ?? ''}|${segments.audio?.url ?? ''}|${segments.duration_s ?? 0}`
    : ''
  /**
   * 换**片**了才把自动降档的记账清零（`permalink` 认这一件事）。
   *
   * ⚠️ 别挂在 `streamsKey` 上：换清晰度本身就会换流 —— 那样每降一档额度就重置一次，
   * `MAX_AUTO_DOWNGRADES` 等于没有（这条是写完用例才发现的）。
   */
  useEffect(() => { autoDowngradesRef.current = 0; setAutoNote(null) }, [permalink])
  /** `onKernelFallback` 走 ref 读（见 MSE 那个 effect 的依赖说明） */
  const onKernelFallbackRef = useRef(onKernelFallback)
  useEffect(() => { onKernelFallbackRef.current = onKernelFallback }, [onKernelFallback])
  /**
   * **自动降档**（ABR，`devlog/328`）：内核只报"链路喂不饱这一档"，降不降、降到哪一档在这里定。
   *
   * ⚠️ 档位与当前档也要走 ref：内核 effect 的依赖只挂**内容键**（换档会重建内核，见下），
   * 闭包里的 `qualities`/`qualityId` 会过期 —— 真踩过"降档后还拿旧档算下一档"这类 stale closure。
   */
  const qualitiesRef = useRef(qualities)
  const qualityIdRef = useRef(qualityId)
  const onPickQualityRef = useRef(onPickQuality)
  useEffect(() => {
    qualitiesRef.current = qualities
    qualityIdRef.current = qualityId
    onPickQualityRef.current = onPickQuality
  }, [qualities, qualityId, onPickQuality])
  /** 本轮播放已经自动降过几次（上限 `MAX_AUTO_DOWNGRADES`）——**只在内容键变化时清零** */
  const autoDowngradesRef = useRef(0)
  /** 自动降档的说明（放进清晰度菜单里，不弹窗）；`null` = 没降过 */
  const [autoNote, setAutoNote] = useState<string | null>(null)
  /** 等目标段落地的这段时间：中央转圈（否则用户看到的是"画面冻住不动"） */
  const [mseSeeking, setMseSeeking] = useState(false)
  /** 正在等的目标时刻（`null` = 没在等）。**只在 MSE 下有值**，见 `onTime` 那条注释 */
  const mseTargetRef = useRef<number | null>(null)
  /** MSE 退场时要**接着播**的位置（见那条 effect 的注释）；渐进式那边 `loadedmetadata` 后落地 */
  const resumeRef = useRef(0)
  /** 上一次渲染是不是 MSE（用来认"**刚刚**退场"这件事，而不是"一直没走 MSE"） */
  const wasMseRef = useRef(false)
  const mseReady = isDash && kernel === 'mse' && Boolean(segments?.video)
  /** 真走 MSE 吗（要过 codecs/表完整性判定；**纯判定**，这里只是渲染期的判断） */
  const useMse = mseReady && kernelSupported(segments).ok
  /** 音视频分离的双元素模式（旧内核）。MSE 下声音就在同一个 `<video>` 里 */
  const dualTrack = isDash && !useMse

  const [idx, setIdx] = useState(0)
  /** DASH 音轨的镜像序号（视频轨用 `idx`，两条流各自换源 —— 一条挂了不必重来另一条） */
  const [aidx, setAidx] = useState(0)
  const [dead, setDead] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [buf, setBuf] = useState(0)
  /** 倍速 / 清晰度浮层：**hover 触发**（devlog/316；键盘与触屏走点击，见 `useHoverMenu`） */
  const rateMenu = useHoverMenu()
  const qualityMenu = useHoverMenu()
  const pageMenu = useHoverMenu()
  const [fs, setFs] = useState(false)
  /**
   * **播完了**（`devlog/317`）：画面冻结在尾帧 + 中央一颗"重新播放"。
   *
   * 用户口径：「视频播放完后冻结在尾帧，显示重新播放的图标，点击后从头开始播放」。
   */
  const [ended, setEnded] = useState(false)
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
  /** 指针在**下边缘热区**（按坐标判，不是按元素）—— 全屏时甩到最下面是想呼出控件 */
  const nearBottomRef = useRef(false)
  const idleTimer = useRef(0)
  const controlsPinned = useCallback(
    () => hoverBarRef.current || nearBottomRef.current, [])
  const nearBottom = useCallback((clientY: number) => {
    const r = wrapRef.current?.getBoundingClientRect()
    // ⚠️ 量不到高度就**不豁免**（jsdom/隐藏元素里 rect 全是 0，那样每个坐标都会被判成"贴下边缘"
    // ⇒ 控件永不收起，而这个 bug 只在测试环境里显形，真机上表现为"全屏时控件再也不隐藏"）
    if (!r || r.height <= 0) return false
    return clientY >= r.bottom - BOTTOM_HOT_ZONE
  }, [])
  const bumpControls = useCallback(() => {
    setIdle(false)
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      if (!controlsPinned()) setIdle(true)
    }, 3000)
  }, [controlsPinned])
  useEffect(() => () => window.clearTimeout(idleTimer.current), [])

  /** 正在拖拽 seek（state 给渲染用；`draggingRef` 给事件监听用 —— 监听闭包会看到旧 state） */
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  /** 缓冲中（`waiting` → `playing`/`canplay`）：中央转圈，别看起来像"暂停了"（devlog/299） */
  const [buffering, setBuffering] = useState(false)
  /** 转圈的最短显示时长（防闪动，见 `MIN_SPIN_MS`） */
  const spinRef = useRef({ since: 0, hideTimer: 0 })
  /** 缓冲治理的按住状态（见 `HOLD_AT` 那段注释） */
  const holdRef = useRef({ active: false, selfAt: 0, lastAhead: -1, stuck: 0 })
  /**
   * 播放诊断窗口（devlog/306）：**只在真机上出现**的现象（"跳转后画面低帧率"）靠它留证据。
   * 起播与每次 seek 各开一个 8 秒窗口，收尾时把一行数字发给后端日志。
   */
  const probeRef = useRef<ReturnType<typeof watchPlayback> | null>(null)
  const startProbe = useCallback((el: HTMLVideoElement, reason: string, targetS?: number) => {
    probeRef.current?.cancel()          // 连续拖拽：只跟最后一个窗口
    // 内核名进诊断行：真机上"这次是 MSE 还是渐进式"必须能从日志里读出来（不然没法对账）
    probeRef.current = watchPlayback(el, reason, targetS,
                                     mseRef.current ? 'MSE' : '渐进')
  }, [])
  // 卸载时**先把已采到的报出去**（不是丢弃）：第一版丢弃，于是用户关掉抽屉那几次
  // 恰好什么都没留下（真机只捞到 1 行就是这么来的，devlog/307）
  useEffect(() => () => probeRef.current?.finish(), [])

  /** `[start, end]` 里包含当前位置的那一段还剩多少秒（没缓冲到当前位置 ⇒ -1） */
  const bufferedAhead = useCallback((el: HTMLMediaElement) => {
    try {
      for (let i = 0; i < el.buffered.length; i += 1) {
        if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i)) {
          return el.buffered.end(i) - el.currentTime
        }
      }
    } catch {
      /* jsdom/异常：当作没有缓冲信息 */
    }
    return -1
  }, [])

  /**
   * **MSE 内核**（devlog/312）：建 MediaSource、挂 init、按段取数。
   *
   * 为什么整条路都在这里而不是让调用方换组件：控件/清晰度菜单/音量倍速/诊断窗口都是现成的，
   * 换内核不该把它们一起换掉 —— 换的只有"数据怎么进这个 `<video>`"。
   *
   * ⚠️ **退回渐进式是自动的**：`noteMseFailure` 让 `effectiveKernel()` 变 `progressive`
   * ⇒ 本组件重渲染 ⇒ 下面 `useMse` 为假 ⇒ 清理这个 effect（销毁内核、摘掉 blob URL）
   * ⇒ 直接走渐进式那套。**用户不会看到任何弹窗**（他不需要知道内核叫什么，只关心能不能看），
   * 诊断留在日志里（`[video] MSE 不可用…`）。
   */
  useEffect(() => {
    if (!useMse) return
    const s = segmentsRef.current
    if (!s) return
    const el = videoRef.current
    if (!el) return
    const kernel = new MseKernel(el, {
      onFatal: (why) => {
        void api.clientLog(`[video] MSE 不成立，退回渐进式：${why}`)
          .catch(() => { /* 诊断上报失败绝不影响播放 */ })
        noteMseFailure(why)
        onKernelFallbackRef.current?.(why)
      },
      onProgress: (end) => setBuf(end),
      /**
       * **链路喂不饱这一档**（`devlog/328`）：只降一级、只降不升、一次播放最多降两次。
       * 走的是与"用户自己点档位"**同一条路**（`onPickQuality` ⇒ 调用方重取流 ⇒ 重建内核），
       * 所以清晰度菜单显示的就是**实际**那一档（不撒谎）。
       */
      onLinkSlow: (s) => {
        const cur = qualityIdRef.current
        const next = pickDowngrade(qualitiesRef.current, cur)
        const from = qualitiesRef.current?.find((q) => q.id === cur)?.label ?? '当前档'
        if (!next) {
          void api.clientLog(`[video] 链路喂不饱${from}（实测 ${mbps(s.bytesPerSec)} / `
                             + `需要 ${mbps(s.neededBytesPerSec)}），但没有更低的可用档`)
            .catch(() => { /* 诊断失败无所谓 */ })
          return
        }
        if (autoDowngradesRef.current >= MAX_AUTO_DOWNGRADES) {
          void api.clientLog(`[video] 链路喂不饱${from}，但自动降档已用满 ${MAX_AUTO_DOWNGRADES} 次`
                             + ` ⇒ 不再降（交给用户自己选）`).catch(() => { /* 同上 */ })
          return
        }
        autoDowngradesRef.current += 1
        const note = linkSlowNote(s.bytesPerSec, s.neededBytesPerSec, from, next.label)
        setAutoNote(note)
        void api.clientLog(`[video] ${note}（第 ${autoDowngradesRef.current} 次自动降档）`)
          .catch(() => { /* 同上 */ })
        onPickQualityRef.current?.(next.id)
      },
      onSeekApplied: (t) => {
        mseTargetRef.current = null
        setCur(t)
        setMseSeeking(false)
        // 跳转期间是我们主动暂停的 ⇒ 落地后接着放（用户口径，devlog/317）
        const el = videoRef.current
        if (el && el.paused && wantPlayRef.current) {
          void el.play().catch(() => { /* 策略拒绝：保持暂停，让用户再点一下 */ })
        }
      },
      // 慢段/换镜像/淘汰各一行：真机"卡不卡"要和代理那边的 `[视频代理]` 行对得上
      log: (line) => { void api.clientLog(line).catch(() => { /* 同上 */ }) },
    })
    mseRef.current = kernel
    if (!kernel.load(s)) {
      mseRef.current = null
      noteMseFailure('内核建不起来')
      return
    }
    // 段表自带总时长 ⇒ 进度条立刻是对的（不用等 `loadedmetadata`；MSE 下它有时来得晚）
    setDur(s.duration_s || 0)
    return () => { kernel.destroy(); mseRef.current = null }
    // ⚠️ 依赖是**内容键**（`streamsKey`）而不是 `segments` 对象本身：父组件只要**每次渲染
    //    新造一个同内容的 `{video, audio}`**，按对象比就会**每渲染一次重建内核**
    //    （重新取 init、画面从头来）。真机症状是"画面莫名其妙重载"，而生产里
    //    `BiliVideo` 传的是 state（引用稳定）—— 这个坑先按内容钉死，别等人踩。
    // ⚠️ `onKernelFallback` 走 ref 而不是进依赖：同理（内联箭头函数会每次换引用）。
  }, [useMse, streamsKey])

  /** MSE 中途退场（熔断/换清晰度）⇒ 别把"等跳转"的转圈留在屏幕上。
   *  ⚠️ 真正的"接着播回去"在 `startPlayback` 定义之后那个 effect 里（它要用到它）。 */
  useEffect(() => {
    if (useMse) return
    mseTargetRef.current = null
    setMseSeeking(false)
  }, [useMse])

  // DASH 模式：**只走本机代理**（媒体 CDN 不带 Referer 403）；普通模式仍是 直连 → 代理 的链。  // ⚠️ 代理 URL 必须用 `videoProxyUrl()`（拼 `apiBase`）—— 写成相对的 `/video-proxy?…` 会落到
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
  const audioSrc = dualTrack && dashAudioUrls.length
    ? videoProxyUrl(dashAudioUrls[Math.min(aidx, dashAudioUrls.length - 1)])
    : null

  /**
   * **媒体指纹**（devlog/363）：这一轮**全部候选地址**拼成的 key —— 换了地址就换 key。
   *
   * 为什么必须有它（2026-10-06 用户实机报障的**第二层**）：`idx`/`dead` 是组件里的持久状态，
   * 而"重取媒体地址"回来时调用方是**原地换 prop**（`PostDetailDrawer` 拿到新帖就 `setPatched`，
   * 既不换 key 也不重新挂载）⇒ 上一轮留下的"已经烧到第 2 面镜像 / 已经判死"会**原样留给
   * 新地址**：新地址明明能用，界面却还停在"这个视频在当前环境里播不了"。
   * 更隐蔽的一层：重取回来的候选往往**更少**（抖音详情里常常只剩 `play_addr` 一条 + 它的
   * 本机代理镜像），而 `idx` 还停在 2 ⇒ `src === undefined` ⇒ 直接走兜底卡（连 `<video>`
   * 都没挂上），看起来就是"重取了照样播不了"。
   *
   * ⚠️ 这里是**渲染期归零**（React 官方的 "adjusting state when props change"），不是 `useEffect`：
   * 用 effect 的话新地址会先按旧序号渲染一帧 —— 那一帧正好是兜底卡，还会顺手报一条
   * "全部播放源都失败"的**假**报告（effect 在提交后才跑），下一帧才修好。
   *
   * ⚠️ 指纹**只能由 prop 里的地址算**，绝不能用 `src`/`audioSrc`（它们自己依赖 `idx`/`aidx`）：
   * 否则"换下一条镜像"就会改指纹 ⇒ 归零把刚换上的序号又抹回 0（DASH 双元素那条镜像链用例
   * 当场抓到：音轨失败换成 `audioFallbacks[0]` 之后又被弹回原地址，同一条反复报错）。
   */
  const mediaKey = isDash
    ? [...dashVideoUrls, '\u0000', ...dashAudioUrls].join('\u0000')
    : direct.join('\u0000')
  const [lastMediaKey, setLastMediaKey] = useState(mediaKey)
  if (lastMediaKey !== mediaKey) {
    setLastMediaKey(mediaKey)
    setIdx(0)
    setAidx(0)
    setDead(false)
  }

  /** 全局偏好下发给**真正出声的那个元素**（DASH 双元素 = 音轨；MSE/单文件 = 视频元素自身） */

  // 全局偏好每次变更都下发给元素。
  // ⚠️ DASH 档**两个元素都要发**（devlog/299）：声音在音轨上，但小窗那个静音按钮看的是
  // 视频元素的 `muted` —— 只下发一个，"小窗静音"就会和真实声音脱节。
  useEffect(() => {
    if (dualTrack) {
      const a = audioRef.current
      const v = videoRef.current
      if (a) applyPlayerPrefs(a)
      if (v) applyPlayerPrefs(v)
    } else {
      const v = videoRef.current
      if (v) applyPlayerPrefs(v)
    }
    // ⚠️ **按住加速期间要把倍速改回来**（2026-10-05）：`applyPlayerPrefs` 用的是**持久化**的
    //    `prefs.rate`，而这条 effect 的依赖里有 `prefs` —— 按住 3× 时只要有任何偏好变化
    //    （例如顺手按↑调音量），它就会把倍速拉回 1×（"按住加速忽然失效"）。
    applyEffectiveRate()
  }, [prefs, src, dualTrack])

  /**
   * DASH 双元素：音轨与视频轨的**漂移纠正**（两条独立流，浏览器不会自动对齐）。
   *
   * 实测（`devlog/298`）：19 秒漂到 **0.28s**（音轨超前）—— 视频轨那条没有音轨、时钟是墙上时间
   * 估的，与跟声卡走的音轨有约 1.5% 的速率差。原来只有"超 0.3s 就直接对齐"一档，
   * 于是 0.28s 这种"已经能感觉出来"的量级反而被放过去了；而且每次都靠"跳一下"来修。
   * 现在按 `driftAction` 分级：小漂移用**改速率慢慢追**（听不出来），大漂移才跳。
   *
   * ⚠️ **MSE 下这条整段都不存在**（`dualTrack` 为假）：音视频在同一个元素、同一个时钟上，
   * 没有漂移这回事。这一条就是新内核最值钱的地方（用户"抖一阵"的病根）。
   */
  useEffect(() => {
    if (!dualTrack) return
    const id = window.setInterval(() => {
      const v = videoRef.current
      const a = audioRef.current
      // ⚠️ **视频轨暂停时绝对不要纠正**（devlog/299）：暂停常常来自小窗/系统媒体键
      // （不经过我们的 `toggle`）。那时音轨若还在放，漂移会立刻超过阈值 ⇒ 每秒把它拽回
      // 冻结的画面时间 ⇒ 同一小段被反复重放。暂停的事由 `pause` 监听负责（它会停音轨）。
      if (!v || !a || v.paused || a.paused || !Number.isFinite(a.currentTime)) return
      const { snap, rate } = driftAction(a.currentTime - v.currentTime, rateRef.current)
      if (snap) a.currentTime = v.currentTime
      a.playbackRate = rate
    }, 1000)
    return () => window.clearInterval(id)
  }, [dualTrack, prefs.rate])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const a = audioRef.current
    applyPlayerPrefs(el)                       // 挂载即对齐全局音量（含静音态，见下面 volumechange）
    if (a) applyPlayerPrefs(a)

    /**
     * 出画 ⇒ 音轨**对齐并起播**（幂等）。
     *
     * ⚠️ 这不只是"起播"：它同时是**每次饿住之后的重同步点**（`devlog/305`）——
     * 画面停过一段时间，音轨（`onWaiting` 里被停住）必须**重新对齐到画面当前的时刻**再出声，
     * 否则饿住期间攒下的差就被带进后半段。
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

    /** 离开"按住"状态：放开并重新起播（音轨由 `playing` 那条路跟上）。 */
    const releaseHold = () => {
      const hold = holdRef.current
      if (!hold.active) return
      hold.active = false
      hold.lastAhead = -1
      hold.stuck = 0
      endSpin()          // 数据够了 ⇒ 转圈按最短时长收尾（不是立刻消失，免得又闪）
      void el.play().catch(() => { /* 策略拒绝：保持暂停 */ })
    }

    /** 显示转圈（最短 `MIN_SPIN_MS`，防闪动） */
    const showSpin = () => {
      window.clearTimeout(spinRef.current.hideTimer)
      if (!spinRef.current.since) spinRef.current.since = Date.now()
      setBuffering(true)
    }
    /** 回血：短于最短时长**先不收**（否则饿住-回血的边界上会一闪一闪） */
    const endSpin = () => {
      const shown = spinRef.current.since ? Date.now() - spinRef.current.since : MIN_SPIN_MS
      const left = MIN_SPIN_MS - shown
      window.clearTimeout(spinRef.current.hideTimer)
      const done = () => { spinRef.current.since = 0; setBuffering(false) }
      if (left > 0) spinRef.current.hideTimer = window.setTimeout(done, left)
      else done()
    }
    /**
     * **立刻**收掉转圈（不走最短时长）。
     *
     * 只给"播完了"这一种用（`devlog/318`）：那时不存在"饿住又被喂饱"的闪动问题，
     * 而 `MIN_SPIN_MS` 的 450ms 迟滞会让尾帧上继续转小半秒 —— 用户要的是"冻住 + 重新播放"。
     */
    const killSpin = () => {
      window.clearTimeout(spinRef.current.hideTimer)
      spinRef.current.since = 0
      setBuffering(false)
    }

    /* 点了播放就进入"在播"语义；但**第一帧还没出来**（readyState < 3）时按缓冲处理 ——
       否则那 1 秒多里界面是"封面 + 暂停键"，用户读成"卡在暂停上"（devlog/302） */
    const onPlay = () => {
      wantPlayRef.current = true
      setPlaying(true)
      setEnded(false)                  // 又开始放了 ⇒ 尾帧那张"重新播放"必须收掉（devlog/317）
      if (el.readyState < 3) showSpin()
    }
    /* ⚠️ 暂停要把音轨一起带走（devlog/299）：暂停可能来自**画中画小窗的按钮**、
       系统媒体键、或 `navigator.mediaSession` —— 那些都不经过我们的 `toggle()`。
       不管的话：视频轨停了、音轨还在放，而每秒一次的漂移纠正发现"音轨超前 0.6s"
       就把它拽回冻结的画面时间 ⇒ **同一小段被反复重放**（用户听到的"一小段一小段重复"）。
       ⚠️ 但**我们自己为了缓冲按的那一下不算暂停**（devlog/302）：它只是"没数据，先别跑"，
       语义上还在播 —— 否则界面会在 ▶/⏸ 之间来回闪（用户看到的"播放暂停图标来回闪动"）。 */
    const onPause = () => {
      /**
       * 这一次暂停是不是**我们自己按的**（为了缓冲按住）？
       *
       * ⚠️ 判定用"多久之前按的"（800ms 窗口），**不是**"看门狗那一拍清掉的标记"（devlog/303）：
       * 浏览器的 `pause` 事件是异步派发的，晚到一拍以上完全可能；按拍清标记的写法一旦晚到，
       * 我们自己的暂停就被当成用户暂停 ⇒ 界面翻成 ▶，下一拍又翻回来 ⇒ **图标闪**。
       */
      const ours = Date.now() - holdRef.current.selfAt < 800
      audioRef.current?.pause()
      if (ours) {
        showSpin()                     // 缓冲按住 ⇒ 界面保持"在播"，只是转圈
      } else {
        wantPlayRef.current = false      // 用户/系统按的暂停 ⇒ 意图也翻掉
        setPlaying(false)
        // 用户自己按的暂停 ⇒ 取消按住，别等会儿又自己放起来
        if (holdRef.current.active) {
          holdRef.current.active = false
          holdRef.current.lastAhead = -1
        }
      }
    }
    const onPlaying = () => { endSpin(); startAudio(); probeRef.current?.noteReady() }
    /* 缓冲中要有转圈（用户口径：点进度条跳转后在加载，不能看起来像"暂停了"） */
    const onWaiting = () => {
      showSpin()
      // 诊断：这一下饿住记进窗口（"低帧率那段时间里饿了几次"是关键数字）
      probeRef.current?.noteWaiting()
      probeRef.current?.noteAhead(bufferedAhead(el))
      /**
       * ★ **画面停了，声音也必须停**（`devlog/305`，本条是"卡一帧 + 抖一阵"的真正根因）。
       *
       * 两条流是**两个独立的钟**：音轨跟声卡走（永远按真实时间前进），视频轨只能"有数据才前进"。
       * 画面一饿住，音轨照样往前跑 ⇒ 差距**只增不减**。无头 Edge 实测（把视频轨限速到略高于实时，
       * 30 秒 / 23 次 `waiting`）：
       *
       * | 口径 | A/V 漂移中位 | 最大 |
       * |---|---|---|
       * | 音轨自由跑（**本组件以前的行为**） | **4.55s** | **8.90s** |
       * | 音轨跟着画面（本条） | **0.06s** | 0.54s |
       *
       * 而漂移纠正（`devlog/298`）会在 >0.6s 时**把音轨硬拽回去** —— 每秒拽一次、每次拽回一点，
       * 用户听到的就是"**抖一阵**"；等缓冲终于追上、画面不再饿住，漂移停止增长，才"**同步**"。
       * ⇒ 之前五批都在调"什么时候允许画面跑"，**从来没管过画面停的时候声音还在跑**这件事。
       */
      audioRef.current?.pause()
      /** 饿着跑 = 一帧一帧 + 状态横跳 ⇒ **按住**，等缓冲够了再放（`HOLD_AT` 那段有实测依据）。
       *
       * ⚠️ 但有三种情况**绝对不能按**（`devlog/304`，用户报的"跳转后卡在一帧、再卡顿一阵才同步"）：
       * ① 正在 seek（`el.seeking`）—— 这一下 `waiting` 就是 seek 本身要数据，按住只会**拖住它**；
       * ② 目标位置**根本不在已缓冲区间里**（`ahead < 0`，seek 之后必然如此）——
       *    那是"要重新拉一段"，不是"播着播着饿了"，浏览器自己会继续拉；
       * ③ 已经在按住了（别重复按）。
       * 而**实测过**：一旦暂停，浏览器就**不再继续拉缓冲**（`devlog/301`：ahead 8 秒纹丝不动）
       * ⇒ 在 seek 期间按住 = 自己把加载卡死，然后靠 1.2s 死锁兜底放开 —— 表现就是
       * "卡住 → 抖一下 → 再卡住 → 过一阵才顺"。**按住只适用于"播到一半饿了"那一种。**
       */
      const ahead = bufferedAhead(el)
      if (!el.paused && !el.seeking && !holdRef.current.active
          && ahead >= 0 && ahead < HOLD_AT) {
        holdRef.current.active = true
        holdRef.current.selfAt = Date.now()      // 记下"这一下是我们按的"（窗口 800ms）
        holdRef.current.lastAhead = -1
        holdRef.current.stuck = 0
        el.pause()
      }
    }
    const onCanPlay = () => endSpin()
    /** 原生 `ended`（渐进式一定有；MSE 那边靠 `onTime` 那条兜底，见注释） */
    const onEnded = () => {
      wantPlayRef.current = false
      setPlaying(false)
      setEnded(true)
      // ⚠️ **必须把转圈收掉**（2026-10-04 用户口径）：播到最后一帧时缓冲吃完会发一次
      //    `waiting` ⇒ `showSpin()` 亮起；而 `ended` 之后不再有 `playing`/`canplay`，
      //    `endSpin()` 永远等不到 ⇒ 尾帧上**一直转圈**，还和"重新播放"叠在一起。
      killSpin()
    }
    const onTime = () => {
      /**
       * ⚠️ **等跳转落地期间不要用元素的 `currentTime` 覆盖界面**（devlog/312）：
       * MSE 的 seek 是"先取段再设时间"，这期间元素还在放**旧位置** ⇒ 每一拍 `timeupdate`
       * 都把进度条拽回旧位置、段落再跳一次，看起来就是"拖完又弹回去"。
       * 界面此刻显示的目标时间由 `seekTo` 给，落地的时刻由 `onSeekApplied` 给。
       */
      if (mseTargetRef.current == null) setCur(el.currentTime)
      /**
       * **和解**（devlog/300）：`playing` 这个 React 状态、以及"音轨到底在不在放"，
       * 都必须能**从元素本身**重新推出来，而不是只信某一次事件。
       *
       * 为什么：真机上出现过"画面在放、界面显示暂停、还没有声音" —— 事件时序里只要有一次
       * `pause` 之后没有配对的 `play`（跳转到未缓存位置、`play()` 被 abort、元素换源……
       * 都可能），状态就会**永久停在错的**那一格。`timeupdate` 播放时每秒发 4 次，
       * 拿它当和解心跳，最多 250ms 就能自愈。
       */
      // `playing` 在闭包里可能已经旧了 ⇒ 用函数式更新（值没变时 React 会跳过重渲染）。
      // ⚠️ 缓冲按住期间元素是暂停的，但**语义上仍在播** —— 不能拿 `el.paused` 直接覆盖，
      //    否则每一拍都把界面按回"暂停"（用户看到的 ▶/⏸ 闪动，devlog/302）。
      // ⚠️ **跳转期间我们也会主动暂停**（devlog/317，用户口径"先暂停、跳完再播"）——
      //    同样属于"语义上仍在播"，否则这场暂停会被和解成"用户按了暂停"，
      //    底栏图标翻成 ▶、`wantPlay` 也没了（跳完就再也不放）。
      const holding = holdRef.current.active
      const seeking = mseTargetRef.current != null || seekRef.current.settling
      const want = (holding || seeking) ? true : !el.paused
      setPlaying((prev) => (prev === want ? prev : want))
      if (!el.paused) startAudio()
      /**
       * **到尾且停着 = 播完了**（`devlog/317`）。
       *
       * 为什么不只信 `ended` 事件：① MSE 那边没有 `endOfStream()`（`devlog/314`，调了会把 seek 打死），
       * 某些实现下 `ended` 不一定发；② "位置到尾 + 没在播 + 不是我们按住的 + 没在等跳转"是**硬事实**，
       * 拿它兜底不会误报（按住/跳转两种我们自己的暂停都排除了）。
       */
      if (Number.isFinite(el.duration) && el.duration > 0
          && el.currentTime >= el.duration - 0.35 && el.paused && !el.seeking
          && !holding && mseTargetRef.current == null) {
        setEnded(true)
        killSpin()     // 同上：尾帧上不许再转圈（这一条是 MSE 侧的兜底路径）
      }
    }
    const onMeta = () => {
      setDur(el.duration || 0)
      // 内核退场时记下的位置：**必须等到这里才设**（换 `src` 的加载算法会把早设的值清掉）
      if (resumeRef.current > 0.3) {
        const t = resumeRef.current
        resumeRef.current = 0
        try { el.currentTime = t } catch { /* 元素已卸载/不支持 seek：保持从头播 */ }
      }
    }
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
    el.addEventListener('ended', onEnded)
    /* 按住的看门狗：每 200ms 看一次"缓冲够了没"，带**死锁兜底**（暂停时浏览器不会自己继续拉缓冲）。
       "这一下暂停是谁按的"由 `hold.selfAt` 的时间窗判定（见 `onPause`），不在这里清标记 ——
       曾经的"按拍清标记"写法会被**晚到的** `pause` 事件骗过去（devlog/303）。 */
    const holdWatch = window.setInterval(() => {
      const hold = holdRef.current
      if (!hold.active) return
      // seek 一旦开始就**立刻放开**：按住会把这次 seek 要的数据一起卡住（devlog/304）
      if (el.seeking) { releaseHold(); return }
      const ahead = bufferedAhead(el)
      if (ahead >= RESUME_AT) { releaseHold(); return }
      if (ahead > hold.lastAhead + 0.01) {
        hold.lastAhead = ahead
        hold.stuck = 0
      } else if ((hold.stuck += 1) * HOLD_POLL_MS > DEADLOCK_MS) {
        // 缓冲在一段时间里**一点没涨**（实测：暂停会让浏览器停下来）⇒ 别等了，放开
        releaseHold()
      }
    }, HOLD_POLL_MS)
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
      el.removeEventListener('ended', onEnded)
      window.clearInterval(holdWatch)
    }
  }, [src, dualTrack, bufferedAhead])

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
      // **真的全试过**才值得让调用方去重取地址（devlog/363）。`!src` 是"这一档压根没有地址"，
      // 那是数据问题 —— 而且这条路径下调用方早在渲染 `<VideoPlayer>` 之前就把过关了
      // （`body.video?.url` 为真才会走到这里）。
      if (dead) onAllFailed?.()
    }
  }, [dead, src, video.url, onAllFailed])

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
    wantPlayRef.current = true
    startProbe(el, 'start')          // 起播也开一个窗口（"点开详情页→播放"那条路径）
    void el.play().catch(() => { /* 自动播放策略拒绝：保持暂停，让用户再点一下 */ })
  }, [startProbe])

  /**
   * **MSE 中途栽了 ⇒ 把播放接着接回去**（`devlog/312`）。
   *
   * 为什么需要：换 `src` 会让元素重跑一遍加载算法（**回到 0 且暂停**）。对用户来说
   * "内核被悄悄换掉"是他不该看见的事 —— 一看见就是"播到一半跳回开头 / 停下来不动了"。
   * 两条流是**同一份媒体**、时间轴一致，所以位置能直接承接；位置要等 `loadedmetadata`
   * 之后再设（加载算法会把早设的值清掉，见 `onMeta`）。
   */
  useEffect(() => {
    if (useMse) { wasMseRef.current = true; return }
    if (!wasMseRef.current) return
    wasMseRef.current = false
    if (!(wantPlayRef.current || autoPlay)) return       // 用户没在播 ⇒ 别自己播起来
    const el = videoRef.current
    if (el && el.currentTime > 0.3) resumeRef.current = el.currentTime
    setCur(el?.currentTime ?? 0)
    startPlayback()
  }, [useMse, autoPlay, startPlayback])

  const toggle = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    // 判据是**意图**而不是 `el.paused`：缓冲按住期间元素是暂停的，但用户点一下应该是"暂停"，
    // 不是"再播一次"（否则点了没反应、还和治理器打架，devlog/302）
    if (wantPlayRef.current) {
      wantPlayRef.current = false
      holdRef.current.active = false     // 取消缓冲按住（用户要停就停）
      el.pause()
      audioRef.current?.pause()
    } else {
      wantPlayRef.current = true
      startPlayback()
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
  /**
   * **播放意图**（devlog/302）：用户/自动播想要的终态，而不是元素此刻的 `paused`。
   *
   * 为什么必须分开：缓冲治理会把元素 `pause()` 住（"没数据先别跑"），那时 `el.paused === true`
   * 但意图仍是"在播"。落点就是用户报的那条 —— **拖到未缓冲处后画面在动、却没有声音**：
   * 拖动开始时若元素正好在"按住"状态，`wasPlaying` 被记成 false ⇒ seek 结束后**永远不去起音轨**。
   */
  const wantPlayRef = useRef(false)

  /**
   * 收尾：视频轨到位后把音轨对齐（必要时复播），并**把视频轨自己接回去**
   * （跳转期间是我们主动 `pause` 的，见 `pauseForSeek`）。**幂等**，带兜底定时器。
   */
  const settleAudio = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    const a = audioRef.current
    let done = false
    let timer = 0
    const apply = () => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      if (a) {
        a.currentTime = el.currentTime
        /**
         * ⚠️ **画面还没真的在放就不要起音轨**（devlog/304）。
         *
         * 用户报的"卡在一帧……然后卡顿播放一会后同步"里，"过一会才同步"就是这一段造成的：
         * seek 到位时元素可能还在等数据（暂停着、画面冻住），原来这里照着"意图"就把音轨放出去了
         * ⇒ 声音先跑、画面还冻着 ⇒ 要等漂移纠正慢慢拉回来。现在只**对齐**，起播交给
         * `onPlaying → startAudio()`（那一刻画面确实在出帧）。
         */
        if (!el.paused && (seekRef.current.wasPlaying || wantPlayRef.current)) {
          void a.play().catch(() => { /* 策略拒绝：保持暂停 */ })
        }
      }
      /**
       * **视频轨也要接回去**（devlog/317）：跳转期间是我们主动 `pause` 的
       * （用户口径"先暂停，跳完再播"），不接回来就变成"跳完停在那儿"。
       * 没有独立音轨的单文件档（小红书/微博）同样走这条路。
       */
      if (el.paused && wantPlayRef.current) {
        void el.play().catch(() => { /* 策略拒绝：保持暂停，让用户再点一下 */ })
      }
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
   * **跳转期间先停住**（2026-10-04 用户口径，`devlog/317`）。
   *
   * 「点击进度条跳转的时候先暂停视频，直到跳转完成后再开始播放，现在的情况是点击跳转后
   * 依旧会接着播放原先的内容直到跳转完成后再开始播放跳转之后的内容」。
   *
   * 两道口径：
   * - **仍然按"我们在播"记**（`holdRef.selfAt`）—— 否则 `onPause` 会把这次暂停当成"用户按的"
   *   而把意图翻成暂停，跳转完成就再也起不来了（`devlog/302` 的同一个坑）；
   * - 于是界面保持"在播 + 转圈"（不是 "⏸"），跳转落地后由 `onSeekApplied`/`seeked` 接着放。
   */
  const pauseForSeek = useCallback((el: HTMLVideoElement) => {
    if (el.paused) return
    holdRef.current.selfAt = Date.now()
    holdRef.current.active = false          // 这不是"缓冲按住"，只是"跳转期间先别放"
    el.pause()
    audioRef.current?.pause()
  }, [])

  /**
   * 定位。`live=true` = 拖拽中（位置还会变）⇒ **不安排对齐**，音轨保持静默，
   * 等 `pointerup` 一次性对齐（否则每一帧都去重设一次音轨，反而更抖）。
   *
   * ## MSE 下这一步是**"取段"，不是"设时间"**（devlog/312）
   *
   * MSE 的 `currentTime` **设不到没有缓冲的地方**（浏览器会静默夹到最近的已缓冲位置）——
   * 所以 `kernel.seekTo()` 的语义是"**先把目标那一段 append 进来，再设时间**"，
   * 期间画面停在原处、转圈（`mseSeeking`）。这正是真机那个"先卡一帧再低帧率追一阵"的解药：
   * 旧内核是"设了时间，然后等浏览器猜字节位置去取"。
   *
   * ⚠️ 拖拽中（`live`）**只动界面上的时间**，抬手才真取段：一次拖拽会经过几十个段，
   * 每帧都发一次取段就是自己给自己制造拥塞（旧内核同样靠 `live` 只让浏览器跟着滚）。
   */
  const seekTo = useCallback((ratio: number, live = false) => {
    const el = videoRef.current
    if (!el) return
    const kernel = mseRef.current
    // 总时长：MSE 下段表就是真源（`loadedmetadata` 在 MSE 里来得晚，甚至先于 init append）
    const total = kernel ? kernel.duration() : el.duration
    if (!Number.isFinite(total) || total <= 0) return
    const target = Math.min(total, Math.max(0, ratio * total))
    if (kernel) {
      if (live) { setCur(target); return }
      mseTargetRef.current = target
      setMseSeeking(true)
      setEnded(false)                       // 从尾帧跳走 ⇒ 收掉"重新播放"（devlog/317）
      pauseForSeek(el)                      // ★ 跳转期间先停住（不让旧内容继续放，devlog/317）
      startProbe(el, 'seek', target)
      kernel.seekTo(target)
      setCur(target)
      return
    }
    const a = audioRef.current
    if (!seekRef.current.settling) {               // 进入一次 seek：先让音轨停下
      seekRef.current.settling = true
      seekRef.current.wasPlaying = wantPlayRef.current || !el.paused
      a?.pause()
      // 诊断窗口从**按下那一刻**开始（用户感知的"卡住"就是从这时算的）
      startProbe(el, 'seek', target)
    }
    if (!live) pauseForSeek(el)
    el.currentTime = target
    setCur(el.currentTime)
    if (!live) settleAudio()
  }, [settleAudio, startProbe, pauseForSeek])

  /**
   * 拖拽的**最后一次落点**（0–1）与"刚刚提交过"的时刻。
   *
   * ⚠️ MSE 下拖拽期间**不取段**（`seekTo(ratio, live=true)` 只动界面），所以**松手必须提交**
   * —— 而松手原来走的是 `settleAudio()`，那是双元素内核的收尾，MSE 里根本没有音轨元素，
   * 等于什么都没发生（拖完松手画面不动）。`onClick` 只兜**没有指针事件**的环境。
   */
  const dragRatioRef = useRef<number | null>(null)
  const lastCommitRef = useRef({ ratio: -1, at: 0 })

  const commitDrag = useCallback((ratio: number) => {
    lastCommitRef.current = { ratio, at: Date.now() }
    seekTo(ratio, false)
  }, [seekTo])

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

  /**
   * **重新播放**（devlog/317）：从头开始 —— 尾帧那张卡片点一下就回到 0 并接着放。
   *
   * ⚠️ MSE 下必须走 `kernel.seekTo(0)`：播到末尾时开头那几段**可能已经被淘汰**
   * （`KEEP_BEHIND=25s`），直接 `play()` 会让元素停在没有数据的 0 秒上；交给内核取第 0 段才稳。
   * 渐进式则直接写 `currentTime`（浏览器自己会取数）。
   */
  const replay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    setEnded(false)
    const kernel = mseRef.current
    if (kernel) {
      mseTargetRef.current = 0
      setMseSeeking(true)
      startProbe(el, 'replay', 0)
      kernel.seekTo(0)
    } else {
      try { el.currentTime = 0 } catch { /* 元素已卸载：交给下面的 play 自己处理 */ }
    }
    setCur(0)
    startPlayback()
  }, [startPlayback, startProbe])

  /**
   * 快进/快退 `delta` 秒（方向键）。MSE 下也必须走 `kernel.seekTo()` —— 直接写
   * `el.currentTime` 会落在没有缓冲的地方，被浏览器夹回去（"按了没反应"）。
   */
  const seekBy = useCallback((delta: number) => {
    const el = videoRef.current
    if (!el) return
    const kernel = mseRef.current
    const total = kernel ? kernel.duration() : el.duration || 0
    const target = Math.min(Math.max(0, (el.currentTime || 0) + delta), total || 0)
    setEnded(false)
    pauseForSeek(el)                     // 与点进度条同一套：跳转期间先停住（devlog/317）
    if (kernel) {
      mseTargetRef.current = target
      setMseSeeking(true)
      startProbe(el, 'seek', target)
      kernel.seekTo(target)
      setCur(target)
    } else {
      el.currentTime = target
      settleAudio()                      // 到位后把元素接回去（MSE 那边由 `onSeekApplied` 接）
    }
  }, [startProbe, pauseForSeek, settleAudio])

  /**
   * **按住右方向键 = 3× 试听**（2026-10-05 用户；`devlog/356`）。
   *
   * 用户口径（问过两问）：**按住超过 250ms ⇒ 3×，松手恢复原速**；**短按（<250ms）仍然是
   * 快进 5 秒**（右键原本就是 `seekBy(5)`，两件事共存）；显示**只在播放器里**给一枚角标，
   * 不动底栏那个倍速文字、也不改持久化的偏好。
   *
   * 三个坑（都在下面就地注释）：
   *  ① **`e.repeat`**：长按会连续发 keydown，不在第一下起表就会不停重置定时器 ⇒ 永远触发不了；
   *  ② **漂移纠正那条 interval 每 10 秒会写 `a.playbackRate = prefs.rate`** ⇒ 必须让它用
   *     `effectiveRate`，否则按住不到一秒就被拉回原速；
   *  ③ **松手可能收不到**（焦点移走 / 窗口失焦）⇒ 挂窗口级 keyup + blur 兜底，不留"卡在 3×"。
   */
  const [holdSpeed, setHoldSpeed] = useState(false)
  const holdTimer = useRef<number | null>(null)
  /** 当前**有效**倍速：按住期间是 3×，否则是用户选的 `prefs.rate` */
  const effectiveRate = holdSpeed ? HOLD_SPEED : prefs.rate
  const rateRef = useRef(effectiveRate)
  rateRef.current = effectiveRate

  const applyEffectiveRate = () => {
    const v = videoRef.current
    const a = audioRef.current
    if (v) v.playbackRate = rateRef.current
    if (a) a.playbackRate = rateRef.current
  }

  useEffect(() => {
    applyEffectiveRate()
  }, [effectiveRate, dualTrack])

  const beginHold = () => {
    if (holdTimer.current != null) return
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      setHoldSpeed(true)
    }, HOLD_TRIGGER_MS)
  }

  /** 松手：返回 `'tap'`（没到 250ms，调用方去快进）/ `'hold'`（刚结束加速） */
  const endHold = (): 'tap' | 'hold' | 'none' => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
      return 'tap'
    }
    if (holdSpeed) {
      setHoldSpeed(false)
      return 'hold'
    }
    return 'none'
  }

  /** ③ 的兜底：按住期间盯窗口的 keyup / blur（焦点跑了也要把倍速还回去） */
  useEffect(() => {
    if (!holdSpeed) return
    const stop = () => {
      if (holdTimer.current != null) {
        window.clearTimeout(holdTimer.current)
        holdTimer.current = null
      }
      setHoldSpeed(false)
    }
    const onUp = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') stop() }
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', stop)
    }
  }, [holdSpeed])

  // 快捷键：只在控件区域内接管（不抢抽屉的 Esc / 滚动）
  const onKey = (e: React.KeyboardEvent) => {
    const el = videoRef.current
    if (!el) return
    const k = e.key.toLowerCase()
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-5) }
    else if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (e.repeat) return          // ① 长按的重复事件不再重置定时器
      beginHold()
    }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPlayerPrefs({ volume: prefs.volume + 0.05, muted: false }) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setPlayerPrefs({ volume: prefs.volume - 0.05 }) }
    else if (k === 'm') { e.preventDefault(); setPlayerPrefs({ muted: !prefs.muted }) }
    else if (k === 'f') { e.preventDefault(); toggleFs() }
    // 浮层（hover 触发的那两个）—— 键盘钉住之后要能收起来（devlog/316）
    else if (k === 'escape') { qualityMenu.close(); rateMenu.close() }
  }

  /** 松手：短按补上"快进 5 秒"，长按只负责把倍速还回去（见上面 §1 的口径） */
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight') return
    e.preventDefault()
    if (endHold() === 'tap') seekBy(5)
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
      onKeyUp={onKeyUp}
      onMouseMove={(e) => {
        // 贴下边缘 = 想呼出控件（全屏时最常见）：当"钉住"处理
        nearBottomRef.current = nearBottom(e.clientY)
        bumpControls()
      }}
      /* 指针离开播放器：立刻收起；但**贴下边缘那一带豁免** —— 用户把鼠标甩到屏幕最下面
         正是想呼出控件栏，那时收起来等于跟他对着干（用户 2026-10-04 口径） */
      onMouseLeave={(e) => {
        if (controlsPinned() || nearBottom(e.clientY)) return
        setIdle(true)
      }}
    >
      <video
        ref={videoRef}
        className="vp-video"
        playsInline
        preload="metadata"
        /* ⚠️ **走 MSE 时元素上不能有 `src`**：那条流由 MediaSource 的 blob URL 提供
           （内核里 `el.src = URL.createObjectURL(ms)`）。这里给 `undefined`，React 会把属性摘掉。
           双元素模式下视频轨恒静音（声音在独立音轨上）；MSE/单文件模式下它自己出声。 */
        muted={dualTrack}
        poster={poster ? normalizeImageUrl(poster) : undefined}
        src={useMse ? undefined : src}
        onClick={toggle}
        onError={() => {
          if (useMse) {
            // 元素级错误 = 这条 MSE 路真的不行了（解码/容器）⇒ 熔断退渐进式，别在这里换源
            void api.clientLog('[video] MSE 媒体元素报错（换渐进式）').catch(() => { /* 忽略 */ })
            noteMseFailure('媒体元素报错')
            return
          }
          if (idx + 1 < sources.length) setIdx(idx + 1)   // 同档的下一面镜像（devlog/294）
          else if (onFallback) onFallback()               // 交给调用方换内核（DASH → durl）
          else setDead(true)
        }}
      />
      {/* DASH 的独立音轨（隐藏元素；音量/静音/倍速都作用在它身上）
          ⚠️ **只在渐进式内核下渲染**（devlog/312）：MSE 里音轨是同一个元素上的第二条
          SourceBuffer —— 那正是"只有一个钟"的实现方式。 */}
      {dualTrack && audioSrc && (
        <audio
          ref={audioRef}
          data-vp-audio="1"
          src={audioSrc}
          preload="metadata"
          /* ⚠️ **不要用音轨的事件去驱动界面状态**（devlog/303）。这里是 ▶/⏸ 来回闪的**真正根因**：
             我们按设计会反复暂停/恢复音轨（缓冲按住、seek 收尾、小窗暂停都会），
             每一次都会让音轨发 `pause`/`play` —— 而这两个处理器把它们当成"用户按了暂停/播放"
             ⇒ 界面跟着音轨一起翻面，节奏正好和缓冲治理同步，看起来就是图标在闪。
             **视频轨是界面状态的唯一真源**（画面才是用户看到的东西），音轨只跟着走。 */
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

      {!playing && !loading && !buffering && !mseSeeking && !ended && (
        <button type="button" className="vp-bigplay" aria-label="播放" onClick={toggle}>
          <Play className="size-7" />
        </button>
      )}

      {/* **播完了**：画面冻在尾帧，中央给一颗"重新播放"（用户口径，devlog/317）。
          与上面那颗大播放键**互斥**（`ended` 时只出这一颗），否则两颗会叠在正中间。 */}
      {ended && !loading && (
        <button type="button" className="vp-bigplay vp-replay" aria-label="重新播放" onClick={replay}>
          <RotateCcw className="size-6" aria-hidden="true" />
          <span className="vp-replay-label">重新播放</span>
        </button>
      )}

      {/* 取流中（`loading`）/ 缓冲中（`buffering`）/ **等跳转那一段落地**（`mseSeeking`）：中央转圈。
          ⚠️ 缓冲也要转（devlog/299）：点进度条跳转后视频轨要重新缓冲，画面是冻住的 ——
          不给转圈，用户会以为"点了跳转结果暂停了"。
          ⚠️ MSE 的跳转**必须有转圈**（devlog/312）：那时画面**故意**停着等目标段
          （不是"暂停"，用户没按过暂停键），没有转圈就是"点了跳转没反应"。
          ⚠️ **播完了就不许再转**（devlog/318，用户口径「用重新播放的按钮替代转圈缓冲按钮」）：
          `ended` 时只出"重新播放"，两个都画在正中间会叠。 */}
      {(loading || buffering || mseSeeking) && !ended && (
        <div className="vp-spin" role="status" aria-label="正在缓冲">
          <Loader2 className="vp-spin-icon" aria-hidden="true" />
        </div>
      )}

      {/* 按住右方向键的**倍速角标**（2026-10-05 用户口径）：只在播放器里给这一枚，
          底栏那个倍速文字与 `playerPrefs` 都**不动**（"状态行不需要收到这些消息"）。
          `data-hold-rate` 是给探针/用例的抓手（量"按住时有没有真加速 + 有没有显示"）。 */}
      {holdSpeed && (
        <span className="vp-hold-rate" data-hold-rate={HOLD_SPEED}>
          {HOLD_SPEED}×
        </span>
      )}

      {/* 底栏：指针压在上面时**永不收起**（用户口径的另一半），离开后重新开始计时 */}
      <div
        className="vp-bar"
        onMouseEnter={() => { hoverBarRef.current = true; setIdle(false); window.clearTimeout(idleTimer.current) }}
        onMouseLeave={() => { hoverBarRef.current = false; bumpControls() }}
      >
        <button type="button" className="vp-btn" aria-label={playing ? '暂停' : '播放'} onClick={toggle}>
          {/* 在播 + 缓冲 ⇒ 按键位置显示转圈（不是 ⏸ 也不是 ▶）：
              成熟播放器都这么表示"没停，只是在等数据"，也让图标不再来回闪（devlog/302） */}
          {playing && (buffering || mseSeeking)
            ? <Loader2 className="vp-btn-spin" aria-hidden="true" />
            : playing ? <Pause className="size-4" /> : <Play className="size-4" />}
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
            const ratio = (e.clientX - r.left) / r.width
            // ⚠️ 指针事件那一路已经在 `pointerup` 提交过了（同一次点击会再发一个 click）——
            //    重复提交会把刚起的转圈/攒缓冲打断一次，所以同位置 400ms 内不重复提交
            const last = lastCommitRef.current
            if (Math.abs(last.ratio - ratio) < 0.01 && Date.now() - last.at < 400) return
            seekTo(ratio)
          }}
          onPointerDown={(e) => {
            // 拖拽 seek（devlog/286）：按下即定位 + 捕获指针，拖动中持续跟随
            e.preventDefault()
            // ⚠️ `setPointerCapture` 对**已经释放/无效的 pointerId 会抛** `NotFoundError`
            //    （真机上偶发：快速点两下进度条）—— 捕获失败只是"拖出元素外会丢事件"，
            //    不该把整个 seek 打断，所以吞掉。
            try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* 见上 */ }
            const r = e.currentTarget.getBoundingClientRect()
            const ratio = (e.clientX - r.left) / r.width
            setDragging(true)
            draggingRef.current = true
            dragRatioRef.current = ratio
            seekTo(ratio, true)              // live：MSE 只动界面；双元素则音轨先静默
          }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
            // hover 预览：光标位置对应的时间（图二那颗 `00:12` 气泡）
            setHover({ x: ratio * r.width, t: ratio * (dur || 0) })
            // ⚠️ 判据用 **ref**（`draggingRef`）而不是 state：同一次按下里派发的头几个
            //    `pointermove` 看到的 `dragging` 还是 false（React 状态要等一拍）
            //    ⇒ 那几个位置被丢掉，松手时提交的是**旧的**落点（devlog/313 的用例抓到）。
            if (draggingRef.current) {
              dragRatioRef.current = ratio
              seekTo(ratio, true)
            }
          }}
          onPointerUp={(e) => {
            try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* 没捕获过 */ }
            setDragging(false)
            draggingRef.current = false
            const ratio = dragRatioRef.current
            dragRatioRef.current = null
            // MSE：松手才**真去取那一段**（拖拽期间只动界面）；双元素：等视频轨到位后对齐音轨
            if (mseRef.current && ratio != null) commitDrag(ratio)
            else settleAudio()
          }}
          onPointerCancel={() => {
            setDragging(false)
            draggingRef.current = false
            const ratio = dragRatioRef.current
            dragRatioRef.current = null
            if (mseRef.current && ratio != null) commitDrag(ratio)
            else settleAudio()
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
          {/* 分P（`devlog/329`）：只在**真的多P**时出现（单P视频多一个按钮纯属噪音）。
              放在清晰度左边：它决定"播哪一段"，比清晰度更靠前 */}
          {pages && pages.length > 1 && (
            <div className="vp-rate" data-vp-menu="page"
                 onMouseEnter={pageMenu.enter} onMouseLeave={pageMenu.leave}>
              <button type="button" className="vp-btn vp-btn--text"
                      aria-label="分P" aria-haspopup="true" aria-expanded={pageMenu.open}
                      onClick={pageMenu.toggle}>
                P{currentPage ?? 1}
              </button>
              {pageMenu.open && (
                <div className="vp-menu vp-menu--page">
                  {pages.map((p) => (
                    <button key={p.cid} type="button"
                            className={`vp-menu-item${p.page === (currentPage ?? 1) ? ' is-on' : ''}`}
                            title={p.part}
                            onClick={() => {
                              pageMenu.close()
                              if (p.page !== (currentPage ?? 1)) onPickPage?.(p.cid)
                            }}>
                      {/* 同一行「P1 标题」（用户口径）：整段包一层 span —— 菜单**固定 7 字宽**，
                          超出部分由 CSS 在 hover 时横向滚动（`vp-page-scroll`），
                          ⚠️ 裁切必须落在这层 span 上：给 grid 项自己加 `overflow: hidden` 会让它的
                          min-content 变成 0 ⇒ 自动轨道塌成按钮那么宽、标题被裁光（2026-10-04 的真机截图） */}
                      <span className="vp-page-label">P{p.page} {p.part}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {qualities && qualities.length > 0 && (
            /* 清晰度这一组**自己**是 hover 区（不能挂在外面那个 `.vp-rate` 上：
               那样指针划过倍速也会把清晰度菜单带出来）—— devlog/316 */
            <div className="vp-rate" data-vp-menu="quality"
                 onMouseEnter={qualityMenu.enter} onMouseLeave={qualityMenu.leave}>
              <button type="button" className="vp-btn vp-btn--text"
                      aria-label="清晰度" aria-haspopup="true" aria-expanded={qualityMenu.open}
                      onClick={qualityMenu.toggle}>
                {qualities.find((q) => q.id === qualityId)?.label ?? '清晰度'}
              </button>
              {qualityMenu.open && (
                <div className="vp-menu vp-menu--quality">
                  {/* 自动降档**要说出来**（devlog/328）：菜单里一行，不弹窗 ——
                      用户看到画质掉了得知道为什么，也知道可以自己点回原档 */}
                  {autoNote && <div className="vp-menu-note" data-vp-autonote="1">{autoNote}</div>}
                  {qualities.map((q) => (
                    <button key={q.id} type="button" disabled={q.disabled}
                            title={q.note}
                            /* 档位名（含"高清 1080P"里那个空格）**不许换行**（用户 2026-10-03）：
                               一换行菜单就变成窄高条，"1×"也会被挤下去 */
                            aria-label={q.note ? `${q.label}（${q.note}，不可选）` : q.label}
                            className={`vp-menu-item${q.id === qualityId ? ' is-on' : ''}`}
                            onClick={() => {
                              // 用户自己选档 ⇒ 那条"已自动降档"的说明就该消失（情况变了）
                              setAutoNote(null)
                              onPickQuality?.(q.id)
                              qualityMenu.close()
                            }}>
                      {q.label}
                      {/* 「需大会员」用**一颗小图标**表示（文字太占宽、又把行撑换行了）；
                          无障碍名走 `title` + `aria-label`，信息不丢 */}
                      {q.note && <VipBadge note={q.note} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* 倍速这一组同理：按钮 + 菜单包在**同一个** hover 区里，指针移进菜单不会断 */}
          <div className="vp-rate" data-vp-menu="rate"
               onMouseEnter={rateMenu.enter} onMouseLeave={rateMenu.leave}>
            <button type="button" className="vp-btn vp-btn--text"
                    aria-label="倍速" aria-haspopup="true" aria-expanded={rateMenu.open}
                    onClick={rateMenu.toggle}>
              {prefs.rate}×
            </button>
            {rateMenu.open && (
              <div className="vp-menu">
                {PLAYBACK_RATES.map((r) => (
                  <button key={r} type="button"
                          className={`vp-menu-item${r === prefs.rate ? ' is-on' : ''}`}
                          onClick={() => { setPlayerPrefs({ rate: r }); rateMenu.close() }}>
                    {r}×
                  </button>
                ))}
              </div>
            )}
          </div>
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
